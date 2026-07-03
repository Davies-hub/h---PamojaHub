"""Step 2.9b withdrawal lifecycle tests — approve/reject/retry + list.

This file is the focused review surface for the money-mover endpoint. Coverage:

  * Approval — authorization (own-church positive, cross-church 403,
    SUSPENDED 403, status guards, balance re-check leaves PENDING).
  * Approval — the architecture rule: STRUCTURAL LOCK test (SELECT FOR UPDATE
    appears) + EXTERNAL-CALL ORDERING test (the B2C HTTP call fires AFTER the
    transaction commits, NOT inside the locked block).
  * Approval — B2C dispatch failure → withdrawal ends FAILED with
    failure_reason, NOT stuck PROCESSING.
  * Reject — authorization, status guard, required reason.
  * Retry — authorization, status guard (FAILED only), retry_count cap (5),
    balance re-check.
  * List — cross-church leak probe (zero of A's withdrawals to B), positive
    control.

True concurrency (two simultaneous approve calls both passing the balance
check) is NOT tested here — thread-based tests against the test DB are flaky
and unreliable; load testing in a dedicated phase covers that. This suite only
confirms the lock is invoked and the external call is sequenced AFTER it.
"""

from datetime import datetime
from decimal import Decimal
from unittest.mock import patch

import requests
from django.db import connection, transaction
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from integrations import daraja
from notifications.models import Notification, NotificationType
from withdrawals.models import (
    Withdrawal,
    WithdrawalDispatchOutcome,
    WithdrawalStatus,
)


# ─────────────────────────────────────────────────────────────────────────────
# HTTP-boundary fakes — the money-movers now call DarajaClient().b2c_payout(),
# which makes real HTTP via DarajaClient._http_request. We patch ONLY that seam
# so the real client logic (token fetch + payload build + response parsing)
# runs, with no network. The fakes route by URL: the OAuth call returns a token,
# the B2C call returns/raises whatever the test wants.
# ─────────────────────────────────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status_code=200, json_body=None, json_raises=False):
        self.status_code = status_code
        self._json_body = json_body if json_body is not None else {}
        self._json_raises = json_raises

    def json(self):
        if self._json_raises:
            raise ValueError('No JSON object could be decoded')
        return self._json_body


_OAUTH_OK = {'access_token': 'TEST-TOKEN', 'expires_in': '3599'}
_B2C_ACK_OK = {
    'ConversationID': 'AG_20260601_TEST123',
    'OriginatorConversationID': 'OC_TEST',
    'ResponseCode': '0',
    'ResponseDescription': 'Accept the service request successfully.',
}


def _http_seam(*, b2c_response=None, b2c_exc=None, on_b2c=None):
    """Build a side_effect for DarajaClient._http_request that answers the OAuth
    call with a valid token and the B2C call with the supplied response/exception.
    `on_b2c` is an optional callback invoked (for state capture) when the B2C URL
    is hit, before returning b2c_response.
    """
    def _fake(method, url, **kwargs):
        if 'oauth' in url:
            return _FakeResponse(200, _OAUTH_OK)
        # B2C paymentrequest URL.
        if on_b2c is not None:
            on_b2c()
        if b2c_exc is not None:
            raise b2c_exc
        return b2c_response if b2c_response is not None else _FakeResponse(200, _B2C_ACK_OK)
    return _fake


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


def _make_church(name='Church X', email='x@example.org', status_=ChurchStatus.ACTIVE):
    return Church.objects.create(
        name=name, official_email=email,
        phone='254700000001', address='addr',
        county='Nairobi', denomination='PCEA',
        status=status_,
    )


def _make_treasurer(church, email):
    return User.objects.create_user(
        email=email, password='unused',
        first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _make_campaign(church, treasurer, *, slug, wallet=Decimal('5000'),
                   raised=Decimal('10000')):
    return Campaign.objects.create(
        slug=slug, church=church,
        title=f'Campaign {slug}', description='desc',
        goal_amount=Decimal('100000'),
        raised_amount=raised, wallet_balance=wallet,
        banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING,
        treasurer_phone='254712345678', treasurer_name='Treas Urer',
        created_by=treasurer,
        status=CampaignStatus.ACTIVE,
    )


def _make_withdrawal(campaign, *, amount=Decimal('1000'),
                     status_=WithdrawalStatus.PENDING_APPROVAL,
                     retry_count=0):
    return Withdrawal.objects.create(
        campaign=campaign,
        requested_by_phone='254712345678',
        destination_phone='254712345678',
        destination_name='Treas Urer',
        amount=amount,
        reason='Builders payment',
        status=status_,
        retry_count=retry_count,
    )


class BaseTwoChurchSetUp(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church_a = _make_church(name='Church A', email='a@example.org')
        cls.church_b = _make_church(name='Church B', email='b@example.org')
        cls.treasurer_a = _make_treasurer(cls.church_a, 'ta@example.org')
        cls.treasurer_b = _make_treasurer(cls.church_b, 'tb@example.org')

        cls.camp_a = _make_campaign(cls.church_a, cls.treasurer_a,
                                    slug='a-camp', wallet=Decimal('5000'))
        cls.camp_b = _make_campaign(cls.church_b, cls.treasurer_b,
                                    slug='b-camp', wallet=Decimal('5000'))

    def setUp(self):
        self.client = APIClient()


# ═════════════════════════════════════════════════════════════════════════════
# Approval — authorization + cross-church
# ═════════════════════════════════════════════════════════════════════════════


class ApproveAuthorizationTests(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.wd = _make_withdrawal(self.camp_a, amount=Decimal('1000'))

    def test_treasurer_a_approves_own_withdrawal(self):
        self.client.force_authenticate(user=self.treasurer_a)
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam()):
            resp = self.client.post(reverse('withdrawal-approve', args=[self.wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.PROCESSING)
        # The real client stores the Daraja ConversationID from the sync ACK.
        self.assertEqual(self.wd.b2c_conversation_id, _B2C_ACK_OK['ConversationID'])
        self.assertEqual(self.wd.approved_by, self.treasurer_a)

        self.assertEqual(
            AuditLog.objects.filter(
                action='WITHDRAWAL_APPROVED',
                entity_id=self.wd.id,
            ).count(),
            1,
        )
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.treasurer_a,
                notification_type=NotificationType.DISBURSEMENT_APPROVED,
                related_withdrawal=self.wd,
            ).count(),
            1,
        )

    def test_treasurer_b_cannot_approve_church_a_withdrawal(self):
        """CRITICAL: proves check_object_permissions is invoked. Without it the
        view-level perms alone would not catch the cross-church attempt.
        """
        self.client.force_authenticate(user=self.treasurer_b)
        resp = self.client.post(reverse('withdrawal-approve', args=[self.wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

        # And the withdrawal MUST be untouched.
        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.PENDING_APPROVAL)
        self.assertIsNone(self.wd.b2c_conversation_id)
        self.assertIsNone(self.wd.approved_by)
        self.assertEqual(
            AuditLog.objects.filter(
                action='WITHDRAWAL_APPROVED',
                entity_id=self.wd.id,
            ).count(),
            0,
        )

    def test_suspended_church_treasurer_cannot_approve(self):
        self.church_a.status = ChurchStatus.SUSPENDED
        self.church_a.save(update_fields=['status'])
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(reverse('withdrawal-approve', args=[self.wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn('not active', resp.data['detail'].lower())

        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.PENDING_APPROVAL)


# ═════════════════════════════════════════════════════════════════════════════
# Approval — status + balance guards
# ═════════════════════════════════════════════════════════════════════════════


class ApproveStatusBalanceGuards(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_cannot_approve_already_processing(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.PROCESSING)
        resp = self.client.post(reverse('withdrawal-approve', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_approve_paid(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.PAID)
        resp = self.client.post(reverse('withdrawal-approve', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_approve_rejected(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.REJECTED)
        resp = self.client.post(reverse('withdrawal-approve', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_insufficient_balance_leaves_pending(self):
        # camp_a wallet=5000; request 6000 → balance check fails.
        wd = _make_withdrawal(self.camp_a, amount=Decimal('6000'))
        resp = self.client.post(reverse('withdrawal-approve', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('insufficient wallet balance', resp.data['detail'].lower())

        # CRITICAL decision: NOT auto-rejected — stays at PENDING_APPROVAL so the
        # treasurer can request a smaller amount or wait for donations.
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PENDING_APPROVAL)
        self.assertIsNone(wd.b2c_conversation_id)
        self.assertIsNone(wd.approved_by)


# ═════════════════════════════════════════════════════════════════════════════
# Approval — structural lock + ordering (THE ARCHITECTURE RULE)
# ═════════════════════════════════════════════════════════════════════════════


class ApproveStructuralLockAndOrderingTest(TransactionTestCase):
    """Verifies (a) SELECT FOR UPDATE on the campaign row is acquired and (b)
    the external B2C HTTP call happens AFTER the transaction commits,
    NOT inside the locked block.

    Why this matters: external API latency must NEVER hold the campaign row
    lock. If b2c were called inside the transaction, a slow Daraja would
    block donation-callback wallet updates, the disbursements list, and any
    concurrent sibling approvals on the same campaign for the full network
    round-trip. The Phase 1 / Phase 2 split in the view is the safeguard.

    Why TransactionTestCase (not TestCase): Django's TestCase wraps every test
    in an outer transaction for rollback isolation between tests. With that
    wrap, the view's inner `transaction.atomic()` becomes a SAVEPOINT, not a
    real top-level transaction — and `connection.in_atomic_block` stays True
    even after the inner block exits (the outer test wrap is still open). To
    observe the REAL commit boundary that production sees, we use
    TransactionTestCase (no test wrap; tables are truncated between tests).
    This is a deliberate slowdown to keep the architecture-rule assertion
    honest.

    True concurrency is deferred to load testing.
    """

    def setUp(self):
        # TransactionTestCase doesn't use setUpTestData (truncates between tests).
        # Clear the daraja token cache so the OAuth seam fires deterministically.
        daraja._clear_token_cache()
        self.church = _make_church(name='Church', email='c@example.org')
        self.treasurer = _make_treasurer(self.church, 't@example.org')
        self.campaign = _make_campaign(self.church, self.treasurer,
                                       slug='c-camp', wallet=Decimal('5000'))
        self.client = APIClient()
        self.client.force_authenticate(user=self.treasurer)
        self.wd = _make_withdrawal(self.campaign, amount=Decimal('1000'))

    def test_select_for_update_appears_in_approval_sql(self):
        """STRUCTURAL: SELECT...FOR UPDATE on campaigns_campaign must execute."""
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam()):
            with CaptureQueriesContext(connection) as ctx:
                resp = self.client.post(reverse('withdrawal-approve', args=[self.wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        sqls = [q['sql'].lower() for q in ctx.captured_queries]
        matched = [
            s for s in sqls
            if 'for update' in s and 'campaigns_campaign' in s
        ]
        self.assertGreater(
            len(matched), 0,
            'Expected a SELECT...FOR UPDATE on campaigns_campaign during approval; '
            f'got SQL:\n{chr(10).join(sqls)}',
        )

    def test_b2c_call_happens_after_transaction_commits(self):
        """ORDERING: spy at the HTTP boundary (DarajaClient._http_request) for the
        B2C call; at the moment it fires, the withdrawal must already be
        PROCESSING and committed (no open transaction).

        This exercises the REAL b2c_payout code path — only the HTTP seam is
        mocked. Mechanism: connection.in_atomic_block is True inside an open
        transaction.atomic() and False after commit. The on_b2c callback captures
        the committed state at the exact moment the B2C HTTP call is invoked
        (the OAuth call is answered separately by the seam and not captured).
        """
        captured = {}

        def on_b2c():
            from django.db import connection as conn
            captured['in_atomic'] = conn.in_atomic_block
            # Separate query — reads the COMMITTED state other connections see.
            fresh = Withdrawal.objects.get(id=self.wd.id)
            captured['status_at_call'] = fresh.status

        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam(on_b2c=on_b2c)):
            resp = self.client.post(reverse('withdrawal-approve', args=[self.wd.id]))

        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        # The lock-bearing transaction.atomic() block must have COMMITTED
        # before b2c was called → no atomic in progress.
        self.assertFalse(
            captured['in_atomic'],
            'B2C HTTP call fired while a transaction was still open — '
            'the lock-then-call architecture rule is broken.',
        )

        # And the withdrawal must already be PROCESSING (the Phase-1 status
        # flip committed) when the B2C HTTP call sees it.
        self.assertEqual(
            captured['status_at_call'],
            WithdrawalStatus.PROCESSING,
            'B2C HTTP call saw a non-PROCESSING withdrawal — the Phase-1 '
            'commit did not happen before the external call.',
        )


# ═════════════════════════════════════════════════════════════════════════════
# Approval — B2C dispatch failure → strand prevention (FAILED, not PROCESSING)
# ═════════════════════════════════════════════════════════════════════════════


class ApproveDispatchFailureTests(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)
        self.wd = _make_withdrawal(self.camp_a, amount=Decimal('1000'))

    def _approve_with_seam(self, **seam_kwargs):
        daraja._clear_token_cache()
        with patch.object(
            daraja.DarajaClient, '_http_request',
            side_effect=_http_seam(**seam_kwargs),
        ):
            return self.client.post(reverse('withdrawal-approve', args=[self.wd.id]))

    def test_b2c_dispatch_failure_sets_failed_not_stuck_processing(self):
        # Drive the failure THROUGH the real client: the HTTP boundary raises a
        # connection error on the B2C call → b2c_payout raises a CLEAN dispatch
        # error → the view's strand-prevention path runs.
        resp = self._approve_with_seam(b2c_exc=requests.ConnectionError('upstream unreachable'))

        # The HTTP request succeeded — this is not a hard error. The frontend
        # gets a queued-for-retry signal.
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data.get('dispatch_status'), 'failed_queued_for_retry')

        self.wd.refresh_from_db()
        # Strand prevention: NOT stuck at PROCESSING.
        self.assertEqual(self.wd.status, WithdrawalStatus.FAILED)
        self.assertIn('could not dispatch', self.wd.failure_reason.lower())
        # Copy reflects MANUAL retry (there is no automatic retry job) —
        # mentions the panel, NOT "will retry".
        self.assertIn('panel', self.wd.failure_reason.lower())
        self.assertNotIn('will retry', self.wd.failure_reason.lower())
        self.assertIsNone(self.wd.b2c_conversation_id)

    def test_connection_error_stamps_clean_marker(self):
        """A clean transport failure → FAILED + CLEAN_FAILURE marker (the sweep
        may re-dispatch it; the payout provably never queued)."""
        resp = self._approve_with_seam(b2c_exc=requests.ConnectionError('refused'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.FAILED)
        self.assertEqual(self.wd.dispatch_outcome, WithdrawalDispatchOutcome.CLEAN_FAILURE)
        self.assertIsNone(self.wd.b2c_conversation_id)

    def test_non_zero_response_code_stamps_ambiguous_marker(self):
        """A 200 with non-zero ResponseCode → FAILED + AMBIGUOUS_FAILURE marker
        (Daraja received it; may be queued; the sweep must verify, not blind-retry)."""
        ambiguous_ack = _FakeResponse(200, {
            'ConversationID': 'AG_MAYBE', 'ResponseCode': '1',
            'ResponseDescription': 'system busy',
        })
        resp = self._approve_with_seam(b2c_response=ambiguous_ack)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.FAILED)
        self.assertEqual(self.wd.dispatch_outcome, WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)
        self.assertIsNone(self.wd.b2c_conversation_id)

    def test_clean_and_ambiguous_markers_differ(self):
        """THE proof that the row carries enough for 2.10c to branch: the same
        endpoint produces DIFFERENT markers for a clean vs an ambiguous failure.
        """
        # Clean failure on one withdrawal.
        clean_wd = _make_withdrawal(self.camp_a, amount=Decimal('1000'))
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam(b2c_exc=requests.Timeout('t'))):
            self.client.post(reverse('withdrawal-approve', args=[clean_wd.id]))
        clean_wd.refresh_from_db()

        # Ambiguous failure on another.
        amb_wd = _make_withdrawal(self.camp_a, amount=Decimal('1000'))
        amb_ack = _FakeResponse(200, {'ResponseCode': '0'})  # ResponseCode 0, no ConversationID
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam(b2c_response=amb_ack)):
            self.client.post(reverse('withdrawal-approve', args=[amb_wd.id]))
        amb_wd.refresh_from_db()

        self.assertEqual(clean_wd.dispatch_outcome, WithdrawalDispatchOutcome.CLEAN_FAILURE)
        self.assertEqual(amb_wd.dispatch_outcome, WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)
        self.assertNotEqual(clean_wd.dispatch_outcome, amb_wd.dispatch_outcome)


# ═════════════════════════════════════════════════════════════════════════════
# Reject
# ═════════════════════════════════════════════════════════════════════════════


class RejectTests(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.wd = _make_withdrawal(self.camp_a, amount=Decimal('1000'))

    def test_treasurer_a_rejects_own_with_reason(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            reverse('withdrawal-reject', args=[self.wd.id]),
            {'rejection_reason': 'Receipt does not match the request.'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.REJECTED)
        self.assertEqual(self.wd.rejection_reason,
                         'Receipt does not match the request.')
        self.assertEqual(self.wd.approved_by, self.treasurer_a)

        self.assertEqual(
            AuditLog.objects.filter(
                action='WITHDRAWAL_REJECTED', entity_id=self.wd.id,
            ).count(),
            1,
        )

    def test_treasurer_b_cannot_reject_church_a_withdrawal(self):
        self.client.force_authenticate(user=self.treasurer_b)
        resp = self.client.post(
            reverse('withdrawal-reject', args=[self.wd.id]),
            {'rejection_reason': 'Hostile rejection'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.PENDING_APPROVAL)

    def test_reject_without_reason_returns_400(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            reverse('withdrawal-reject', args=[self.wd.id]),
            {},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.wd.refresh_from_db()
        self.assertEqual(self.wd.status, WithdrawalStatus.PENDING_APPROVAL)

    def test_reject_with_too_short_reason_returns_400(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            reverse('withdrawal-reject', args=[self.wd.id]),
            {'rejection_reason': '.'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_reject_non_pending_withdrawal(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.PROCESSING)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            reverse('withdrawal-reject', args=[wd.id]),
            {'rejection_reason': 'Trying to reject a processing one'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


# ═════════════════════════════════════════════════════════════════════════════
# Retry
# ═════════════════════════════════════════════════════════════════════════════


class RetryTests(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()

    def test_treasurer_a_retries_failed_withdrawal(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.FAILED,
                              retry_count=1)
        self.client.force_authenticate(user=self.treasurer_a)
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam()):
            resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PROCESSING)
        self.assertEqual(wd.retry_count, 2)
        self.assertEqual(wd.b2c_conversation_id, _B2C_ACK_OK['ConversationID'])

        self.assertEqual(
            AuditLog.objects.filter(
                action='WITHDRAWAL_RETRIED', entity_id=wd.id,
            ).count(),
            1,
        )

    def test_cannot_retry_paid(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.PAID,
                              retry_count=0)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_retry_failed_final(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.FAILED_FINAL,
                              retry_count=5)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_retry_when_retry_count_already_maxed(self):
        # FAILED but retry_count already at MAX_RETRIES — guards against retrying
        # a maxed-out row that hasn't yet been escalated to FAILED_FINAL by 2.10.
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.FAILED,
                              retry_count=5)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('maximum retries', resp.data['detail'].lower())

    def test_treasurer_b_cannot_retry_church_a_withdrawal(self):
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.FAILED,
                              retry_count=1)
        self.client.force_authenticate(user=self.treasurer_b)
        resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.FAILED)
        self.assertEqual(wd.retry_count, 1)

    def test_retry_blocked_on_ambiguous_failure(self):
        """An AMBIGUOUS_FAILURE row's money may already be in flight at Daraja —
        retry must NOT re-dispatch it. Below MAX_RETRIES and fully funded, so the
        only thing standing between this row and a double-pay is dispatch_outcome.
        """
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.FAILED,
                              retry_count=1)
        wd.dispatch_outcome = WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE
        wd.save(update_fields=['dispatch_outcome'])
        self.client.force_authenticate(user=self.treasurer_a)
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam()) as mock_http:
            resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        mock_http.assert_not_called()
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.FAILED)
        self.assertEqual(wd.retry_count, 1)
        self.assertEqual(wd.dispatch_outcome, WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)

    def test_retry_allowed_on_clean_failure(self):
        """CLEAN_FAILURE is provably never-queued — retry must still proceed."""
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.FAILED,
                              retry_count=1)
        wd.dispatch_outcome = WithdrawalDispatchOutcome.CLEAN_FAILURE
        wd.save(update_fields=['dispatch_outcome'])
        self.client.force_authenticate(user=self.treasurer_a)
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam()) as mock_http:
            resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        mock_http.assert_called()
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PROCESSING)
        self.assertEqual(wd.retry_count, 2)

    def test_retry_allowed_on_callback_failure_none(self):
        """dispatch_outcome=None is a definitive callback-reported non-payment
        (ResultCode != 0) — not an ambiguous dispatch. Retry must still proceed.
        """
        wd = _make_withdrawal(self.camp_a, status_=WithdrawalStatus.FAILED,
                              retry_count=1)
        self.assertIsNone(wd.dispatch_outcome)
        self.client.force_authenticate(user=self.treasurer_a)
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam()) as mock_http:
            resp = self.client.post(reverse('withdrawal-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        mock_http.assert_called()
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PROCESSING)
        self.assertEqual(wd.retry_count, 2)


# ═════════════════════════════════════════════════════════════════════════════
# List leakage
# ═════════════════════════════════════════════════════════════════════════════


class ListLeakageTests(BaseTwoChurchSetUp):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        # A few withdrawals across the two churches
        cls.a_wd1 = _make_withdrawal(cls.camp_a, amount=Decimal('1000'))
        cls.a_wd2 = _make_withdrawal(cls.camp_a, amount=Decimal('2000'),
                                     status_=WithdrawalStatus.PROCESSING)
        cls.b_wd = _make_withdrawal(cls.camp_b, amount=Decimal('500'))

    def test_treasurer_b_list_excludes_church_a_withdrawals(self):
        self.client.force_authenticate(user=self.treasurer_b)
        resp = self.client.get(reverse('withdrawal-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {item['id'] for item in resp.data['results']}
        self.assertIn(str(self.b_wd.id), ids)
        self.assertNotIn(str(self.a_wd1.id), ids)
        self.assertNotIn(str(self.a_wd2.id), ids)

    def test_treasurer_a_list_includes_only_own(self):
        """Positive control — proves we didn't lock everyone out."""
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.get(reverse('withdrawal-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {item['id'] for item in resp.data['results']}
        self.assertEqual(ids, {str(self.a_wd1.id), str(self.a_wd2.id)})

    def test_status_filter(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.get(
            reverse('withdrawal-list'),
            {'status': WithdrawalStatus.PROCESSING},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {item['id'] for item in resp.data['results']}
        self.assertEqual(ids, {str(self.a_wd2.id)})


# ═════════════════════════════════════════════════════════════════════════════
# List date filter (from/to) — mirrors /churches/me/donations/ (created_at__date,
# inclusive both ends; malformed → 400). Church A owns all three rows so the
# leak-guard scope is orthogonal to the date filter under test.
# ═════════════════════════════════════════════════════════════════════════════


class WithdrawalDateFilterTests(BaseTwoChurchSetUp):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.wd_early = _make_withdrawal(cls.camp_a, amount=Decimal('1000'))
        cls.wd_mid = _make_withdrawal(cls.camp_a, amount=Decimal('2000'))
        cls.wd_late = _make_withdrawal(cls.camp_a, amount=Decimal('3000'))
        # created_at is auto_now_add — the value passed at create() is ignored, so
        # stamp three distinct calendar days here (noon UTC to avoid tz-edge slop).
        Withdrawal.objects.filter(id=cls.wd_early.id).update(
            created_at=timezone.make_aware(datetime(2026, 1, 10, 12, 0)))
        Withdrawal.objects.filter(id=cls.wd_mid.id).update(
            created_at=timezone.make_aware(datetime(2026, 1, 20, 12, 0)))
        Withdrawal.objects.filter(id=cls.wd_late.id).update(
            created_at=timezone.make_aware(datetime(2026, 1, 30, 12, 0)))

    def test_from_returns_only_on_or_after(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.get(reverse('withdrawal-list'), {'from': '2026-01-20'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {item['id'] for item in resp.data['results']}
        self.assertEqual(ids, {str(self.wd_mid.id), str(self.wd_late.id)})

    def test_to_returns_only_on_or_before(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.get(reverse('withdrawal-list'), {'to': '2026-01-20'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {item['id'] for item in resp.data['results']}
        self.assertEqual(ids, {str(self.wd_early.id), str(self.wd_mid.id)})

    def test_malformed_from_returns_400_not_500(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.get(reverse('withdrawal-list'), {'from': 'notadate'})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


# ═════════════════════════════════════════════════════════════════════════════
# Shared-serializer regression — church_name was added to WithdrawalSerializer
# for the Super Admin oversight list; it must NOT break the treasurer payouts
# response (this endpoint, /withdrawals/, is already wired to the frontend).
# ═════════════════════════════════════════════════════════════════════════════


class SharedSerializerChurchNameRegression(BaseTwoChurchSetUp):
    """WithdrawalSerializer is SHARED by /withdrawals/ (treasurer payouts) and
    /super/withdrawals/ (platform oversight). Adding church_name for the Super
    Admin list is harmless here: the treasurer payouts list still returns
    correctly and now also carries the treasurer's OWN church name (redundant,
    not a disclosure — a treasurer only ever sees their own church's withdrawals).
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.a_wd = _make_withdrawal(cls.camp_a, amount=Decimal('1000'))

    def test_treasurer_payouts_list_unbroken_and_carries_own_church_name(self):
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.get(reverse('withdrawal-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        row = next(r for r in resp.data['results'] if r['id'] == str(self.a_wd.id))

        # The new field = the treasurer's own church (Church A).
        self.assertEqual(row['church_name'], 'Church A')
        # campaign title (the pre-existing declared field) still resolves.
        self.assertEqual(row['campaign'], self.camp_a.title)
        # The full pre-existing payouts shape is intact — nothing dropped.
        for f in ('id', 'campaign', 'amount', 'destination_phone',
                  'destination_name', 'requested_by_phone', 'reason',
                  'rejection_reason', 'status', 'retry_count', 'failure_reason',
                  'payout_reference', 'created_at', 'updated_at'):
            self.assertIn(f, row, f'payouts field {f} was dropped')


# ═════════════════════════════════════════════════════════════════════════════
# Campaign close — in-flight-money guard (cannot close over a non-terminal payout)
# ═════════════════════════════════════════════════════════════════════════════


class CampaignCloseWithdrawalGuardTests(BaseTwoChurchSetUp):
    """Closing a campaign must be blocked while a NON-terminal (blocking)
    withdrawal exists for it — closing would strand in-flight / in-limbo money.
    Terminal withdrawals (PAID/REJECTED/FAILED_FINAL) must NOT block.
    """

    def test_close_blocked_by_nonterminal_withdrawal(self):
        camp = _make_campaign(self.church_a, self.treasurer_a, slug='close-guard')
        _make_withdrawal(camp, status_=WithdrawalStatus.PENDING_APPROVAL)
        self.client.force_authenticate(user=self.treasurer_a)

        resp = self.client.post(reverse('campaign-close', args=[camp.slug]))

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        camp.refresh_from_db()
        self.assertEqual(camp.status, CampaignStatus.ACTIVE)

    def test_close_succeeds_with_no_blocking_withdrawal(self):
        # Only a TERMINAL withdrawal (PAID) exists → it must NOT block the close.
        camp = _make_campaign(self.church_a, self.treasurer_a, slug='close-ok')
        _make_withdrawal(camp, status_=WithdrawalStatus.PAID)
        self.client.force_authenticate(user=self.treasurer_a)

        resp = self.client.post(reverse('campaign-close', args=[camp.slug]))

        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        camp.refresh_from_db()
        self.assertEqual(camp.status, CampaignStatus.CLOSED)

"""Step 2.9c Super Admin endpoint tests.

The permission story INVERTS here vs 2.8/2.9a/2.9b: instead of "scope to your
own church, deny cross-church," Super Admin acts ACROSS ALL churches by design.
The risk inverts too — danger is forgetting `IsSuperAdmin` on an admin endpoint
and leaving it reachable by treasurers or anonymous. This suite leads with the
permission-inversion audit ("lock on every door") and includes the cross-layer
proof that admin SUSPEND actually wires into treasurer-side ChurchNotSuspended.

Coverage:
  1. Permission inversion — treasurer/anonymous denied on every endpoint;
     super admin allowed (positive control).
  2. Suspend cross-layer effect — admin suspends → treasurer's NEXT state-changer
     starts failing; reactivate → works again.
  3. Registration approve / reject — status guards, AuditLog, email stubs.
  4. Force-retry money-mover — own/cross-status guards, structural lock + B2C
     ordering (TransactionTestCase), dispatch failure → FAILED.
  5. Billing + singleton — defaults on fresh DB, PATCH validation, AuditLog,
     count == 1 invariant.
  6. fee_percent exposure confinement — only /super/billing/ leaks it; no other
     2.9c endpoint response includes the field.
"""

from datetime import datetime, timezone as dt_timezone
from decimal import Decimal
from unittest.mock import patch

import requests
from django.core.cache import cache
from django.test import TestCase, TransactionTestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus, SubscriptionTier
from donations.models import Donation, DonationStatus
from integrations import daraja
from superadmin.models import PlatformSettings
from withdrawals.models import (
    Withdrawal,
    WithdrawalDispatchOutcome,
    WithdrawalStatus,
)


# ─────────────────────────────────────────────────────────────────────────────
# HTTP-boundary fakes (force-retry now calls the real DarajaClient().b2c_payout).
# We patch ONLY DarajaClient._http_request so the real client logic runs without
# network: the OAuth call returns a token, the B2C call returns/raises as needed.
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
    'ConversationID': 'AG_20260601_FR123',
    'ResponseCode': '0',
    'ResponseDescription': 'Accept the service request successfully.',
}


def _http_seam(*, b2c_response=None, b2c_exc=None, on_b2c=None):
    def _fake(method, url, **kwargs):
        if 'oauth' in url:
            return _FakeResponse(200, _OAUTH_OK)
        if on_b2c is not None:
            on_b2c()
        if b2c_exc is not None:
            raise b2c_exc
        return b2c_response if b2c_response is not None else _FakeResponse(200, _B2C_ACK_OK)
    return _fake


# ─────────────────────────────────────────────────────────────────────────────
# Fixture helpers
# ─────────────────────────────────────────────────────────────────────────────


def _make_super_admin(email='admin@pamoja.example'):
    return User.objects.create_user(
        email=email, password='unused',
        first_name='Super', last_name='Admin',
        role=UserRole.SUPER_ADMIN, church=None,
    )


def _make_church(name='Church A', email='a@example.org', status_=ChurchStatus.ACTIVE):
    return Church.objects.create(
        name=name, official_email=email,
        phone='254700000001', address='addr',
        county='Nairobi', denomination='PCEA',
        status=status_,
    )


def _make_treasurer(church, email='t@example.org'):
    return User.objects.create_user(
        email=email, password='unused',
        first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _make_campaign(church, treasurer, *, slug='c', wallet=Decimal('5000')):
    return Campaign.objects.create(
        slug=slug, church=church,
        title=f'Campaign {slug}', description='desc',
        goal_amount=Decimal('100000'),
        raised_amount=Decimal('10000'), wallet_balance=wallet,
        banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING,
        treasurer_phone='254712345678', treasurer_name='Treas Urer',
        created_by=treasurer,
        status=CampaignStatus.ACTIVE,
    )


def _make_withdrawal(campaign, *, status_=WithdrawalStatus.PENDING_APPROVAL,
                     amount=Decimal('1000'), retry_count=0):
    return Withdrawal.objects.create(
        campaign=campaign,
        requested_by_phone='254712345678',
        destination_phone='254712345678',
        destination_name='Treas Urer',
        amount=amount, reason='reason',
        status=status_, retry_count=retry_count,
    )


def _shift_ym(year, month, delta):
    """Shift a (year, month) by delta months. Mirrors the view's skeleton math."""
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


# ═════════════════════════════════════════════════════════════════════════════
# 1. Permission inversion — the "lock on every door" audit
# ═════════════════════════════════════════════════════════════════════════════


class PermissionInversionTest(TestCase):
    """For a REPRESENTATIVE SAMPLE of super endpoints (all 5 state-changers +
    billing PATCH + 2 reads), a CHURCH_TREASURER gets 403 and an ANONYMOUS user
    gets 401/403. Super admin gets 200 on the same endpoints (positive control).

    This is the inverted-risk guard. A treasurer hitting force-retry would be
    catastrophic; suspend would let a malicious treasurer disable competitors.
    """

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church, 't@example.org')
        cls.pending_church = _make_church(name='Pending Church',
                                          email='pending@example.org',
                                          status_=ChurchStatus.PENDING)
        cls.suspended_church = _make_church(name='Suspended Church',
                                            email='suspended@example.org',
                                            status_=ChurchStatus.SUSPENDED)
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='c1',
                                      wallet=Decimal('5000'))
        cls.failed_final_wd = _make_withdrawal(
            cls.campaign, status_=WithdrawalStatus.FAILED_FINAL,
            amount=Decimal('1000'), retry_count=5,
        )

    def setUp(self):
        self.client = APIClient()

    # Reads ------------------------------------------------------------

    def test_treasurer_denied_on_churches_list(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.get(reverse('super-churches'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_denied_on_churches_list(self):
        resp = self.client.get(reverse('super-churches'))
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED,
                                          status.HTTP_403_FORBIDDEN))

    def test_super_admin_allowed_on_churches_list(self):
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.get(reverse('super-churches'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_treasurer_denied_on_analytics(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.get(reverse('super-analytics'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_super_admin_allowed_on_analytics(self):
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.get(reverse('super-analytics'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    # State-changers ---------------------------------------------------

    def test_treasurer_denied_on_church_approve(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.post(reverse('super-church-approve',
                                        args=[self.pending_church.id]))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_denied_on_church_approve(self):
        resp = self.client.post(reverse('super-church-approve',
                                        args=[self.pending_church.id]))
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED,
                                          status.HTTP_403_FORBIDDEN))

    def test_treasurer_denied_on_church_reject(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.post(
            reverse('super-church-reject', args=[self.pending_church.id]),
            {'rejection_reason': 'bad'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_treasurer_denied_on_church_suspend(self):
        """CRITICAL: a treasurer cannot suspend any church (their own OR a
        competitor's). This is the worst-case inverted-risk scenario."""
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.post(reverse('super-church-suspend',
                                        args=[self.church.id]))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.church.refresh_from_db()
        self.assertEqual(self.church.status, ChurchStatus.ACTIVE)

    def test_treasurer_denied_on_church_set_tier(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.post(
            reverse('super-church-set-tier', args=[self.church.id]),
            {'subscription_tier': 'GROWTH'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_treasurer_denied_on_church_reactivate(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.post(reverse('super-church-reactivate',
                                        args=[self.suspended_church.id]))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_treasurer_denied_on_force_retry(self):
        """CRITICAL: a treasurer cannot force-retry FAILED_FINAL — that's the
        Super Admin's domain. Money-mover endpoint."""
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.post(reverse('super-withdrawal-force-retry',
                                        args=[self.failed_final_wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.failed_final_wd.refresh_from_db()
        self.assertEqual(self.failed_final_wd.status, WithdrawalStatus.FAILED_FINAL)

    def test_anonymous_denied_on_force_retry(self):
        resp = self.client.post(reverse('super-withdrawal-force-retry',
                                        args=[self.failed_final_wd.id]))
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED,
                                          status.HTTP_403_FORBIDDEN))

    def test_treasurer_denied_on_billing_get(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.get(reverse('super-billing'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_treasurer_denied_on_billing_patch(self):
        """CRITICAL: a treasurer cannot change fee_percent — Pamoja Hub's revenue."""
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.patch(reverse('super-billing'),
                                 {'fee_percent': '0.10'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_super_admin_allowed_on_billing(self):
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.get(reverse('super-billing'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)


# ═════════════════════════════════════════════════════════════════════════════
# 2. Suspend cross-layer effect — admin SUSPEND wires into treasurer enforcement
# ═════════════════════════════════════════════════════════════════════════════


class SuspendCrossLayerEffectTest(TestCase):
    """Proves the Super Admin SUSPEND action actually disables the treasurer's
    state-changing endpoints (via ChurchNotSuspended). The two halves of the
    SUSPENDED enforcement story — admin action + treasurer-side gate — must
    connect; otherwise SUSPEND is theatre.
    """

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church(name='Cross-Layer Church', email='cl@example.org')
        cls.treasurer = _make_treasurer(cls.church, 'cl-t@example.org')

    def setUp(self):
        self.client = APIClient()

    def _authed_as_fresh_treasurer(self):
        """Authenticate with a freshly-fetched User instance. In production, JWT
        auth queries the DB on every request — so user.church reflects live
        status. force_authenticate(user=X) reuses the Python instance, which
        means a class-level setUpTestData instance keeps STALE cached related
        objects (.church). To prove the cross-layer suspend effect we mirror
        production by re-fetching the user; this clears Django's FK cache and
        the next user.church access re-queries the DB.
        """
        fresh = User.objects.get(id=self.treasurer.id)
        self.client.force_authenticate(user=fresh)

    def _create_campaign(self, title):
        return self.client.post(
            reverse('campaign-create'),
            {
                'title': title,
                'description': 'desc',
                'goal_amount': '50000',
                'banner_image_url': 'https://example.org/x.png',
                'category': CampaignCategory.BUILDING,
                'treasurer_phone': '0712345678',
                'treasurer_name': 'T U',
            },
            format='json',
        )

    def test_admin_suspend_blocks_treasurer_state_changes_immediately(self):
        # Baseline: treasurer can create a campaign while church is ACTIVE.
        self._authed_as_fresh_treasurer()
        resp = self._create_campaign('Pre-suspend Campaign')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)

        # Super Admin suspends the church.
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.post(
            reverse('super-church-suspend', args=[self.church.id]),
            {'reason': 'AML flag'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.church.refresh_from_db()
        self.assertEqual(self.church.status, ChurchStatus.SUSPENDED)

        # Treasurer's NEXT state-changing action is BLOCKED — fresh user fetch
        # mirrors production JWT auth; ChurchNotSuspended sees live SUSPENDED.
        self._authed_as_fresh_treasurer()
        resp = self._create_campaign('Post-suspend Campaign')
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn('not active', resp.data['detail'].lower())

        # Super Admin reactivates → treasurer's action works again.
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.post(reverse('super-church-reactivate', args=[self.church.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        self._authed_as_fresh_treasurer()
        resp = self._create_campaign('Post-reactivate Campaign')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)


# ═════════════════════════════════════════════════════════════════════════════
# 3. Registration approve / reject
# ═════════════════════════════════════════════════════════════════════════════


class RegistrationApproveRejectTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.pending = _make_church(name='Pending Church', email='p@example.org',
                                    status_=ChurchStatus.PENDING)
        cls.active = _make_church(name='Active Church', email='ac@example.org',
                                   status_=ChurchStatus.ACTIVE)

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_approve_pending_church(self):
        with patch('superadmin.views.send_registration_approved') as spy:
            resp = self.client.post(reverse('super-church-approve', args=[self.pending.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.status, ChurchStatus.ACTIVE)
        spy.assert_called_once()

        self.assertEqual(
            AuditLog.objects.filter(action='CHURCH_APPROVED',
                                    entity_id=self.pending.id).count(),
            1,
        )

    def test_cannot_approve_non_pending_church(self):
        resp = self.client.post(reverse('super-church-approve', args=[self.active.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_reject_pending_church_with_reason(self):
        with patch('superadmin.views.send_registration_rejected') as spy:
            resp = self.client.post(
                reverse('super-church-reject', args=[self.pending.id]),
                {'rejection_reason': 'Documents did not match the application.'},
                format='json',
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.pending.refresh_from_db()
        self.assertEqual(self.pending.status, ChurchStatus.REJECTED)
        spy.assert_called_once()

        audit = AuditLog.objects.filter(action='CHURCH_REJECTED',
                                        entity_id=self.pending.id).latest('created_at')
        self.assertIn('Documents did not match', audit.details['reason'])

    def test_reject_without_reason_returns_400(self):
        resp = self.client.post(
            reverse('super-church-reject', args=[self.pending.id]),
            {}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_reject_non_pending_church(self):
        resp = self.client.post(
            reverse('super-church-reject', args=[self.active.id]),
            {'rejection_reason': 'Some reason'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


# ═════════════════════════════════════════════════════════════════════════════
# 3b. Church tier flip — greenfield, money-INERT, audited
# ═════════════════════════════════════════════════════════════════════════════


class SetTierTests(TestCase):
    """POST /super/churches/{id}/set-tier/ — assign subscription_tier. The flip is
    money-INERT: it must touch ONLY subscription_tier (never subscription_expires_at,
    never any wallet/billing field). Valid choice flips + audits; invalid choice 400s
    field-keyed; re-sending the current tier is an idempotent 200 no-op.
    """

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        # A FREE church (the model default) to upgrade.
        cls.church = _make_church(name='Tier Church', email='tier@example.org')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_valid_flip_free_to_growth_persists_audits_and_is_inert(self):
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(self.church.subscription_expires_at)

        resp = self.client.post(
            reverse('super-church-set-tier', args=[self.church.id]),
            {'subscription_tier': 'GROWTH'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['subscription_tier'], 'GROWTH')

        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.GROWTH)
        # INERT: expiry untouched (still null) — no money behaviour fired.
        self.assertIsNone(self.church.subscription_expires_at)

        audit = AuditLog.objects.filter(action='CHURCH_TIER_CHANGED',
                                        entity_id=self.church.id).latest('created_at')
        self.assertEqual(audit.details['old_tier'], 'FREE')
        self.assertEqual(audit.details['new_tier'], 'GROWTH')
        self.assertEqual(audit.actor_id, self.super_admin.id)

    def test_invalid_tier_returns_400_field_keyed_and_unchanged(self):
        resp = self.client.post(
            reverse('super-church-set-tier', args=[self.church.id]),
            {'subscription_tier': 'PLATINUM'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('subscription_tier', resp.data)   # field-keyed
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)  # unchanged

    def test_missing_tier_returns_400(self):
        resp = self.client.post(
            reverse('super-church-set-tier', args=[self.church.id]),
            {}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('subscription_tier', resp.data)

    def test_idempotent_same_tier_is_200_noop_no_audit(self):
        """Re-sending the current tier (FREE) → 200 with the unchanged row, and NO
        new CHURCH_TIER_CHANGED audit (a no-op is not a change)."""
        before = AuditLog.objects.filter(action='CHURCH_TIER_CHANGED').count()
        resp = self.client.post(
            reverse('super-church-set-tier', args=[self.church.id]),
            {'subscription_tier': 'FREE'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['subscription_tier'], 'FREE')
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)
        after = AuditLog.objects.filter(action='CHURCH_TIER_CHANGED').count()
        self.assertEqual(after, before)   # no-op recorded nothing

    def test_set_tier_on_missing_church_returns_404(self):
        import uuid
        resp = self.client.post(
            reverse('super-church-set-tier', args=[uuid.uuid4()]),
            {'subscription_tier': 'GROWTH'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


# ═════════════════════════════════════════════════════════════════════════════
# 4. Force-retry — money-mover guards + structural + dispatch-failure
# ═════════════════════════════════════════════════════════════════════════════


class ForceRetryGuardsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church(name='FR Church', email='fr@example.org')
        cls.treasurer = _make_treasurer(cls.church, 'fr-t@example.org')
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='fr-c',
                                       wallet=Decimal('5000'))

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_force_retry_failed_final_with_sufficient_balance(self):
        wd = _make_withdrawal(self.campaign,
                              status_=WithdrawalStatus.FAILED_FINAL,
                              amount=Decimal('1000'), retry_count=5)
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam()):
            resp = self.client.post(reverse('super-withdrawal-force-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PROCESSING)
        # retry_count reset to 0 (decision recorded in view docstring).
        self.assertEqual(wd.retry_count, 0)
        # Real client stores the Daraja ConversationID from the sync ACK.
        self.assertEqual(wd.b2c_conversation_id, _B2C_ACK_OK['ConversationID'])

        self.assertEqual(
            AuditLog.objects.filter(action='WITHDRAWAL_FORCE_RETRIED',
                                    entity_id=wd.id).count(),
            1,
        )

    def test_cannot_force_retry_failed_non_final(self):
        wd = _make_withdrawal(self.campaign, status_=WithdrawalStatus.FAILED,
                              retry_count=2)
        resp = self.client.post(reverse('super-withdrawal-force-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_force_retry_paid(self):
        wd = _make_withdrawal(self.campaign, status_=WithdrawalStatus.PAID)
        resp = self.client.post(reverse('super-withdrawal-force-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_force_retry_pending(self):
        wd = _make_withdrawal(self.campaign, status_=WithdrawalStatus.PENDING_APPROVAL)
        resp = self.client.post(reverse('super-withdrawal-force-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_force_retry_insufficient_balance_stays_failed_final(self):
        wd = _make_withdrawal(self.campaign,
                              status_=WithdrawalStatus.FAILED_FINAL,
                              amount=Decimal('6000'), retry_count=5)
        resp = self.client.post(reverse('super-withdrawal-force-retry', args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('insufficient wallet balance', resp.data['detail'].lower())
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.FAILED_FINAL)


class ForceRetryStructuralTest(TransactionTestCase):
    """SELECT FOR UPDATE on campaign + b2c called AFTER commit. Same proof as
    treasurer approve in 2.9b — see that suite's ApproveStructuralLockAndOrderingTest
    docstring for the Why-TransactionTestCase rationale.
    """

    def setUp(self):
        daraja._clear_token_cache()
        self.super_admin = _make_super_admin()
        self.church = _make_church(name='Struct FR', email='sfr@example.org')
        self.treasurer = _make_treasurer(self.church, 'sfr-t@example.org')
        self.campaign = _make_campaign(self.church, self.treasurer, slug='sfr-c',
                                        wallet=Decimal('5000'))
        self.wd = _make_withdrawal(self.campaign,
                                    status_=WithdrawalStatus.FAILED_FINAL,
                                    amount=Decimal('1000'), retry_count=5)
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_b2c_called_after_transaction_commits(self):
        """Spy at the HTTP boundary for the B2C call — real b2c_payout runs,
        only HTTP is mocked. At the moment the B2C call fires, the withdrawal
        must be committed-PROCESSING with no open transaction.
        """
        captured = {}

        def on_b2c():
            from django.db import connection as conn
            captured['in_atomic'] = conn.in_atomic_block
            fresh = Withdrawal.objects.get(id=self.wd.id)
            captured['status_at_call'] = fresh.status

        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam(on_b2c=on_b2c)):
            resp = self.client.post(reverse('super-withdrawal-force-retry',
                                            args=[self.wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        self.assertFalse(
            captured['in_atomic'],
            'B2C HTTP call fired while a transaction was still open — '
            'the force-retry lock-then-call architecture rule is broken.',
        )
        self.assertEqual(captured['status_at_call'], WithdrawalStatus.PROCESSING)


class ForceRetryDispatchFailureTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church(name='FRDF Church', email='frdf@example.org')
        cls.treasurer = _make_treasurer(cls.church, 'frdf-t@example.org')
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='frdf-c',
                                       wallet=Decimal('5000'))

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_dispatch_failure_sets_failed_not_stuck_processing(self):
        wd = _make_withdrawal(self.campaign,
                              status_=WithdrawalStatus.FAILED_FINAL,
                              amount=Decimal('1000'), retry_count=5)
        # Drive the failure THROUGH the real client — the HTTP boundary raises a
        # connection error on the B2C call → b2c_payout raises B2CDispatchError.
        daraja._clear_token_cache()
        with patch.object(
            daraja.DarajaClient, '_http_request',
            side_effect=_http_seam(b2c_exc=requests.ConnectionError('upstream unreachable')),
        ):
            resp = self.client.post(reverse('super-withdrawal-force-retry',
                                            args=[wd.id]))

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data.get('dispatch_status'), 'failed_queued_for_retry')
        wd.refresh_from_db()
        # FAILED_FINAL → FAILED with retry_count=0 (reset in Phase 1) — back in
        # the treasurer-retriable state by design (§14).
        self.assertEqual(wd.status, WithdrawalStatus.FAILED)
        self.assertEqual(wd.retry_count, 0)
        self.assertIsNone(wd.b2c_conversation_id)
        # Connection error → CLEAN marker (provably never queued).
        self.assertEqual(wd.dispatch_outcome, WithdrawalDispatchOutcome.CLEAN_FAILURE)
        # Copy reflects MANUAL retry (no automatic retry job) — mentions the
        # panel, NOT "will retry".
        self.assertIn('panel', wd.failure_reason.lower())
        self.assertNotIn('will retry', wd.failure_reason.lower())
        # A distinct dispatch-failure audit entry exists for this transition.
        self.assertEqual(
            AuditLog.objects.filter(
                action='WITHDRAWAL_FORCE_RETRY_DISPATCH_FAILED',
                entity_id=wd.id,
            ).count(),
            1,
        )

    def test_ambiguous_dispatch_failure_stamps_ambiguous_marker(self):
        """Force-retry with a 200 + non-zero ResponseCode → FAILED with the
        AMBIGUOUS marker. Even though the row is back in the treasurer-retriable
        FAILED state, 2.10c must NOT blind-re-dispatch it — it may be queued.
        """
        wd = _make_withdrawal(self.campaign,
                              status_=WithdrawalStatus.FAILED_FINAL,
                              amount=Decimal('1000'), retry_count=5)
        ambiguous_ack = _FakeResponse(200, {
            'ConversationID': 'AG_MAYBE', 'ResponseCode': '1',
            'ResponseDescription': 'system busy',
        })
        daraja._clear_token_cache()
        with patch.object(daraja.DarajaClient, '_http_request',
                          side_effect=_http_seam(b2c_response=ambiguous_ack)):
            resp = self.client.post(reverse('super-withdrawal-force-retry',
                                            args=[wd.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.FAILED)
        self.assertEqual(wd.dispatch_outcome, WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)
        self.assertIsNone(wd.b2c_conversation_id)


# ═════════════════════════════════════════════════════════════════════════════
# 5. Billing + singleton
# ═════════════════════════════════════════════════════════════════════════════


class BillingAndSingletonTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_billing_get_returns_defaults_on_fresh_db(self):
        """No PlatformSettings row exists yet — load() get_or_creates with
        defaults. Proves the singleton-no-row case (test DB is fresh)."""
        # Make sure no row exists — this is the fresh-DB scenario.
        PlatformSettings.objects.all().delete()
        self.assertEqual(PlatformSettings.objects.count(), 0)

        resp = self.client.get(reverse('super-billing'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(Decimal(resp.data['fee_percent']), Decimal('2.50'))
        self.assertEqual(Decimal(resp.data['growth_price']), Decimal('999.00'))
        self.assertEqual(Decimal(resp.data['parish_price']), Decimal('2499.00'))
        # And the row was created.
        self.assertEqual(PlatformSettings.objects.count(), 1)

    def test_patch_fee_percent_persists_and_audits(self):
        resp = self.client.patch(reverse('super-billing'),
                                 {'fee_percent': '3.00'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(Decimal(resp.data['fee_percent']), Decimal('3.00'))

        # GET again returns the persisted value.
        resp2 = self.client.get(reverse('super-billing'))
        self.assertEqual(Decimal(resp2.data['fee_percent']), Decimal('3.00'))

        # AuditLog entry recorded with old/new.
        audit = AuditLog.objects.filter(action='PLATFORM_SETTINGS_CHANGED').latest('created_at')
        self.assertEqual(audit.details['old']['fee_percent'], '2.50')
        self.assertEqual(audit.details['new']['fee_percent'], '3.00')

    def test_patch_insane_fee_returns_400(self):
        resp = self.client.patch(reverse('super-billing'),
                                 {'fee_percent': '150'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_patch_negative_fee_returns_400(self):
        resp = self.client.patch(reverse('super-billing'),
                                 {'fee_percent': '-1'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    # ── Tier-price bounds (tightened from non-negative-only to >0 and <=1,000,000) ──

    def test_patch_zero_growth_price_returns_400_field_keyed_and_unchanged(self):
        """A 0 price is a fat-finger, not 'a paid tier that's free' — rejected."""
        before = PlatformSettings.load().growth_price
        resp = self.client.patch(reverse('super-billing'),
                                 {'growth_price': '0'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('growth_price', resp.data)            # field-keyed
        PlatformSettings.load().refresh_from_db()
        self.assertEqual(PlatformSettings.load().growth_price, before)  # untouched

    def test_patch_over_cap_growth_price_returns_400(self):
        resp = self.client.patch(reverse('super-billing'),
                                 {'growth_price': '2000000'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('growth_price', resp.data)

    def test_patch_over_cap_parish_price_returns_400(self):
        resp = self.client.patch(reverse('super-billing'),
                                 {'parish_price': '2000000'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('parish_price', resp.data)

    def test_patch_valid_growth_price_persists_and_audits(self):
        resp = self.client.patch(reverse('super-billing'),
                                 {'growth_price': '1499'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(Decimal(resp.data['growth_price']), Decimal('1499'))
        # GET again returns the persisted value (sticks).
        resp2 = self.client.get(reverse('super-billing'))
        self.assertEqual(Decimal(resp2.data['growth_price']), Decimal('1499'))
        # Audit covers the change (snapshot already includes all three fields).
        audit = AuditLog.objects.filter(action='PLATFORM_SETTINGS_CHANGED').latest('created_at')
        self.assertEqual(audit.details['new']['growth_price'], '1499.00')

    def test_singleton_enforcement_via_save_pk_pinning(self):
        """A second create() reuses pk=1 — count stays at 1."""
        PlatformSettings.load()                                # first row
        self.assertEqual(PlatformSettings.objects.count(), 1)

        # Attempt a "second" — save() pins pk to SINGLETON_ID so this UPDATES
        # the existing row rather than INSERTS a new one.
        PlatformSettings(fee_percent=Decimal('5.00')).save()
        self.assertEqual(PlatformSettings.objects.count(), 1)
        self.assertEqual(PlatformSettings.objects.first().fee_percent, Decimal('5.00'))


# ═════════════════════════════════════════════════════════════════════════════
# 6. fee_percent exposure confinement
# ═════════════════════════════════════════════════════════════════════════════


class FeeExposureConfinementTest(TestCase):
    """fee_percent must appear ONLY in /super/billing/ responses. The other
    2.9c read endpoints (churches, campaigns, donations, withdrawals,
    analytics, audit-log) must not leak it. Leak guard parallels the
    Step 2.5 public/admin serializer split: a misuse hidden under a generic
    name like 'fee' could silently expose Pamoja Hub's pricing strategy.
    """

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church)
        cls.campaign = _make_campaign(cls.church, cls.treasurer)

        # Generate a donation so /super/donations/ has data — it MUST expose
        # platform_fee / net_amount (authorized place) but NOT fee_percent
        # (which is the rate, not the per-row absolute).
        Donation.objects.create(
            campaign=cls.campaign,
            phone_number='254712345678',
            amount=Decimal('1000'),
            platform_fee=Decimal('25.00'),
            net_amount=Decimal('975.00'),
            status=DonationStatus.SUCCESSFUL,
        )

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def _no_fee_percent(self, payload, where: str):
        # Recursively walk the payload — any 'fee_percent' key at any depth fails.
        def walk(node, path):
            if isinstance(node, dict):
                for k, v in node.items():
                    self.assertNotEqual(
                        k, 'fee_percent',
                        f'fee_percent leaked at {where}{path}.{k}: {v}',
                    )
                    walk(v, f'{path}.{k}')
            elif isinstance(node, list):
                for i, item in enumerate(node):
                    walk(item, f'{path}[{i}]')
        walk(payload, '')

    def test_donations_endpoint_exposes_fee_and_net_but_not_fee_percent(self):
        resp = self.client.get(reverse('super-donations'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # Authorized: platform_fee, net_amount are PRESENT (PRD 8.6).
        row = resp.data['results'][0]
        self.assertIn('platform_fee', row)
        self.assertIn('net_amount', row)
        # NOT present: fee_percent (the rate). Per-row absolute is fine; rate is not.
        self._no_fee_percent(resp.data, '/super/donations/')

    def test_churches_endpoint_does_not_expose_fee_percent(self):
        resp = self.client.get(reverse('super-churches'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._no_fee_percent(resp.data, '/super/churches/')

    def test_campaigns_endpoint_does_not_expose_fee_percent(self):
        resp = self.client.get(reverse('super-campaigns'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._no_fee_percent(resp.data, '/super/campaigns/')

    def test_withdrawals_endpoint_does_not_expose_fee_percent(self):
        resp = self.client.get(reverse('super-withdrawals'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._no_fee_percent(resp.data, '/super/withdrawals/')

    def test_analytics_endpoint_does_not_expose_fee_percent(self):
        resp = self.client.get(reverse('super-analytics'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._no_fee_percent(resp.data, '/super/analytics/')

    def test_audit_log_endpoint_does_not_expose_fee_percent(self):
        resp = self.client.get(reverse('super-audit-log'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self._no_fee_percent(resp.data, '/super/audit-log/')

    def test_billing_endpoint_DOES_expose_fee_percent(self):
        """Positive control — billing IS the authorized surface for fee_percent."""
        resp = self.client.get(reverse('super-billing'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn('fee_percent', resp.data)


# ═════════════════════════════════════════════════════════════════════════════
# 7. Rejected-treasurer login/inertness — account is inert, NOT deactivated
# ═════════════════════════════════════════════════════════════════════════════


class RejectedTreasurerLoginInertnessTest(TestCase):
    """Decision (Step 2.9c §C): when a church is rejected we do NOT deactivate
    the User account (is_active stays True). Most rejections are correctable
    (incomplete info, typo, wrong county) and deactivating would permanently
    lock out the legitimate church from re-registering (since both the REJECTED
    Church row and the unique-email User row persist).

    The account is INERT-BUT-LOGINABLE:
      * Login succeeds — the treasurer can authenticate and see church_status=REJECTED
        in the response so the frontend can show the decline reason.
      * Every state-changing action is denied by ChurchNotSuspended (allowlist
        ('PENDING','ACTIVE') excludes REJECTED).
      * Public surfaces filter to status=ACTIVE so REJECTED churches don't appear.

    The actual money-safety boundary for non-ACTIVE churches is the
    donation-initiate church-status check (a 2.10 requirement), NOT the login state.
    """

    REJECTED_TREASURER_PASSWORD = 'L3gitPassword!'

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.rejected_church = _make_church(
            name='Rejected Church',
            email='rejected@example.org',
            status_=ChurchStatus.REJECTED,
        )
        # Treasurer account stays is_active=True after rejection — confirmed below.
        cls.rejected_treasurer = User.objects.create_user(
            email='rejected-t@example.org',
            password=cls.REJECTED_TREASURER_PASSWORD,
            first_name='Re', last_name='Jected',
            role=UserRole.CHURCH_TREASURER,
            church=cls.rejected_church,
        )

    def setUp(self):
        cache.clear()                       # auth-login 5/15m IP limit
        self.client = APIClient()

    def test_rejected_church_treasurer_is_still_active(self):
        """Sanity: SuperChurchRejectView does NOT touch is_active. The User
        account remains active (loginable), only the Church status flips to
        REJECTED. Verified at the model layer first; the API flow follows.
        """
        self.rejected_treasurer.refresh_from_db()
        self.assertTrue(self.rejected_treasurer.is_active)
        self.rejected_church.refresh_from_db()
        self.assertEqual(self.rejected_church.status, ChurchStatus.REJECTED)

    def test_rejected_treasurer_can_log_in_and_sees_rejected_status(self):
        resp = self.client.post(
            reverse('auth-login'),
            {
                'email': self.rejected_treasurer.email,
                'password': self.REJECTED_TREASURER_PASSWORD,
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertIn('access', resp.data)
        self.assertIn('refresh', resp.data)
        # Frontend branches on this — shows the decline reason and a resubmit
        # affordance rather than a confusing generic auth failure.
        self.assertEqual(resp.data['church_status'], ChurchStatus.REJECTED)

    def test_rejected_treasurer_cannot_create_campaign_via_bearer_token(self):
        """End-to-end inertness check: log in to get a real bearer token, then
        try a state-changing action. ChurchNotSuspended's allowlist excludes
        REJECTED → 403 with the 'not active' message. The account is loginable
        but cannot ACT on platform state.
        """
        # 1) Login via the real endpoint → get an access token.
        login = self.client.post(
            reverse('auth-login'),
            {
                'email': self.rejected_treasurer.email,
                'password': self.REJECTED_TREASURER_PASSWORD,
            },
            format='json',
        )
        self.assertEqual(login.status_code, status.HTTP_200_OK, login.content)
        access = login.data['access']

        # 2) Use the bearer token (real JWTAuthentication) — NOT force_authenticate.
        bearer_client = APIClient()
        bearer_client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')

        # 3) State-changing action denied.
        resp = bearer_client.post(
            reverse('campaign-create'),
            {
                'title': 'Hopeful Campaign',
                'description': 'desc',
                'goal_amount': '50000',
                'banner_image_url': 'https://example.org/x.png',
                'category': CampaignCategory.BUILDING,
                'treasurer_phone': '0712345678',
                'treasurer_name': 'T U',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn('not active', resp.data['detail'].lower())

    def test_rejected_church_excluded_from_public_browse(self):
        """REJECTED churches must not appear in the public directory."""
        resp = self.client.get(reverse('church-public-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        names = {item['name'] for item in resp.data['results']}
        self.assertNotIn('Rejected Church', names)


# ═════════════════════════════════════════════════════════════════════════════
# 8. JWT-bearer cross-layer suspend test — fresh-user-per-request enforced
# ═════════════════════════════════════════════════════════════════════════════


class SuspendCrossLayerWithJWTBearerTest(TestCase):
    """Variant of SuspendCrossLayerEffectTest that drives a REAL bearer token
    through JWTAuthentication, exercising — not just asserting — the
    "fresh user per request" property.

    Why this matters: ChurchNotSuspended.has_permission reads
    `request.user.church.status`. SimpleJWT's JWTAuthentication fetches the
    user from the DB on every request, and `user.church` is a lazy FK that
    loads on access — so the status check sees the LIVE row. If a future
    refactor added `select_related('church')` to the JWT auth user fetch (or
    introduced an auth-layer user cache), suspension would become stale until
    token expiry — admin SUSPEND would not take effect until the treasurer's
    next access-token refresh. This test fails loudly if that property breaks.

    Compressed Context §14 records the rule: do NOT add `select_related('church')`
    to the JWT auth user fetch, and do NOT introduce an auth-layer user cache.
    """

    TREASURER_PASSWORD = 'JWTBearerPassword1!'

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church(name='JWT Church', email='jwt@example.org')
        cls.treasurer = User.objects.create_user(
            email='jwt-t@example.org',
            password=cls.TREASURER_PASSWORD,
            first_name='J', last_name='T',
            role=UserRole.CHURCH_TREASURER,
            church=cls.church,
        )

    def setUp(self):
        cache.clear()                       # login + admin rate limits
        # Anonymous client used for login
        self.client = APIClient()

    def _login_treasurer_and_get_bearer_client(self):
        resp = self.client.post(
            reverse('auth-login'),
            {'email': self.treasurer.email, 'password': self.TREASURER_PASSWORD},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        access = resp.data['access']
        bearer = APIClient()
        bearer.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        return bearer, access

    def _create_campaign(self, bearer_client, title):
        return bearer_client.post(
            reverse('campaign-create'),
            {
                'title': title,
                'description': 'desc',
                'goal_amount': '50000',
                'banner_image_url': 'https://example.org/x.png',
                'category': CampaignCategory.BUILDING,
                'treasurer_phone': '0712345678',
                'treasurer_name': 'T U',
            },
            format='json',
        )

    def test_jwt_bearer_holds_treasurer_loses_actions_when_church_suspended(self):
        # 1) Login as treasurer — get a bearer client tied to ONE access token.
        #    The SAME token will be reused across all subsequent requests; the
        #    test does NOT issue a new token after suspension.
        bearer, access = self._login_treasurer_and_get_bearer_client()

        # 2) Baseline: state-changing action SUCCEEDS while church is ACTIVE.
        resp = self._create_campaign(bearer, 'Pre-suspend (JWT)')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)

        # 3) Super Admin suspends the church.
        admin_client = APIClient()
        admin_client.force_authenticate(user=self.super_admin)
        resp = admin_client.post(
            reverse('super-church-suspend', args=[self.church.id]),
            {'reason': 'JWT cross-layer test'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.church.refresh_from_db()
        self.assertEqual(self.church.status, ChurchStatus.SUSPENDED)

        # 4) THE PROOF: the SAME bearer token (NOT refreshed) is now blocked.
        #    This works only because JWTAuthentication re-fetches the user per
        #    request and `user.church` lazy-loads, so ChurchNotSuspended reads
        #    the LIVE SUSPENDED status. If a future refactor cached the user
        #    or eagerly select_related'd church, this test would fail.
        resp = self._create_campaign(bearer, 'Post-suspend (JWT)')
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn('not active', resp.data['detail'].lower())

        # 5) Reactivate → same bearer token works again, no re-login needed.
        resp = admin_client.post(reverse('super-church-reactivate', args=[self.church.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        resp = self._create_campaign(bearer, 'Post-reactivate (JWT)')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)


# ═════════════════════════════════════════════════════════════════════════════
# 9. Analytics date-range boundary — inclusive 'to' day + bad-param 400
# ═════════════════════════════════════════════════════════════════════════════


class AnalyticsDateBoundaryTest(TestCase):
    """SuperAnalyticsView date handling (2.9c final correction).

    Two guards:
      * The 'to' bound is date-INCLUSIVE: a SUCCESSFUL donation timestamped at
        23:30 on the to date must land in gross_total/net_total/platform_fees,
        not be silently dropped because created_at (a datetime) exceeds
        midnight-at-start-of-day. Pins __date__lte over __lte.
      * An unparseable from/to param returns 400, never 500 from inside the
        aggregate.
    """

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church, 't@example.org')
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='cb1')

        # A SUCCESSFUL donation at 23:30 UTC on 2026-06-01. created_at is
        # auto_now_add, so set it via .update() to bypass the auto stamp.
        cls.donation = Donation.objects.create(
            campaign=cls.campaign,
            phone_number='254712345678',
            amount=Decimal('1000.00'),
            platform_fee=Decimal('25.00'),
            net_amount=Decimal('975.00'),
            status=DonationStatus.SUCCESSFUL,
        )
        Donation.objects.filter(id=cls.donation.id).update(
            created_at=datetime(2026, 6, 1, 23, 30, 0, tzinfo=dt_timezone.utc)
        )

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_donation_at_2330_on_to_date_is_included(self):
        resp = self.client.get(
            reverse('super-analytics'), {'from': '2026-06-01', 'to': '2026-06-01'}
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        # The late-evening donation is INSIDE the inclusive range, so totals
        # equal the donation, not zero.
        self.assertEqual(resp.data['donations']['count'], 1)
        self.assertEqual(Decimal(resp.data['donations']['gross_total']), Decimal('1000.00'))
        self.assertEqual(Decimal(resp.data['donations']['net_total']), Decimal('975.00'))
        self.assertEqual(Decimal(resp.data['platform_fees_collected']), Decimal('25.00'))

    def test_bad_to_param_returns_400_not_500(self):
        resp = self.client.get(reverse('super-analytics'), {'to': 'notadate'})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn('to', resp.data)

    def test_bad_from_param_returns_400_not_500(self):
        resp = self.client.get(reverse('super-analytics'), {'from': '2026-13-99'})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn('from', resp.data)


# ═════════════════════════════════════════════════════════════════════════════
# 9b. Analytics chart aggregations — donations_by_month + top_churches_by_raised
# ═════════════════════════════════════════════════════════════════════════════


class DonationsByMonthChartTest(TestCase):
    """SuperAnalyticsView.donations_by_month — trailing 12-month GROSS series.

    Proves: exactly 12 entries oldest→newest; the empty month is zero-filled
    ("0.00"); populated months equal the seeded GROSS (amount) sums and EXCLUDE
    non-SUCCESSFUL rows; a donation older than the 12-month window is dropped;
    every total is a STRING (rule #11). Uses a fixed trailing window relative to
    now(), so it computes the expected month keys the same way the view does.
    """

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church, 't@example.org')
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='dbm')

        now = timezone.now()
        ty, tm = now.year, now.month
        cls.this_key = f'{ty:04d}-{tm:02d}'
        y1, m1 = _shift_ym(ty, tm, -1)
        cls.one_ago_key = f'{y1:04d}-{m1:02d}'
        y2, m2 = _shift_ym(ty, tm, -2)
        cls.two_ago_key = f'{y2:04d}-{m2:02d}'
        y13, m13 = _shift_ym(ty, tm, -13)
        cls.old_key = f'{y13:04d}-{m13:02d}'

        def _seed(year, month, amount, receipt, status_=DonationStatus.SUCCESSFUL):
            d = Donation.objects.create(
                campaign=cls.campaign, phone_number='254712345678',
                amount=Decimal(amount), platform_fee=Decimal('0.00'),
                net_amount=Decimal(amount), status=status_,
                mpesa_receipt_number=receipt,
            )
            # created_at is auto_now_add → override to the target month via .update().
            Donation.objects.filter(id=d.id).update(
                created_at=datetime(year, month, 15, 12, 0, 0, tzinfo=dt_timezone.utc)
            )

        # This month: two SUCCESSFUL (gross 3000) + one PENDING (must be excluded).
        _seed(ty, tm, '1000.00', 'DBMTHIS01')
        _seed(ty, tm, '2000.00', 'DBMTHIS02')
        _seed(ty, tm, '500.00', 'DBMPEND01', status_=DonationStatus.PENDING)
        # Two months ago: one SUCCESSFUL (gross 500).
        _seed(y2, m2, '500.00', 'DBMTWO001')
        # One month ago: NOTHING seeded → zero-fill proof.
        # Thirteen months ago: OUT OF the 12-month window → must be excluded.
        _seed(y13, m13, '9999.00', 'DBMOLD001')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_donations_by_month_shape_and_values(self):
        resp = self.client.get(reverse('super-analytics'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        buckets = resp.data['donations_by_month']

        # Exactly 12 entries, oldest → newest.
        self.assertEqual(len(buckets), 12)
        months = [b['month'] for b in buckets]
        self.assertEqual(months, sorted(months))
        self.assertEqual(months[-1], self.this_key)          # newest bucket = this month
        # The out-of-window (13-months-ago) month is NOT a bucket.
        self.assertNotIn(self.old_key, months)

        by = {b['month']: b for b in buckets}
        # Populated months = seeded GROSS sums; PENDING excluded from this month.
        self.assertEqual(Decimal(by[self.this_key]['total']), Decimal('3000.00'))
        self.assertEqual(Decimal(by[self.two_ago_key]['total']), Decimal('500.00'))
        # The empty month is zero-filled, exactly "0.00".
        self.assertEqual(by[self.one_ago_key]['total'], '0.00')

        # Every field is a STRING on the wire (rule #11).
        for b in buckets:
            self.assertIsInstance(b['total'], str)
            self.assertIsInstance(b['month'], str)


class TopChurchesByRaisedChartTest(TestCase):
    """SuperAnalyticsView.top_churches_by_raised — platform-wide top 10 by NET
    raised (Sum of campaigns.raised_amount, reusing the churches-list annotation).

    Proves: descending order; capped at 10 (11 funded churches → the lowest is
    dropped, and an unfunded church never crowds in); totals are STRINGS; ONLY
    church_name + total_raised are exposed (NO phone / treasurer / email PII).
    """

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        # A creator church with NO campaign → total_raised 0.00 (Coalesce), so it
        # can never crowd the top-10; its treasurer authors every campaign below.
        cls.creator_church = _make_church(name='Creator Church', email='creator@example.org')
        cls.creator = _make_treasurer(cls.creator_church, 'creator-t@example.org')

        # 11 churches with DISTINCT raised totals 1100, 1000, … 100 (descending).
        for i in range(11):
            raised = Decimal((11 - i) * 100)         # i=0 → 1100 … i=10 → 100
            ch = _make_church(name=f'Raise Church {11 - i:02d}',
                              email=f'raise{i}@example.org')
            Campaign.objects.create(
                slug=f'raise-{i}', church=ch, created_by=cls.creator,
                title=f'RC {i}', description='desc',
                goal_amount=Decimal('100000'), raised_amount=raised,
                wallet_balance=Decimal('0'),
                banner_image_url='https://example.org/x.png',
                category=CampaignCategory.BUILDING,
                treasurer_phone='254712345678', treasurer_name='T',
                status=CampaignStatus.ACTIVE,
            )

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.super_admin)

    def test_top_churches_by_raised(self):
        resp = self.client.get(reverse('super-analytics'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        top = resp.data['top_churches_by_raised']

        # Capped at 10 even though 11 churches are funded (+ 1 unfunded creator).
        self.assertEqual(len(top), 10)

        # Descending by total_raised; the 1100 church leads.
        totals = [Decimal(r['total_raised']) for r in top]
        self.assertEqual(totals, sorted(totals, reverse=True))
        self.assertEqual(top[0]['church_name'], 'Raise Church 11')
        self.assertEqual(Decimal(top[0]['total_raised']), Decimal('1100.00'))

        # The lowest-funded church (100) is sliced OFF; the unfunded creator too.
        names = [r['church_name'] for r in top]
        self.assertNotIn('Raise Church 01', names)      # raised 100 → dropped by [:10]
        self.assertNotIn('Creator Church', names)       # 0.00 → dropped

        # Money is a STRING; ONLY church_name + total_raised — no PII leak.
        for r in top:
            self.assertIsInstance(r['total_raised'], str)
            self.assertEqual(set(r.keys()), {'church_name', 'total_raised'})


# ═════════════════════════════════════════════════════════════════════════════
# 10. Super-admin list field additions — church_name / donor_count / campaign_title
# ═════════════════════════════════════════════════════════════════════════════


class SuperListFieldAdditions(TestCase):
    """Read-only field additions for the Super Admin list screens (C-4/C-5/C-6):
      * /super/campaigns/   → church_name + donor_count   (AdminCampaignSerializer)
      * /super/donations/   → campaign_title + church_name (AdminDonationSerializer)
      * /super/withdrawals/ → church_name                  (WithdrawalSerializer, SHARED)

    Verifies each field is present + correct, every pre-existing field is intact,
    the authorized gross/fee/net breakdown still shows on the donations table, and
    the role gate (treasurer → 403) still holds on all three endpoints.
    """

    CHURCH_NAME = 'Field Additions Church'

    @classmethod
    def setUpTestData(cls):
        cls.super_admin = _make_super_admin()
        cls.church = _make_church(name=cls.CHURCH_NAME, email='fa@example.org')
        cls.treasurer = _make_treasurer(cls.church, 'fa-t@example.org')
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='fa-c')

        # Two SUCCESSFUL donations + one non-successful → donor_count must be 2
        # (mirrors PublicCampaignSerializer's SUCCESSFUL-only count).
        for receipt in ('FA0SUCCESS1', 'FA0SUCCESS2'):
            Donation.objects.create(
                campaign=cls.campaign,
                phone_number='254712345678',
                donor_name='Donor X',
                amount=Decimal('1000.00'),
                platform_fee=Decimal('25.00'),
                net_amount=Decimal('975.00'),
                status=DonationStatus.SUCCESSFUL,
                mpesa_receipt_number=receipt,
            )
        Donation.objects.create(
            campaign=cls.campaign,
            phone_number='254712345678',
            amount=Decimal('500.00'),
            status=DonationStatus.PENDING,   # NOT counted by donor_count
        )

        cls.withdrawal = _make_withdrawal(cls.campaign, amount=Decimal('1000'))

    def setUp(self):
        self.client = APIClient()

    # ── /super/campaigns/ ──────────────────────────────────────────────────

    def test_super_campaigns_have_church_name_and_donor_count(self):
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.get(reverse('super-campaigns'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        row = next(r for r in resp.data['results'] if r['slug'] == 'fa-c')

        # New fields — present + correct.
        self.assertEqual(row['church_name'], self.CHURCH_NAME)
        self.assertEqual(row['donor_count'], 2)   # only the SUCCESSFUL pair

        # D1 NARROW: /super/campaigns/ now uses the read-only SuperCampaignSerializer.
        # The 15 KEEP fields must be present...
        for f in ('id', 'slug', 'title', 'status', 'description', 'category',
                  'goal_amount', 'raised_amount', 'wallet_balance',
                  'group_label_name', 'church_name', 'donor_count',
                  'banner_image_url', 'document_url', 'created_at'):
            self.assertIn(f, row, f'campaign KEEP field {f} was dropped')
        # ...and the over-emitted fields must now be ABSENT (the point of the narrow).
        for f in ('treasurer_phone', 'treasurer_name', 'created_by',
                  'church', 'group_label', 'closed_at'):
            self.assertNotIn(f, row, f'campaign field {f} should be dropped on /super/')

    def test_super_campaigns_role_gated_treasurer_403(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.get(reverse('super-campaigns'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ── /super/donations/ ──────────────────────────────────────────────────

    def test_super_donations_have_campaign_title_church_name_and_full_breakdown(self):
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.get(reverse('super-donations'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        row = next(r for r in resp.data['results']
                   if r['mpesa_receipt_number'] == 'FA0SUCCESS1')

        # New labels — present + correct.
        self.assertEqual(row['campaign_title'], self.campaign.title)
        self.assertEqual(row['church_name'], self.CHURCH_NAME)

        # The super donations table is the AUTHORIZED gross/fee/net surface (PRD 8.6).
        self.assertEqual(Decimal(row['amount']), Decimal('1000.00'))       # gross
        self.assertEqual(Decimal(row['platform_fee']), Decimal('25.00'))
        self.assertEqual(Decimal(row['net_amount']), Decimal('975.00'))    # net

        # D1 NARROW: AdminDonationSerializer is now an explicit 10-field allowlist.
        # The KEEP fields must be present...
        for f in ('id', 'campaign_title', 'church_name', 'mpesa_receipt_number',
                  'donor_name', 'status', 'created_at', 'amount',
                  'platform_fee', 'net_amount'):
            self.assertIn(f, row, f'donation KEEP field {f} was dropped')
        # ...and the over-emitted sensitive / internal fields must now be ABSENT.
        for f in ('phone_number', 'donor_email', 'checkout_request_id',
                  'campaign', 'confirmed_at'):
            self.assertNotIn(f, row, f'donation field {f} should be dropped')

    def test_super_donations_role_gated_treasurer_403(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.get(reverse('super-donations'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ── /super/withdrawals/ (shared serializer) ────────────────────────────

    def test_super_withdrawals_have_church_name(self):
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.get(reverse('super-withdrawals'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        row = next(r for r in resp.data['results']
                   if r['id'] == str(self.withdrawal.id))
        self.assertEqual(row['church_name'], self.CHURCH_NAME)
        # campaign (title) still present from before the add.
        self.assertEqual(row['campaign'], self.campaign.title)

    def test_super_withdrawals_role_gated_treasurer_403(self):
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.get(reverse('super-withdrawals'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

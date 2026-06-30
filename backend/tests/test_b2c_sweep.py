"""Step 2.10c — B2C stranded-withdrawal escalation sweep (A2 escalate-only rebuild).

The sweep is now escalate-only: stale PROCESSING / AMBIGUOUS-FAILED rows are frozen
to NEEDS_RECONCILIATION (Super-Admin alert + audit) for manual reconciliation. It does
NOT query Daraja, finalize, or re-dispatch — the active Transaction Status query was
wire-disproven (it can't locate an unconfirmed payout; see §14.1 "DISPROVEN 2026-06-07")
and was deleted along with redispatch_withdrawal. Every test drives the real escalate
function / management command and asserts ground-truth row state, alerts, and audit.
"""

from datetime import timedelta
from decimal import Decimal
from io import StringIO
from unittest.mock import patch

from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from accounts.utils import hash_token
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from integrations import daraja
from notifications.models import Notification, NotificationType
from treasurer_portal.models import PortalToken
from withdrawals.models import (
    BLOCKING_WITHDRAWAL_STATUSES,
    Withdrawal,
    WithdrawalDispatchOutcome,
    WithdrawalStatus,
)
from withdrawals.tasks import run_stranded_withdrawal_sweep


NORMALIZED_PHONE = '254712345678'


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_church(status_=ChurchStatus.ACTIVE, email='c@example.org', name='Church'):
    return Church.objects.create(
        name=name, official_email=email, phone='254700000001', address='addr',
        county='Nairobi', denomination='PCEA', status=status_,
    )


def _make_treasurer(church, email='t@example.org'):
    return User.objects.create_user(
        email=email, password='unused', first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _make_super_admin(email='admin@pamoja.example'):
    return User.objects.create_user(
        email=email, password='unused', first_name='S', last_name='A',
        role=UserRole.SUPER_ADMIN, church=None,
    )


def _make_campaign(church, treasurer, *, slug='c1', wallet=Decimal('5000')):
    return Campaign.objects.create(
        slug=slug, church=church, title=f'Campaign {slug}', description='desc',
        goal_amount=Decimal('1000000'), raised_amount=Decimal('5000'),
        wallet_balance=wallet, banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING, treasurer_phone='254712345678',
        treasurer_name='Treas Urer', created_by=treasurer,
        status=CampaignStatus.ACTIVE,
    )


def _make_withdrawal(campaign, **kw):
    defaults = dict(
        requested_by_phone=NORMALIZED_PHONE,
        destination_phone='254712345678', destination_name='Treas Urer',
        amount=Decimal('1000'), reason='materials',
        status=WithdrawalStatus.PROCESSING,
    )
    defaults.update(kw)
    return Withdrawal.objects.create(campaign=campaign, **defaults)


def _make_stale(wd, minutes=60):
    """Backdate updated_at past the staleness threshold (bypasses auto_now)."""
    Withdrawal.objects.filter(id=wd.id).update(
        updated_at=timezone.now() - timedelta(minutes=minutes))


# ═════════════════════════════════════════════════════════════════════════════
# Escalate-only sweep — stale strands freeze to NEEDS_RECONCILIATION, NO Daraja
# ═════════════════════════════════════════════════════════════════════════════


class EscalateOnlySweepTests(TestCase):
    def setUp(self):
        cache.clear()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        self.super_admin = _make_super_admin()
        self.campaign = _make_campaign(self.church, self.treasurer, wallet=Decimal('1000'))

    def _stale(self, **kw):
        wd = _make_withdrawal(self.campaign, **kw)
        _make_stale(wd)
        return wd

    def test_clean_strand_escalates_to_needs_reconciliation(self):
        # PROCESSING with NO conversation_id and NO dispatch marker — a clean strand.
        # (Reframed from the old "status-queried, not re-dispatched" test: there is no
        # query now; a stale strand escalates directly.)
        wd = self._stale(b2c_conversation_id=None, dispatch_outcome=None,
                         originator_conversation_id='pmj-orig-1')
        with patch.object(daraja, 'DarajaClient') as mock_dc:
            run_stranded_withdrawal_sweep(staleness_minutes=0)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)
        # Escalate-only: Daraja is never touched.
        self.assertFalse(mock_dc.called)

    def test_ambiguous_marker_escalates_to_needs_reconciliation(self):
        # 2.10a ambiguous dispatch failure (FAILED + AMBIGUOUS_FAILURE). Reframed from
        # "marker alone does not redispatch, status-query decides": now escalates directly.
        wd = self._stale(status=WithdrawalStatus.FAILED,
                         dispatch_outcome=WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE,
                         b2c_conversation_id=None, originator_conversation_id='pmj-amb')
        with patch.object(daraja, 'DarajaClient') as mock_dc:
            run_stranded_withdrawal_sweep(staleness_minutes=0)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)
        self.assertFalse(mock_dc.called)

    def test_persistent_strand_escalates_with_super_admin_alert(self):
        # Reframed from "persistent INCONCLUSIVE → NEEDS_RECONCILIATION + alert": same
        # outcome, no query. Keeps the alert + audit assertions.
        wd = self._stale(originator_conversation_id='pmj-orig')
        run_stranded_withdrawal_sweep(staleness_minutes=0)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)
        alert = Notification.objects.filter(
            recipient=self.super_admin, related_withdrawal=wd).first()
        self.assertIsNotNone(alert)
        self.assertIn('pmj-orig', alert.message)  # lookup handle in the alert
        self.assertTrue(AuditLog.objects.filter(
            action='WITHDRAWAL_NEEDS_RECONCILIATION', entity_id=wd.id).exists())

    def test_fresh_row_not_escalated(self):
        # Staleness filter still gates: a row updated just now is NOT a candidate
        # at the default 15-minute threshold.
        wd = _make_withdrawal(self.campaign)  # updated_at = now
        run_stranded_withdrawal_sweep()  # default staleness
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PROCESSING)

    def test_escalate_only_never_instantiates_daraja_GREEN(self):
        # GREEN counterpart of the SEEN-FAILING-FIRST RED witness (the old query-driven
        # sweep instantiated DarajaClient; this escalate-only one must not).
        wd = self._stale(originator_conversation_id='pmj-x')
        with patch.object(daraja, 'DarajaClient') as mock_dc:
            escalated = run_stranded_withdrawal_sweep(staleness_minutes=0)
        self.assertEqual(escalated, 1)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)
        self.assertFalse(
            mock_dc.called,
            'escalate-only invariant: the sweep must NOT instantiate DarajaClient')

    def test_already_resolved_row_left_alone_under_lock(self):
        # A row that a real callback resolved between selection and lock fails the
        # _is_still_candidate recheck and is left untouched (no double-escalation).
        paid = self._stale(status=WithdrawalStatus.PAID)
        run_stranded_withdrawal_sweep(staleness_minutes=0)
        paid.refresh_from_db()
        self.assertEqual(paid.status, WithdrawalStatus.PAID)


# ═════════════════════════════════════════════════════════════════════════════
# Management command (the A2 trigger) — escalates, reports, safe to re-run
# ═════════════════════════════════════════════════════════════════════════════


class SweepCommandTests(TestCase):
    def setUp(self):
        cache.clear()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        self.super_admin = _make_super_admin()
        self.campaign = _make_campaign(self.church, self.treasurer, wallet=Decimal('1000'))

    def test_command_escalates_reports_and_is_idempotent(self):
        wd = _make_withdrawal(self.campaign, originator_conversation_id='pmj-cmd')
        _make_stale(wd)

        out = StringIO()
        call_command('sweep_stranded_withdrawals', '--staleness-minutes', '0', stdout=out)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)
        printed = out.getvalue()
        self.assertIn('Escalated 1', printed)
        # Dev-default-settings defense: settings module + DB name printed at startup.
        self.assertIn('settings=', printed)
        self.assertIn('DB=', printed)

        # Re-run: the row is already escalated → not a candidate → 0 escalated.
        out2 = StringIO()
        call_command('sweep_stranded_withdrawals', '--staleness-minutes', '0', stdout=out2)
        self.assertIn('Escalated 0', out2.getvalue())
        # And exactly one escalation audit row across both runs.
        self.assertEqual(
            AuditLog.objects.filter(
                action='WITHDRAWAL_NEEDS_RECONCILIATION', entity_id=wd.id).count(),
            1)


# ═════════════════════════════════════════════════════════════════════════════
# NEEDS_RECONCILIATION — blocking, no force-retry, resolve-paid / resolve-retry
# ═════════════════════════════════════════════════════════════════════════════


class NeedsReconciliationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        self.super_admin = _make_super_admin()
        self.campaign = _make_campaign(self.church, self.treasurer, wallet=Decimal('5000'))
        self.client = APIClient()

    def _needs_recon_wd(self, **kw):
        return _make_withdrawal(
            self.campaign, status=WithdrawalStatus.NEEDS_RECONCILIATION,
            amount=Decimal('1000'), originator_conversation_id='pmj-nr', **kw)

    def test_membership_in_blocking_set(self):
        self.assertIn(WithdrawalStatus.NEEDS_RECONCILIATION, BLOCKING_WITHDRAWAL_STATUSES)
        self.assertNotIn(WithdrawalStatus.FAILED_FINAL, BLOCKING_WITHDRAWAL_STATUSES)

    def test_needs_reconciliation_blocks_new_disbursement_request(self):
        self._needs_recon_wd()
        raw = 'demo-' + 'tok123456'
        PortalToken.objects.create(
            phone_number=NORMALIZED_PHONE, campaign_ids=[str(self.campaign.id)],
            ip_address='10.0.0.42', token_hash=hash_token(raw),
            expires_at=timezone.now() + timedelta(minutes=30),
        )
        resp = self.client.post(
            reverse('portal-request-disbursement', kwargs={'id': self.campaign.id}),
            {'amount': '100', 'reason': 'new'}, format='json',
            HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('reconcil', resp.data['detail'].lower())
        # No second withdrawal created.
        self.assertEqual(Withdrawal.objects.filter(campaign=self.campaign).count(), 1)

    def test_no_force_retry_path_from_needs_reconciliation(self):
        wd = self._needs_recon_wd()
        self.client.force_authenticate(user=self.super_admin)
        resp = self.client.post(reverse('super-withdrawal-force-retry', args=[wd.id]))
        # force-retry only acts on FAILED_FINAL → 400 here.
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)

    def test_resolve_paid_only_from_needs_reconciliation(self):
        # From a non-NEEDS_RECONCILIATION row → 400 (status gate).
        processing = _make_withdrawal(self.campaign, status=WithdrawalStatus.PROCESSING)
        self.client.force_authenticate(user=self.super_admin)
        bad = self.client.post(
            reverse('super-withdrawal-resolve-paid', args=[processing.id]),
            {'payout_reference': 'XREF001'},
            format='json',
        )
        self.assertEqual(bad.status_code, status.HTTP_400_BAD_REQUEST)

        wd = self._needs_recon_wd()
        before = self.campaign.wallet_balance
        ok = self.client.post(
            reverse('super-withdrawal-resolve-paid', args=[wd.id]),
            {'payout_reference': 'XREF_OK_001'},
            format='json',
        )
        self.assertEqual(ok.status_code, status.HTTP_200_OK, ok.content)
        wd.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PAID)
        self.assertEqual(wd.payout_reference, 'XREF_OK_001')
        self.assertEqual(self.campaign.wallet_balance, before - Decimal('1000'))
        self.assertTrue(AuditLog.objects.filter(
            action='WITHDRAWAL_RESOLVED_PAID', entity_id=wd.id).exists())
        self.assertTrue(AuditLog.objects.filter(
            action='WITHDRAWAL_PAID', entity_id=wd.id).exists())

    def test_resolve_retry_only_from_needs_reconciliation(self):
        paid = _make_withdrawal(self.campaign, status=WithdrawalStatus.PAID)
        self.client.force_authenticate(user=self.super_admin)
        bad = self.client.post(reverse('super-withdrawal-resolve-retry', args=[paid.id]))
        self.assertEqual(bad.status_code, status.HTTP_400_BAD_REQUEST)

        wd = self._needs_recon_wd(retry_count=3)
        ok = self.client.post(reverse('super-withdrawal-resolve-retry', args=[wd.id]))
        self.assertEqual(ok.status_code, status.HTTP_200_OK, ok.content)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.FAILED)
        self.assertEqual(wd.dispatch_outcome, WithdrawalDispatchOutcome.CLEAN_FAILURE)
        self.assertEqual(wd.retry_count, 0)  # fresh budget — no in-flight payout
        self.assertTrue(AuditLog.objects.filter(
            action='WITHDRAWAL_RESOLVED_RETRY', entity_id=wd.id).exists())


# ═════════════════════════════════════════════════════════════════════════════
# FAILED → FAILED_FINAL escalation (B2C result callback) + freeze semantics
# ═════════════════════════════════════════════════════════════════════════════


class EscalationAndFreezeSemanticsTests(TestCase):
    def setUp(self):
        cache.clear()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        self.campaign = _make_campaign(self.church, self.treasurer, wallet=Decimal('5000'))
        self.client = APIClient()

    def _result_callback(self, conversation_id, result_code):
        return self.client.post(
            reverse('withdrawal-b2c-result'),
            {'Result': {'ConversationID': conversation_id, 'ResultCode': result_code,
                        'TransactionID': 'NLJX'}},
            format='json',
        )

    def test_failure_callback_at_retry_exhaustion_escalates_to_failed_final(self):
        wd = _make_withdrawal(self.campaign, status=WithdrawalStatus.PROCESSING,
                              b2c_conversation_id='AG_ESC', retry_count=5)
        resp = self._result_callback('AG_ESC', 1)  # 1 = failure
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.FAILED_FINAL)

    def test_failure_callback_below_exhaustion_goes_failed(self):
        wd = _make_withdrawal(self.campaign, status=WithdrawalStatus.PROCESSING,
                              b2c_conversation_id='AG_FAIL', retry_count=2)
        resp = self._result_callback('AG_FAIL', 1)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.FAILED)

    def test_failed_final_is_non_blocking_needs_reconciliation_is_blocking(self):
        # FAILED_FINAL must NOT block a new disbursement request.
        _make_withdrawal(self.campaign, status=WithdrawalStatus.FAILED_FINAL,
                         retry_count=5)
        raw = 'demo-' + 'tokfinal01'
        PortalToken.objects.create(
            phone_number=NORMALIZED_PHONE, campaign_ids=[str(self.campaign.id)],
            ip_address='10.0.0.42', token_hash=hash_token(raw),
            expires_at=timezone.now() + timedelta(minutes=30),
        )
        resp = self.client.post(
            reverse('portal-request-disbursement', kwargs={'id': self.campaign.id}),
            {'amount': '100', 'reason': 'after final'}, format='json',
            HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.42',
        )
        # Allowed (201) — FAILED_FINAL is terminal/non-blocking.
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)

    def test_success_callback_finalizes_paid_idempotently(self):
        self.campaign.wallet_balance = Decimal('1000')
        self.campaign.save(update_fields=['wallet_balance'])
        wd = _make_withdrawal(self.campaign, status=WithdrawalStatus.PROCESSING,
                              b2c_conversation_id='AG_PAY', amount=Decimal('1000'))
        r1 = self._result_callback('AG_PAY', 0)
        self.assertEqual(r1.status_code, status.HTTP_200_OK)
        wd.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PAID)
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))

        # Duplicate success callback (Safaricom retry) — no double decrement.
        r2 = self._result_callback('AG_PAY', 0)
        self.assertEqual(r2.status_code, status.HTTP_200_OK)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))
        self.assertEqual(
            AuditLog.objects.filter(action='WITHDRAWAL_PAID', entity_id=wd.id).count(), 1)

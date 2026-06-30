"""Reconciliation money-path: a B2C *result* callback must NOT auto-finalize a
row that is being held for manual reconciliation (NEEDS_RECONCILIATION).

Three gates (single-actor; they hit the REAL b2c-result endpoint and the REAL
resolve-paid view, never internals bare):

  GATE A — the (3) hole: a SUCCESS callback on a NEEDS_RECONCILIATION row records
           the M-Pesa confirmation (receipt + audit + Super-Admin alert) but does
           NOT pay it (status stays NEEDS_RECONCILIATION, wallet unchanged).
  GATE B — divergent-sets guard: resolve-paid still finalizes a NEEDS_RECONCILIATION
           row (proves the finalize guard was NOT widened to that status).
  GATE C — receipt lands end-to-end: success callback persists the receipt, then
           resolve-paid carries it onto the PAID row (payout_reference not null).

These distinguish three predicates that all read `status` but must stay divergent:
the callback ignored-set (now includes NEEDS_RECONCILIATION), the finalize guard
(== PAID only), and the sweep recheck door.
"""

from decimal import Decimal

from django.test import TestCase
from django.urls import reverse
from rest_framework import status as http_status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from notifications.models import Notification, NotificationType
from withdrawals.models import Withdrawal, WithdrawalStatus


RECON_PAYMENT_CONFIRMED_ACTION = 'WITHDRAWAL_RECONCILIATION_PAYMENT_CONFIRMED'


class ReconciliationFinalizeTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            email='recon-admin@example.org', password='unused', first_name='S',
            last_name='A', role=UserRole.SUPER_ADMIN, church=None,
        )
        self.church = Church.objects.create(
            name='Recon Church', official_email='recon@example.org',
            phone='254700000001', address='addr', county='Nairobi',
            denomination='PCEA', status=ChurchStatus.ACTIVE,
        )
        self.treasurer = User.objects.create_user(
            email='recon-treas@example.org', password='unused', first_name='F',
            last_name='L', role=UserRole.CHURCH_TREASURER, church=self.church,
        )
        self.campaign = Campaign.objects.create(
            slug='recon-c1', church=self.church, title='Recon Campaign',
            description='desc', goal_amount=Decimal('1000000'),
            raised_amount=Decimal('1000'), wallet_balance=Decimal('1000'),
            banner_image_url='https://example.org/x.png',
            category=CampaignCategory.BUILDING, treasurer_phone='254712345678',
            treasurer_name='Treas Urer', created_by=self.treasurer,
            status=CampaignStatus.ACTIVE,
        )

    def _make_recon_withdrawal(self, conv_id='AG_TEST_CONV'):
        return Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone='254712345678',
            destination_phone='254712345678', destination_name='Treas Urer',
            amount=Decimal('100'), reason='materials',
            status=WithdrawalStatus.NEEDS_RECONCILIATION,
            b2c_conversation_id=conv_id,
        )

    def _post_success_callback(self, conv_id, transaction_id):
        return self.client.post(
            reverse('withdrawal-b2c-result'),
            {'Result': {
                'ConversationID': conv_id,
                'ResultCode': 0,
                'TransactionID': transaction_id,
            }},
            format='json',
        )

    # ── GATE A ──────────────────────────────────────────────────────────────
    def test_gate_a_success_callback_on_reconciliation_records_not_pays(self):
        wd = self._make_recon_withdrawal(conv_id='AG_A')
        resp = self._post_success_callback('AG_A', 'UFREC123')
        self.assertEqual(resp.status_code, http_status.HTTP_200_OK, resp.content)

        wd.refresh_from_db()
        self.campaign.refresh_from_db()
        # NOT auto-paid — held for a human.
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)
        # Wallet UNTOUCHED.
        self.assertEqual(self.campaign.wallet_balance, Decimal('1000'))
        # Receipt persisted.
        self.assertEqual(wd.payout_reference, 'UFREC123')
        # Exactly one confirmation audit row.
        self.assertEqual(
            AuditLog.objects.filter(
                action=RECON_PAYMENT_CONFIRMED_ACTION,
                entity_type='Withdrawal', entity_id=wd.id,
            ).count(),
            1,
        )
        # Exactly one Super-Admin notification (the row was created directly in
        # NEEDS_RECONCILIATION, so there is no prior reconciliation alert), carrying
        # the dedicated reconciliation-payment-confirmed type (see Gate A2).
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.admin,
                notification_type=NotificationType.RECONCILIATION_PAYMENT_CONFIRMED,
                related_withdrawal=wd,
            ).count(),
            1,
        )
        # And specifically NOT the church-treasurer 'paid' notification.
        self.assertFalse(
            Notification.objects.filter(
                notification_type=NotificationType.DISBURSEMENT_PAID,
                related_withdrawal=wd,
            ).exists()
        )

    def test_gate_a2_payment_confirmed_notification_is_typed_not_a_failure(self):
        """The Super-Admin alert for a confirmed payment on a reconciliation row
        must carry its OWN type, never DISBURSEMENT_FAILED. This asserts the TYPE
        (not just existence) — the exact thing whose absence let the mistype ship:
        a CONFIRMED SUCCESS must never again be typed as a failure."""
        wd = self._make_recon_withdrawal(conv_id='AG_A2')
        resp = self._post_success_callback('AG_A2', 'UFREC222')
        self.assertEqual(resp.status_code, http_status.HTTP_200_OK, resp.content)

        notif = Notification.objects.get(
            recipient=self.admin, related_withdrawal=wd,
        )
        self.assertEqual(
            notif.notification_type,
            NotificationType.RECONCILIATION_PAYMENT_CONFIRMED,
        )
        # Anti-regression: the event must never again be typed as a failure.
        self.assertNotEqual(
            notif.notification_type, NotificationType.DISBURSEMENT_FAILED,
        )

    # ── GATE B ──────────────────────────────────────────────────────────────
    def test_gate_b_resolve_paid_finalizes_reconciliation_row(self):
        wd = self._make_recon_withdrawal()
        self.client.force_authenticate(user=self.admin)
        resp = self.client.post(
            reverse('super-withdrawal-resolve-paid', args=[wd.id]),
            {'payout_reference': 'GATE_B_REF01'},
            format='json',
        )
        self.assertEqual(resp.status_code, http_status.HTTP_200_OK, resp.content)

        wd.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PAID)
        self.assertEqual(self.campaign.wallet_balance, Decimal('900'))
        self.assertEqual(wd.payout_reference, 'GATE_B_REF01')

    # ── GATE C ──────────────────────────────────────────────────────────────
    def test_gate_c_receipt_lands_end_to_end(self):
        wd = self._make_recon_withdrawal(conv_id='AG_C')
        # 1) success callback persists the receipt on the held row
        cb = self._post_success_callback('AG_C', 'UFREC999')
        self.assertEqual(cb.status_code, http_status.HTTP_200_OK, cb.content)
        # 2) Super-Admin resolves it paid, supplying the same reference they see
        self.client.force_authenticate(user=self.admin)
        rp = self.client.post(
            reverse('super-withdrawal-resolve-paid', args=[wd.id]),
            {'payout_reference': 'UFREC999'},
            format='json',
        )
        self.assertEqual(rp.status_code, http_status.HTTP_200_OK, rp.content)

        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PAID)
        # The receipt from the body lands on the PAID row.
        self.assertEqual(wd.payout_reference, 'UFREC999')

    # ── PAID-without-receipt guard (resolve-paid now requires a reference) ──
    def test_resolve_paid_without_reference_is_rejected(self):
        """resolve-paid now requires a payout_reference in the body. A missing or
        blank reference must 400 field-keyed BEFORE the DB write — the row stays
        NEEDS_RECONCILIATION and the wallet is untouched. The
        WITHDRAWAL_RESOLVED_WITHOUT_REFERENCE audit branch is kept in the code but
        is unreachable through this view (reference is always present on a 200)."""
        wd = self._make_recon_withdrawal(conv_id='AG_NOREF')
        self.assertIsNone(wd.payout_reference)
        self.client.force_authenticate(user=self.admin)
        wallet_before = self.campaign.wallet_balance

        # No body → field-keyed 400.
        resp = self.client.post(reverse('super-withdrawal-resolve-paid', args=[wd.id]))
        self.assertEqual(resp.status_code, http_status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn('payout_reference', resp.data)

        # Blank value → field-keyed 400.
        resp_blank = self.client.post(
            reverse('super-withdrawal-resolve-paid', args=[wd.id]),
            {'payout_reference': ''},
            format='json',
        )
        self.assertEqual(resp_blank.status_code, http_status.HTTP_400_BAD_REQUEST)
        self.assertIn('payout_reference', resp_blank.data)

        # Row and wallet untouched after both bad calls.
        wd.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.NEEDS_RECONCILIATION)
        self.assertIsNone(wd.payout_reference)
        self.assertEqual(self.campaign.wallet_balance, wallet_before)
        # No audit entries written for this row.
        self.assertFalse(AuditLog.objects.filter(entity_id=wd.id).exists())

    def test_resolve_paid_with_reference_does_not_emit_marker(self):
        """resolve-paid with a supplied reference finalizes PAID with that reference
        stored — the WITHDRAWAL_RESOLVED_WITHOUT_REFERENCE marker must NOT fire
        (reference is always present on a valid resolve-paid call)."""
        wd = self._make_recon_withdrawal(conv_id='AG_HASREF')
        cb = self._post_success_callback('AG_HASREF', 'UFHASREF1')
        self.assertEqual(cb.status_code, http_status.HTTP_200_OK, cb.content)
        wd.refresh_from_db()
        self.assertEqual(wd.payout_reference, 'UFHASREF1')  # persisted by the callback

        self.client.force_authenticate(user=self.admin)
        resp = self.client.post(
            reverse('super-withdrawal-resolve-paid', args=[wd.id]),
            {'payout_reference': 'UFHASREF1'},
            format='json',
        )
        self.assertEqual(resp.status_code, http_status.HTTP_200_OK, resp.content)

        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PAID)
        self.assertEqual(wd.payout_reference, 'UFHASREF1')
        # Reference present → the no-reference marker must NOT fire.
        self.assertFalse(
            AuditLog.objects.filter(
                action='WITHDRAWAL_RESOLVED_WITHOUT_REFERENCE',
                entity_id=wd.id,
            ).exists()
        )

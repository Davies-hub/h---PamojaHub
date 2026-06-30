"""Slice 3a — subscription payment: initiate endpoint (model + STK push ONLY).

These tests prove the VIEW logic, not Daraja: every test patches
DarajaClient.stk_push at the seam (canned ACK dict, or raises STKPushError), so
nothing hits the network.

The contract under test (POST /api/v1/subscriptions/initiate/):
  * treasurer-only (IsChurchTreasurer) — donor/AllowAny and non-treasurer denied;
  * target tier ∈ {GROWTH, PARISH}; FREE-as-target rejected;
  * price read LIVE from PlatformSettings at INITIATE and stored on the row;
  * one in-flight renewal per church (PENDING younger than the STK timeout blocks),
    but a stale PENDING (older than the timeout) does NOT block;
  * INITIATE GRANTS NOTHING — church.subscription_tier / subscription_expires_at
    are never touched here;
  * STKPushError → 502, row left PENDING with checkout_request_id NULL (mirrors
    the donation 502 un-correlatable orphan).

RED proof (3a STEP 3): the endpoint does not exist yet, so reverse() /
the POST fails — that is the seen-failing-first evidence.
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from audit.models import AuditLog
from churches.models import (
    REMINDER_STAGE_1D,
    REMINDER_STAGE_NONE,
    Church,
    ChurchStatus,
    SubscriptionPayment,
    SubscriptionPaymentStatus,
    SubscriptionTier,
)
from churches.tasks import run_subscription_lapses, run_subscription_reminders
from integrations.daraja import DarajaClient, STKPushError
from superadmin.models import PlatformSettings


# Canned STK ACK the seam returns — never the network.
_FAKE_ACK = {'checkout_request_id': 'ws_CO_test_001', 'merchant_request_id': 'mr-test-001'}


def _make_church(*, status_=ChurchStatus.ACTIVE, email='sub@example.org'):
    return Church.objects.create(
        name='Sub Church', official_email=email, phone='254700000001',
        address='addr', county='Nairobi', denomination='PCEA', status=status_,
    )


def _make_treasurer(church, *, email='sub-treasurer@example.org',
                    phone='254712345678', role=UserRole.CHURCH_TREASURER):
    return User.objects.create_user(
        email=email, password='UnusedForTest!', first_name='F', last_name='L',
        role=role, church=church, phone=phone,
    )


def _stk_ok():
    """Patch DarajaClient.stk_push to return the canned ACK."""
    return patch.object(DarajaClient, 'stk_push', return_value=_FAKE_ACK)


def _stk_fail():
    """Patch DarajaClient.stk_push to raise STKPushError (initiate failure)."""
    return patch.object(DarajaClient, 'stk_push',
                        side_effect=STKPushError('boom'))


def _pending_payment(church, *, tier=SubscriptionTier.GROWTH,
                     amount=Decimal('999.00'), checkout='ws_CO_cb_001'):
    """A PENDING SubscriptionPayment with a known checkout_request_id to drive callbacks."""
    return SubscriptionPayment.objects.create(
        church=church, tier=tier, amount=amount, phone_number='254712345678',
        status=SubscriptionPaymentStatus.PENDING, checkout_request_id=checkout,
    )


def _sub_callback_body(checkout_id, *, result_code=0, receipt='SUBRCPT01', amount=999):
    """Safaricom-shaped STK callback body (matches DonationCallbackView's parsed shape).

    HERMETIC: this hand-built body proves the confirm→extend coupling, NOT the live
    parse — capturing a real success callback on the wire is the close-later gate.

    `amount` must equal the charged price (the callback echoes the exact STK amount);
    the callback now refuses to grant on an amount mismatch, so parish tests pass 2499.
    """
    stk = {
        'MerchantRequestID': 'mr-sub-1',
        'CheckoutRequestID': checkout_id,
        'ResultCode': result_code,
        'ResultDesc': 'desc',
    }
    if result_code == 0:
        stk['CallbackMetadata'] = {'Item': [
            {'Name': 'Amount', 'Value': amount},
            {'Name': 'MpesaReceiptNumber', 'Value': receipt},
            {'Name': 'PhoneNumber', 'Value': 254712345678},
        ]}
    return {'Body': {'stkCallback': stk}}


class SubscriptionInitiateTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        # Ensure a known live price baseline.
        ps = PlatformSettings.load()
        ps.growth_price = Decimal('999.00')
        ps.parish_price = Decimal('2499.00')
        ps.save()

    def _url(self):
        return reverse('subscription-initiate')

    def _initiate(self, user=None, *, phone_number='254712345678', **body):
        # phone_number is now REQUIRED by the contract (no User.phone fallback). The
        # helper injects a valid default so the tier/price/in-flight/down-pay tests
        # below stay focused on their own concern; pass phone_number=None to omit the
        # field entirely (the requires-phone test) or '' for the blank-phone test.
        if user is not None:
            self.client.force_authenticate(user=user)
        if phone_number is not None:
            body['phone_number'] = phone_number
        return self.client.post(self._url(), body, format='json')

    # ── happy path ─────────────────────────────────────────────────────────────
    def test_treasurer_can_initiate_growth(self):
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)

        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['status'], SubscriptionPaymentStatus.PENDING)
        self.assertIn('subscription_payment_id', resp.data)
        self.assertEqual(resp.data['checkout_request_id'], 'ws_CO_test_001')

        payments = SubscriptionPayment.objects.filter(church=self.church)
        self.assertEqual(payments.count(), 1)
        pay = payments.get()
        self.assertEqual(pay.status, SubscriptionPaymentStatus.PENDING)
        self.assertEqual(pay.tier, SubscriptionTier.GROWTH)
        self.assertEqual(pay.amount, PlatformSettings.load().growth_price)
        self.assertEqual(pay.checkout_request_id, 'ws_CO_test_001')

        # INITIATE GRANTS NOTHING — church tier/expiry untouched.
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(self.church.subscription_expires_at)

    def test_initiate_reads_price_live(self):
        ps = PlatformSettings.load()
        ps.growth_price = Decimal('1234.00')
        ps.save()

        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)

        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        pay = SubscriptionPayment.objects.get(church=self.church)
        self.assertEqual(pay.amount, Decimal('1234.00'))

    def test_initiate_parish_uses_parish_price(self):
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.PARISH)

        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        pay = SubscriptionPayment.objects.get(church=self.church)
        self.assertEqual(pay.tier, SubscriptionTier.PARISH)
        self.assertEqual(pay.amount, PlatformSettings.load().parish_price)

    # ── phone is REQUIRED, no User.phone fallback (this slice) ───────────────────
    def test_initiate_requires_phone(self):
        """No phone_number in the body → 400, NO row. (Currently the silent User.phone
        fallback turns this into a 200 + PENDING row — the leak being closed.)"""
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH,
                                  phone_number=None)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertEqual(SubscriptionPayment.objects.count(), 0)

    def test_initiate_rejects_blank_phone(self):
        """An empty/invalid phone → 400, NO row (no fallback to the treasurer's own)."""
        with _stk_ok():
            blank = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH,
                                   phone_number='')
        self.assertEqual(blank.status_code, status.HTTP_400_BAD_REQUEST, blank.content)

        with _stk_ok():
            bad = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH,
                                 phone_number='12345')
        self.assertEqual(bad.status_code, status.HTTP_400_BAD_REQUEST, bad.content)

        self.assertEqual(SubscriptionPayment.objects.count(), 0)

    def test_initiate_accepts_valid_phone(self):
        """A valid (07xx) phone → 200, normalized to 254XXXXXXXXX and stored on the row,
        independent of the treasurer's own User.phone."""
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH,
                                  phone_number='0723456789')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        pay = SubscriptionPayment.objects.get(church=self.church)
        self.assertEqual(pay.phone_number, '254723456789')

    # ── rejections ─────────────────────────────────────────────────────────────
    def test_free_target_rejected(self):
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.FREE)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertEqual(SubscriptionPayment.objects.count(), 0)

    def test_non_treasurer_rejected(self):
        super_admin = _make_treasurer(
            self.church, email='admin@example.org', role=UserRole.SUPER_ADMIN,
        )
        with _stk_ok():
            resp = self._initiate(user=super_admin, tier=SubscriptionTier.GROWTH)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN, resp.content)
        self.assertEqual(SubscriptionPayment.objects.count(), 0)

    def test_unauthenticated_rejected(self):
        with _stk_ok():
            resp = self.client.post(self._url(), {'tier': SubscriptionTier.GROWTH},
                                    format='json')
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED, resp.content)
        self.assertEqual(SubscriptionPayment.objects.count(), 0)

    # ── one in-flight renewal per church ─────────────────────────────────────────
    def test_second_initiate_blocked_while_pending(self):
        with _stk_ok():
            first = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(first.status_code, status.HTTP_200_OK, first.content)

        with _stk_ok():
            second = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(second.status_code, status.HTTP_409_CONFLICT, second.content)

        self.assertEqual(
            SubscriptionPayment.objects.filter(
                church=self.church, status=SubscriptionPaymentStatus.PENDING,
            ).count(),
            1,
        )

    def test_pending_expired_allows_new_initiate(self):
        # A stale PENDING row (older than the STK timeout) must NOT block.
        stale = SubscriptionPayment.objects.create(
            church=self.church, tier=SubscriptionTier.GROWTH,
            amount=Decimal('999.00'), phone_number='254712345678',
            status=SubscriptionPaymentStatus.PENDING,
            checkout_request_id='ws_CO_stale_001',
        )
        old_time = timezone.now() - timedelta(
            minutes=settings.SUBSCRIPTION_STK_TIMEOUT_MINUTES + 1,
        )
        # created_at is auto_now_add — bypass it with a queryset update.
        SubscriptionPayment.objects.filter(pk=stale.pk).update(created_at=old_time)

        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)

        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(SubscriptionPayment.objects.filter(church=self.church).count(), 2)

    # ── STK dispatch failure (3b: fail-at-source) ────────────────────────────────
    def test_stk_failure_marks_failed_and_unblocks_retry(self):
        """502 row is marked FAILED (not PENDING) with NULL checkout_request_id, and a
        SECOND initiate immediately after is ALLOWED — the in-flight guard no longer
        counts the failed attempt."""
        with _stk_fail():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)

        self.assertEqual(resp.status_code, status.HTTP_502_BAD_GATEWAY, resp.content)
        pay = SubscriptionPayment.objects.get(church=self.church)
        self.assertEqual(pay.status, SubscriptionPaymentStatus.FAILED)
        self.assertIsNone(pay.checkout_request_id)

        # Retry is NOT blocked (no live PENDING row remains).
        with _stk_ok():
            retry = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(retry.status_code, status.HTTP_200_OK, retry.content)
        self.assertEqual(
            SubscriptionPayment.objects.filter(
                church=self.church, status=SubscriptionPaymentStatus.PENDING,
            ).count(),
            1,
        )

    # ── block down-pay: live PARISH cannot pay for GROWTH (Slice 4) ──────────────
    def _set_church(self, *, tier, expires_at):
        self.church.subscription_tier = tier
        self.church.subscription_expires_at = expires_at
        self.church.save(update_fields=['subscription_tier', 'subscription_expires_at'])

    def test_live_parish_cannot_paydown_to_growth(self):
        """A LIVE Parish church (expiry in the future) cannot pay the cheaper Growth
        price now — 400, no row created. (Currently 200 + PENDING row = the leak.)"""
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=10))
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertEqual(SubscriptionPayment.objects.count(), 0)

    def test_past_due_parish_can_pay_growth(self):
        """A past-due Parish church (expiry already passed, still PARISH in grace) is
        NOT locked out — it may pay for Growth."""
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() - timedelta(days=2))
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        pay = SubscriptionPayment.objects.get(church=self.church)
        self.assertEqual(pay.status, SubscriptionPaymentStatus.PENDING)
        self.assertEqual(pay.tier, SubscriptionTier.GROWTH)

    def test_free_church_can_pay_growth(self):
        """A FREE church (e.g. post-lapse), expiry None, may pay for Growth — the new
        check must not catch FREE churches."""
        self._set_church(tier=SubscriptionTier.FREE, expires_at=None)
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(
            SubscriptionPayment.objects.filter(
                church=self.church, tier=SubscriptionTier.GROWTH).count(), 1)

    def test_live_parish_can_renew_parish(self):
        """Same-tier renewal is never blocked."""
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=10))
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.PARISH)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

    def test_growth_can_upgrade_to_parish(self):
        """Upgrade (live Growth → Parish) is never blocked."""
        self._set_church(tier=SubscriptionTier.GROWTH,
                         expires_at=timezone.now() + timedelta(days=10))
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.PARISH)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

    # ── narrowed down-pay block: only when > 7 days from expiry (this slice) ──────
    def test_parish_blocked_growth_far_from_expiry(self):
        """A PARISH church with expiry well in the future (> 7 days) STILL cannot pay
        down to Growth — 400, no row. (Was true in slice 4; must stay true.)"""
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=20))
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertEqual(SubscriptionPayment.objects.count(), 0)

    def test_parish_allows_growth_within_7d(self):
        """A PARISH church inside its last 7 paid days MAY switch to Growth — the
        deliberate goodwill leak. 200 + PENDING row. (Slice-4 guard blocked ALL live
        Parish, so this FAILS before the narrowing.)"""
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=5))
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        pay = SubscriptionPayment.objects.get(church=self.church)
        self.assertEqual(pay.status, SubscriptionPaymentStatus.PENDING)
        self.assertEqual(pay.tier, SubscriptionTier.GROWTH)

    def test_parish_allows_growth_in_grace(self):
        """A PARISH church already past expiry (in grace) MAY switch to Growth — 200."""
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() - timedelta(days=2))
        with _stk_ok():
            resp = self._initiate(user=self.treasurer, tier=SubscriptionTier.GROWTH)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)


# ═════════════════════════════════════════════════════════════════════════════
# Callback — confirm → extend period + flip tier, atomically + idempotently
# ═════════════════════════════════════════════════════════════════════════════


class SubscriptionCallbackTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.church = _make_church()
        ps = PlatformSettings.load()
        ps.growth_price = Decimal('999.00')
        ps.parish_price = Decimal('2499.00')
        ps.save()

    def _callback(self, checkout_id, *, result_code=0, receipt='SUBRCPT01', amount=999):
        return self.client.post(
            reverse('subscription-callback'),
            _sub_callback_body(checkout_id, result_code=result_code, receipt=receipt,
                               amount=amount),
            format='json',
        )

    def _tier_audits(self):
        return AuditLog.objects.filter(action='CHURCH_TIER_CHANGED', entity_id=self.church.id)

    def test_success_callback_extends_and_flips(self):
        pay = _pending_payment(self.church, checkout='ws_CO_cb_succ')
        resp = self._callback('ws_CO_cb_succ')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        self.church.refresh_from_db()
        pay.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.GROWTH)
        expected = timezone.now() + timedelta(days=settings.SUBSCRIPTION_PERIOD_DAYS)
        self.assertAlmostEqual(self.church.subscription_expires_at, expected,
                               delta=timedelta(seconds=30))
        self.assertEqual(pay.status, SubscriptionPaymentStatus.SUCCESSFUL)
        self.assertEqual(pay.period_end_granted, self.church.subscription_expires_at)
        self.assertIsNotNone(pay.confirmed_at)
        self.assertEqual(pay.mpesa_receipt_number, 'SUBRCPT01')

        self.assertEqual(self._tier_audits().count(), 1)
        self.assertEqual(self._tier_audits().get().details.get('via'), 'subscription_payment')

    def test_renew_extends_from_later_of_now_or_expiry(self):
        future = timezone.now() + timedelta(days=10)
        self.church.subscription_tier = SubscriptionTier.GROWTH
        self.church.subscription_expires_at = future
        self.church.save()
        _pending_payment(self.church, checkout='ws_CO_cb_renew')

        self._callback('ws_CO_cb_renew')

        self.church.refresh_from_db()
        expected = future + timedelta(days=settings.SUBSCRIPTION_PERIOD_DAYS)
        # max() must extend from the FUTURE expiry, NOT burn paid days back to now+30.
        self.assertAlmostEqual(self.church.subscription_expires_at, expected,
                               delta=timedelta(seconds=30))

    def test_duplicate_success_callback_does_not_double_extend(self):
        _pending_payment(self.church, checkout='ws_CO_cb_dup')
        self._callback('ws_CO_cb_dup')
        self.church.refresh_from_db()
        first_expiry = self.church.subscription_expires_at
        pay = SubscriptionPayment.objects.get(checkout_request_id='ws_CO_cb_dup')
        first_peg = pay.period_end_granted

        resp2 = self._callback('ws_CO_cb_dup')
        self.assertEqual(resp2.status_code, status.HTTP_200_OK, resp2.content)

        self.church.refresh_from_db()
        pay.refresh_from_db()
        self.assertEqual(self.church.subscription_expires_at, first_expiry)
        self.assertEqual(pay.period_end_granted, first_peg)
        self.assertEqual(self._tier_audits().count(), 1)

    def test_reminder_marker_reset_on_success(self):
        self.church.subscription_reminder_stage = REMINDER_STAGE_1D
        self.church.subscription_reminder_period = timezone.now()
        self.church.save()
        _pending_payment(self.church, checkout='ws_CO_cb_rem')

        self._callback('ws_CO_cb_rem')

        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_reminder_stage, REMINDER_STAGE_NONE)
        self.assertIsNone(self.church.subscription_reminder_period)

    def test_failure_callback_no_grant(self):
        _pending_payment(self.church, checkout='ws_CO_cb_fail')
        resp = self._callback('ws_CO_cb_fail', result_code=1032)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        pay = SubscriptionPayment.objects.get(checkout_request_id='ws_CO_cb_fail')
        self.church.refresh_from_db()
        self.assertEqual(pay.status, SubscriptionPaymentStatus.FAILED)
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(self.church.subscription_expires_at)
        self.assertEqual(self._tier_audits().count(), 0)

    def test_unknown_checkout_id_noop(self):
        resp = self._callback('ws_CO_nonexistent')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(SubscriptionPayment.objects.count(), 0)
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)

    def test_parish_payment_grants_parish(self):
        _pending_payment(self.church, tier=SubscriptionTier.PARISH,
                         amount=Decimal('2499.00'), checkout='ws_CO_cb_parish')
        self._callback('ws_CO_cb_parish', amount=2499)
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.PARISH)
        self.assertIsNotNone(self.church.subscription_expires_at)


# ═════════════════════════════════════════════════════════════════════════════
# Poll — status + tier + church expiry; stale flag by AGE (never terminalizes)
# ═════════════════════════════════════════════════════════════════════════════


class SubscriptionPollTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)

    def _poll(self, payment_id, user=None):
        if user is not None:
            self.client.force_authenticate(user=user)
        return self.client.get(reverse('subscription-status', args=[payment_id]))

    def test_fresh_pending_not_stale(self):
        pay = _pending_payment(self.church, checkout='ws_CO_poll_fresh')
        resp = self._poll(pay.id, user=self.treasurer)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['status'], SubscriptionPaymentStatus.PENDING)
        self.assertFalse(resp.data['stale'])

    def test_aged_pending_is_stale_but_still_pending(self):
        pay = _pending_payment(self.church, checkout='ws_CO_poll_aged')
        old = timezone.now() - timedelta(
            minutes=settings.SUBSCRIPTION_STK_TIMEOUT_MINUTES + 1,
        )
        SubscriptionPayment.objects.filter(pk=pay.pk).update(created_at=old)

        resp = self._poll(pay.id, user=self.treasurer)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertTrue(resp.data['stale'])
        pay.refresh_from_db()
        # stale is DERIVED — the row is NOT terminalized (a late callback can still confirm).
        self.assertEqual(pay.status, SubscriptionPaymentStatus.PENDING)

    def test_other_church_payment_404(self):
        other = _make_church(email='other-poll@example.org')
        pay = _pending_payment(other, checkout='ws_CO_poll_other')
        resp = self._poll(pay.id, user=self.treasurer)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND, resp.content)


# ═════════════════════════════════════════════════════════════════════════════
# Cancel — flag-only opt-out: keeps paid time, suppresses renewal reminders,
# still lapses at grace end, cleared on renewal
# ═════════════════════════════════════════════════════════════════════════════


class SubscriptionCancelTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        ps = PlatformSettings.load()
        ps.growth_price = Decimal('999.00')
        ps.parish_price = Decimal('2499.00')
        ps.save()

    def _cancel(self, user=None):
        if user is not None:
            self.client.force_authenticate(user=user)
        return self.client.post(reverse('subscription-cancel'), {}, format='json')

    def _set_church(self, *, tier, expires_at):
        self.church.subscription_tier = tier
        self.church.subscription_expires_at = expires_at
        self.church.save(update_fields=['subscription_tier', 'subscription_expires_at'])

    def _cancel_audits(self):
        return AuditLog.objects.filter(
            action='SUBSCRIPTION_CANCEL_REQUESTED', entity_id=self.church.id,
        )

    # ── flag set, tier/expiry untouched ──────────────────────────────────────────
    def test_cancel_sets_flag_keeps_tier(self):
        future = timezone.now() + timedelta(days=15)
        self._set_church(tier=SubscriptionTier.PARISH, expires_at=future)

        resp = self._cancel(user=self.treasurer)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        self.church.refresh_from_db()
        self.assertTrue(self.church.subscription_cancel_requested)
        # Cancel keeps paid time: tier + expiry are NOT touched.
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.PARISH)
        self.assertEqual(self.church.subscription_expires_at, future)
        self.assertEqual(self._cancel_audits().count(), 1)

    def test_cancel_idempotent_no_second_audit(self):
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=15))
        self.assertEqual(self._cancel(user=self.treasurer).status_code, status.HTTP_200_OK)
        # Second cancel: still 200, no-op, NO second audit row.
        self.assertEqual(self._cancel(user=self.treasurer).status_code, status.HTTP_200_OK)
        self.church.refresh_from_db()
        self.assertTrue(self.church.subscription_cancel_requested)
        self.assertEqual(self._cancel_audits().count(), 1)

    def test_cancel_requires_treasurer(self):
        super_admin = _make_treasurer(
            self.church, email='admin-cancel@example.org', role=UserRole.SUPER_ADMIN,
        )
        resp = self._cancel(user=super_admin)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN, resp.content)

    # ── /churches/me/ surfaces the flag (read-only) so the FE card can render CANCELLED ──
    def test_me_endpoint_surfaces_cancel_flag(self):
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=15))
        self.client.force_authenticate(user=self.treasurer)
        # Default False, then True after the cancel endpoint sets it.
        before = self.client.get(reverse('church-me'))
        self.assertEqual(before.status_code, status.HTTP_200_OK, before.content)
        self.assertIn('subscription_cancel_requested', before.data)
        self.assertFalse(before.data['subscription_cancel_requested'])

        self._cancel(user=self.treasurer)
        # force_authenticate reuses the same in-memory user, whose .church FK is cached;
        # refresh so the next GET re-reads the flag from the DB (a real request loads a
        # fresh user each time, so this only mirrors production behaviour).
        self.treasurer.refresh_from_db()
        after = self.client.get(reverse('church-me'))
        self.assertTrue(after.data['subscription_cancel_requested'])

    def test_patch_me_cannot_set_cancel_flag(self):
        """The flag is read-only on PATCH /churches/me/ — only the dedicated audited
        endpoint may set it (no profile-write back door)."""
        self.client.force_authenticate(user=self.treasurer)
        resp = self.client.patch(
            reverse('church-me'),
            {'subscription_cancel_requested': True},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.church.refresh_from_db()
        self.assertFalse(self.church.subscription_cancel_requested)

    # ── renewal clears the flag (in the 3b callback's atomic block) ──────────────
    def test_renew_clears_cancel_flag(self):
        future = timezone.now() + timedelta(days=10)
        self._set_church(tier=SubscriptionTier.PARISH, expires_at=future)
        self.church.subscription_cancel_requested = True
        self.church.save(update_fields=['subscription_cancel_requested'])

        _pending_payment(self.church, tier=SubscriptionTier.PARISH,
                         amount=Decimal('2499.00'), checkout='ws_CO_cancel_renew')
        resp = self.client.post(
            reverse('subscription-callback'),
            _sub_callback_body('ws_CO_cancel_renew', amount=2499),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        self.church.refresh_from_db()
        self.assertFalse(self.church.subscription_cancel_requested)

    # ── cancelled church gets NO renewal reminder ────────────────────────────────
    def test_cancelled_church_gets_no_reminder(self):
        # +3d sits inside the 7-day reminder window — a non-cancelled church WOULD be
        # reminded here.
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=3))
        self.church.subscription_cancel_requested = True
        self.church.save(update_fields=['subscription_cancel_requested'])

        notified = run_subscription_reminders()
        self.assertEqual(notified, 0)

    def test_non_cancelled_church_still_reminded(self):
        # Control: same window, flag OFF → one reminder (guards the skip is the cancel
        # flag, not an unrelated regression).
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() + timedelta(days=3))
        notified = run_subscription_reminders()
        self.assertEqual(notified, 1)

    # ── cancel does NOT stop the lapse ───────────────────────────────────────────
    def test_cancelled_church_still_lapses(self):
        grace_days = settings.SUBSCRIPTION_GRACE_DAYS
        self._set_church(tier=SubscriptionTier.PARISH,
                         expires_at=timezone.now() - timedelta(days=grace_days + 2))
        self.church.subscription_cancel_requested = True
        self.church.save(update_fields=['subscription_cancel_requested'])

        lapsed = run_subscription_lapses()
        self.assertEqual(lapsed, 1)
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(self.church.subscription_expires_at)

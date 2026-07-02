"""Step 2.12 — Resend email client: the two failure postures + masking.

Mirrors tests/test_sms.py (2.11):
  * COURTESY sends (password-changed, registration approved/rejected) run AFTER a
    committed op — an email failure must NOT 500 the request or roll back the op.
  * The reset-OTP send IS the operation — failure must SURFACE (502), never
    "reset email sent".
  * Non-DEBUG no-op guard is gone — the real send fires with DEBUG=False.
  * Failure logs mask the recipient (PRD §12.10).

Seam: `integrations.resend_email._send_email`; tests patch exactly it for the
posture cases, and patch the Resend SDK below it for the guard-gone case.
"""

from decimal import Decimal
from unittest.mock import Mock, patch

from django.conf import settings
from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import PasswordResetOTP, User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from common.masking import mask_email
from donations.models import Donation, DonationStatus
from integrations.resend_email import (
    EmailDeliveryError,
    send_donation_receipt,
    send_password_changed,
    send_payout_approved_email,
    send_payout_rejected_email,
    send_registration_approved,
    send_registration_received,
    send_registration_rejected,
)


def _pending_church(email='reg@example.org'):
    return Church.objects.create(
        name='Reg Church', official_email=email, phone='254700000001',
        address='a', county='Nairobi', denomination='PCEA', status=ChurchStatus.PENDING,
    )


def _superadmin(email='admin@pamojahub.co.ke'):
    return User.objects.create_user(
        email=email, password='pw', first_name='S', last_name='A',
        role=UserRole.SUPER_ADMIN,
    )


# ═════════════════════════════════════════════════════════════════════════════
# mask_email — PRD §12.10 discipline
# ═════════════════════════════════════════════════════════════════════════════


class MaskEmailTests(TestCase):
    def test_masks_local_keeps_first_char_and_domain(self):
        self.assertEqual(mask_email('john.doe@example.org'), 'j*******@example.org')
        self.assertEqual(mask_email('a@example.org'), '*@example.org')
        self.assertEqual(mask_email(''), '')
        self.assertEqual(mask_email(None), '')
        self.assertEqual(mask_email('notanemail'), '*******ail')


# ═════════════════════════════════════════════════════════════════════════════
# COURTESY posture — email failure must NOT roll back / 500 the committed op
# ═════════════════════════════════════════════════════════════════════════════


class CourtesyEmailFailureTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.admin = _superadmin()

    def test_church_approve_succeeds_even_when_email_fails(self):
        church = _pending_church(email='approve@example.org')
        self.client.force_authenticate(user=self.admin)
        with patch('integrations.resend_email._send_email',
                   side_effect=EmailDeliveryError('resend down')):
            resp = self.client.post(reverse('super-church-approve', args=[church.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        church.refresh_from_db()
        self.assertEqual(church.status, ChurchStatus.ACTIVE)

    def test_church_reject_succeeds_even_when_email_fails(self):
        church = _pending_church(email='reject@example.org')
        self.client.force_authenticate(user=self.admin)
        with patch('integrations.resend_email._send_email',
                   side_effect=EmailDeliveryError('resend down')):
            resp = self.client.post(
                reverse('super-church-reject', args=[church.id]),
                {'rejection_reason': 'Incomplete registration documents'}, format='json',
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        church.refresh_from_db()
        self.assertEqual(church.status, ChurchStatus.REJECTED)

    def test_courtesy_functions_never_raise_on_failure(self):
        # Direct unit-level: each courtesy function swallows EmailDeliveryError.
        with patch('integrations.resend_email._send_email',
                   side_effect=EmailDeliveryError('resend down')):
            send_password_changed('x@example.org')                 # must not raise
            send_registration_approved('x@example.org', 'Ch')      # must not raise
            send_registration_rejected('x@example.org', 'Ch', 'r') # must not raise
            # New Step-3 onboarding/transactional courtesy sends — same posture.
            send_registration_received('x@example.org', 'Ch')      # must not raise
            send_donation_receipt('x@example.org', 'Jane', 'Roof Fund',
                                  '1000', 'NLJ7RT61SV')             # must not raise
            send_donation_receipt('x@example.org', None, 'Roof Fund',
                                  '1000', 'NLJ7RT61SV')             # None donor_name ok
            send_payout_approved_email('x@example.org', '500', 'Roof Fund')  # must not raise
            send_payout_rejected_email('x@example.org', 'Roof Fund', 'reason')  # must not raise


# ═════════════════════════════════════════════════════════════════════════════
# Reset-request ENUMERATION OPACITY (2.12b A) — all three paths byte-identical.
# This endpoint promises existence-opacity, so a delivery failure must NOT surface
# (the former 502 was an "account exists" oracle). It is the OPPOSITE posture from
# the portal OTP / password-changed — and that is correct (see §14).
# ═════════════════════════════════════════════════════════════════════════════


class ResetEnumerationOpacityTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.url = reverse('auth-password-reset-request')
        User.objects.create_user(
            email='resetme@example.org', password='pw',
            first_name='R', last_name='U', role=UserRole.SUPER_ADMIN,
        )

    def _post(self, email):
        # Fresh cache each call so the 3/h rate limit doesn't interfere.
        cache.clear()
        return self.client.post(self.url, {'email': email}, format='json')

    def test_all_three_paths_are_byte_identical(self):
        # Path A — email does NOT exist.
        a = self._post('nobody@example.org')
        # Path B — email exists, send SUCCEEDS.
        with patch('integrations.resend_email._send_email', return_value=None):
            b = self._post('resetme@example.org')
        # Path C — email exists, send FAILS (the former 502 path).
        with patch('integrations.resend_email._send_email',
                   side_effect=EmailDeliveryError('resend down')):
            c = self._post('resetme@example.org')

        # All three: 200 + identical generic body. C no longer 502s → no oracle.
        for r in (a, b, c):
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(a.data, b.data)
        self.assertEqual(b.data, c.data)
        self.assertEqual(c.content, a.content)  # byte-identical
        # And specifically: the send-failure path is NOT distinguishable.
        self.assertNotEqual(c.status_code, status.HTTP_502_BAD_GATEWAY)


# ═════════════════════════════════════════════════════════════════════════════
# Rejection-reason persist (2.12b B) — durable, treasurer-readable, not public.
# ═════════════════════════════════════════════════════════════════════════════


class RejectionReasonPersistTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.admin = _superadmin()
        self.church = _pending_church(email='persist@example.org')
        self.treasurer = User.objects.create_user(
            email='persisttreas@example.org', password='treaspw',
            first_name='P', last_name='T',
            role=UserRole.CHURCH_TREASURER, church=self.church,
        )
        self.reason = 'County mismatch: registration says Nairobi, docs say Kiambu.'

    def _reject(self):
        self.client.force_authenticate(user=self.admin)
        resp = self.client.post(
            reverse('super-church-reject', args=[self.church.id]),
            {'rejection_reason': self.reason}, format='json',
        )
        self.client.force_authenticate(user=None)
        return resp

    def test_reject_persists_reason_on_church(self):
        with patch('integrations.resend_email._send_email', return_value=None):
            resp = self._reject()
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.church.refresh_from_db()
        self.assertEqual(self.church.status, ChurchStatus.REJECTED)
        self.assertEqual(self.church.rejection_reason, self.reason)

    def test_rejected_treasurer_login_carries_reason(self):
        with patch('integrations.resend_email._send_email', return_value=None):
            self._reject()
        # Real login (own treasurer) → response carries status + reason.
        resp = self.client.post(
            reverse('auth-login'),
            {'email': 'persisttreas@example.org', 'password': 'treaspw'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['church_status'], ChurchStatus.REJECTED)
        self.assertEqual(resp.data['church_rejection_reason'], self.reason)

    def test_reason_not_on_public_church_surface(self):
        with patch('integrations.resend_email._send_email', return_value=None):
            self._reject()
        # Public list — rejected church excluded entirely, reason text absent.
        list_resp = self.client.get('/api/v1/churches/')
        self.assertEqual(list_resp.status_code, status.HTTP_200_OK)
        self.assertNotIn(self.reason, str(list_resp.content))
        self.assertNotIn('rejection_reason', str(list_resp.content))
        # Public detail — must not expose the reason (404 for non-ACTIVE is fine).
        detail_resp = self.client.get(f'/api/v1/churches/{self.church.id}/')
        self.assertNotIn(self.reason, str(detail_resp.content))
        self.assertNotIn('rejection_reason', str(detail_resp.content))


# ═════════════════════════════════════════════════════════════════════════════
# Non-DEBUG no-op guard GONE + masked failure log
# ═════════════════════════════════════════════════════════════════════════════


class NoDebugNoOpGuardTests(TestCase):
    def test_send_fires_outside_debug_and_returns_on_resend_id(self):
        self.assertFalse(settings.DEBUG)  # test runner runs DEBUG=False
        fake_emails = Mock()
        fake_emails.send.return_value = {'id': 'msg_123'}
        with patch('resend.Emails', fake_emails):
            send_password_changed('john@example.org')  # courtesy success path
        fake_emails.send.assert_called_once()

    def test_courtesy_failure_log_masks_recipient(self):
        # Resend SDK raises → seam raises EmailDeliveryError → courtesy logs MASKED.
        fake_emails = Mock()
        fake_emails.send.side_effect = RuntimeError('smtp boom')
        with patch('resend.Emails', fake_emails), \
             self.assertLogs('integrations.resend_email', level='ERROR') as cm:
            send_registration_rejected('john.doe@example.org', 'Church X', 'a reason')
        logged = '\n'.join(cm.output)
        self.assertIn('j*******@example.org', logged)   # masked form present
        self.assertNotIn('john.doe@example.org', logged) # raw recipient absent
        self.assertNotIn('a reason', logged)             # free-text reason not logged


# ═════════════════════════════════════════════════════════════════════════════
# Step-3 onboarding/transactional wiring — the new sends fire from their flows,
# and a send failure never breaks the committed operation.
# ═════════════════════════════════════════════════════════════════════════════


_REGISTER_PAYLOAD = {
    'name': 'Grace Chapel', 'official_email': 'grace@example.org',
    'phone': '254700000123', 'address': '1 Faith Rd, Nairobi',
    'county': 'Nairobi', 'denomination': 'PCEA',
    'first_name': 'Mary', 'last_name': 'Wanjiru', 'password': 'Sup3rL0ngPass!word',
}


def _stk_success_body(checkout_id, amount, receipt='NLJ7RT61SV'):
    return {'Body': {'stkCallback': {
        'MerchantRequestID': 'mr-1', 'CheckoutRequestID': checkout_id,
        'ResultCode': 0, 'ResultDesc': 'ok',
        'CallbackMetadata': {'Item': [
            {'Name': 'Amount', 'Value': amount},
            {'Name': 'MpesaReceiptNumber', 'Value': receipt},
        ]},
    }}}


class OnboardingWiringTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()

    # ── Registration welcome email ───────────────────────────────────────────
    def test_register_sends_welcome_email_to_church_email(self):
        with patch('accounts.views.send_registration_received') as spy:
            resp = self.client.post(reverse('auth-register'),
                                    _REGISTER_PAYLOAD, format='json')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        spy.assert_called_once_with(email='grace@example.org', church_name='Grace Chapel')

    def test_register_succeeds_even_when_welcome_email_fails(self):
        # Courtesy at the new register boundary: a send failure must not 500 / roll back.
        with patch('integrations.resend_email._send_email',
                   side_effect=EmailDeliveryError('resend down')):
            resp = self.client.post(reverse('auth-register'),
                                    _REGISTER_PAYLOAD, format='json')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(
            Church.objects.filter(official_email='grace@example.org').count(), 1)

    # ── Donor receipt (gated on donor_email + credited-once) ─────────────────
    def _campaign(self):
        church = Church.objects.create(
            name='Rcpt Church', official_email='rcpt@example.org', phone='254700000001',
            address='a', county='Nairobi', denomination='PCEA', status=ChurchStatus.ACTIVE,
        )
        treasurer = User.objects.create_user(
            email='rcpt-t@example.org', password='pw', first_name='F', last_name='L',
            role=UserRole.CHURCH_TREASURER, church=church,
        )
        return Campaign.objects.create(
            slug='rcpt-camp', church=church, title='Roof Fund', description='d',
            goal_amount=Decimal('1000000'), raised_amount=Decimal('0'),
            wallet_balance=Decimal('0'), banner_image_url='https://example.org/x.png',
            category=CampaignCategory.BUILDING, treasurer_phone='254712345678',
            treasurer_name='T U', created_by=treasurer, status=CampaignStatus.ACTIVE,
        )

    def test_donation_receipt_sent_once_when_donor_email_present(self):
        campaign = self._campaign()
        Donation.objects.create(
            campaign=campaign, phone_number='254712345678', amount=Decimal('1000'),
            status=DonationStatus.PENDING, checkout_request_id='ws_CO_R1',
            donor_email='donor@example.org', donor_name='Jane',
        )
        body = _stk_success_body('ws_CO_R1', 1000)
        with patch('donations.views.send_donation_receipt') as spy:
            r1 = self.client.post(reverse('donation-callback'), body, format='json')
            r2 = self.client.post(reverse('donation-callback'), body, format='json')  # dup
        self.assertEqual(r1.status_code, status.HTTP_200_OK)
        self.assertEqual(r2.status_code, status.HTTP_200_OK)
        # Credited exactly once → receipt exactly once (NOT on the duplicate callback).
        spy.assert_called_once()
        self.assertEqual(spy.call_args.kwargs['email'], 'donor@example.org')
        self.assertEqual(spy.call_args.kwargs['receipt'], 'NLJ7RT61SV')

    def test_no_donor_email_means_no_receipt(self):
        campaign = self._campaign()
        Donation.objects.create(
            campaign=campaign, phone_number='254712345678', amount=Decimal('1000'),
            status=DonationStatus.PENDING, checkout_request_id='ws_CO_R2',
        )  # no donor_email
        body = _stk_success_body('ws_CO_R2', 1000)
        with patch('donations.views.send_donation_receipt') as spy:
            resp = self.client.post(reverse('donation-callback'), body, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        spy.assert_not_called()


# ═════════════════════════════════════════════════════════════════════════════
# PH2-02 — user-controlled values must be HTML-escaped into the email body.
# A campaign title / rejection reason is free text (treasurer- or admin-supplied);
# interpolated raw it is stored XSS in any HTML email client. Only the VALUES are
# escaped — the static <p>/<strong> structure must survive.
# ═════════════════════════════════════════════════════════════════════════════


class EmailHtmlEscapingTests(TestCase):
    def _captured_html(self, fn, *args, **kwargs):
        """Call an email builder with the network seam mocked; return the HTML body
        it handed to _send_email (positional arg 2)."""
        with patch('integrations.resend_email._send_email') as seam:
            fn(*args, **kwargs)
        seam.assert_called_once()
        return seam.call_args.args[2]

    def test_donation_receipt_escapes_campaign_title(self):
        # DONOR-facing path: campaign_title originates from Campaign.title (treasurer
        # free text). A <script> payload must NOT land raw in the receipt HTML.
        html = self._captured_html(
            send_donation_receipt,
            'donor@example.org', 'Jane', '<script>evil()</script>',
            '1000', 'NLJ7RT61SV',
        )
        self.assertNotIn('<script>evil()</script>', html)          # raw payload gone
        self.assertIn('&lt;script&gt;evil()&lt;/script&gt;', html)  # escaped instead
        self.assertIn('<strong>KES 1000</strong>', html)            # static structure survives

    def test_payout_rejected_escapes_reason(self):
        # Reject path: reason is admin/treasurer free text.
        html = self._captured_html(
            send_payout_rejected_email,
            'treas@example.org', 'Roof Fund', '<b>x</b>',
        )
        self.assertNotIn('<b>x</b>', html)             # raw payload gone
        self.assertIn('&lt;b&gt;x&lt;/b&gt;', html)     # escaped instead
        self.assertIn('<p>Reason: ', html)              # static structure survives

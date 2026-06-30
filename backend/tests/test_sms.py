"""Step 2.11 — Africa's Talking SMS client: the two failure postures.

The seam swap (no-op → real AT send) is only interesting at its failure edges:

  * COURTESY sends (payout approved/rejected) run AFTER a committed money op. An
    SMS failure must NOT 500 the request or roll back the money op — the row still
    transitions, the response is still 200.
  * The OTP send IS the operation. An SMS failure must SURFACE to the user (502),
    NOT be reported as "OTP sent".

Plus: the non-DEBUG no-op guard is gone — the real send fires even with DEBUG=False
(which is how the Django test runner runs), and normalizes the recipient to 254… at
the boundary.

The seam is `integrations.africastalking._send_sms`; tests patch exactly it for the
posture cases, and patch the AT SDK below it for the guard-gone case.
"""

from decimal import Decimal
from unittest.mock import Mock, patch

from django.conf import settings
from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from integrations import daraja
from integrations.africastalking import SMSDeliveryError, send_portal_otp
from treasurer_portal.views import RequestOTPView
from withdrawals.models import Withdrawal, WithdrawalStatus


_OAUTH_OK = {'access_token': 'TEST-TOKEN', 'expires_in': '3599'}
_B2C_ACK_OK = {
    'ConversationID': 'AG_TEST', 'OriginatorConversationID': 'OC_TEST',
    'ResponseCode': '0', 'ResponseDescription': 'Accept the service request successfully.',
}


def _daraja_seam():
    def _fake(method, url, **kwargs):
        if 'oauth' in url:
            return _FakeResp(200, _OAUTH_OK)
        return _FakeResp(200, _B2C_ACK_OK)
    return _fake


class _FakeResp:
    def __init__(self, code, body):
        self.status_code = code
        self._body = body

    def json(self):
        return self._body


def _church(email='sms@example.org'):
    return Church.objects.create(
        name='SMS Church', official_email=email, phone='254700000001',
        address='a', county='Nairobi', denomination='PCEA', status=ChurchStatus.ACTIVE,
    )


def _treasurer(church, email='smstreas@example.org'):
    return User.objects.create_user(
        email=email, password='pw', first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _campaign(church, treasurer):
    return Campaign.objects.create(
        slug='sms-camp', church=church, title='SMS Camp', description='d',
        goal_amount=Decimal('100000'), raised_amount=Decimal('10000'),
        wallet_balance=Decimal('5000'), banner_image_url='https://e.org/x.png',
        category=CampaignCategory.BUILDING, treasurer_phone='254712345678',
        treasurer_name='T U', created_by=treasurer, status=CampaignStatus.ACTIVE,
    )


def _withdrawal(campaign, status_=WithdrawalStatus.PENDING_APPROVAL):
    return Withdrawal.objects.create(
        campaign=campaign, requested_by_phone='254712345678',
        destination_phone='254712345678', destination_name='T U',
        amount=Decimal('1000'), reason='Builders payment', status=status_,
    )


# ═════════════════════════════════════════════════════════════════════════════
# COURTESY posture — SMS failure must NOT roll back or 500 the money op
# ═════════════════════════════════════════════════════════════════════════════


class CourtesySmsFailureTests(TestCase):
    def setUp(self):
        cache.clear()
        daraja._clear_token_cache()
        self.client = APIClient()
        self.church = _church()
        self.treasurer = _treasurer(self.church)
        self.campaign = _campaign(self.church, self.treasurer)

    def test_approve_succeeds_even_when_approval_sms_fails(self):
        wd = _withdrawal(self.campaign)
        self.client.force_authenticate(user=self.treasurer)
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_daraja_seam()), \
             patch('integrations.africastalking._send_sms',
                   side_effect=SMSDeliveryError('AT down')):
            resp = self.client.post(reverse('withdrawal-approve', args=[wd.id]))
        # Money op completes regardless of the SMS failure.
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PROCESSING)

    def test_reject_succeeds_even_when_rejection_sms_fails(self):
        wd = _withdrawal(self.campaign)
        self.client.force_authenticate(user=self.treasurer)
        with patch('integrations.africastalking._send_sms',
                   side_effect=SMSDeliveryError('AT down')):
            resp = self.client.post(
                reverse('withdrawal-reject', args=[wd.id]),
                {'rejection_reason': 'Incomplete documentation'}, format='json',
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.REJECTED)


# ═════════════════════════════════════════════════════════════════════════════
# OTP posture — SMS failure must SURFACE to the user (not "OTP sent")
# ═════════════════════════════════════════════════════════════════════════════


class OtpSmsFailureSurfacesTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.church = _church(email='otp@example.org')
        self.treasurer = _treasurer(self.church, email='otptreas@example.org')
        self.campaign = _campaign(self.church, self.treasurer)
        self.url = reverse('portal-request-otp')

    def test_otp_send_failure_returns_error_not_success(self):
        with patch('integrations.africastalking._send_sms',
                   side_effect=SMSDeliveryError('AT down')):
            resp = self.client.post(self.url, {'phone_number': '0712345678'}, format='json')
        # User is told it FAILED — never "OTP sent".
        self.assertEqual(resp.status_code, status.HTTP_502_BAD_GATEWAY, resp.content)
        self.assertNotEqual(resp.data.get('message'), 'OTP sent')
        self.assertNotIn('OTP sent', str(resp.content))
        self.assertIn('detail', resp.data)

    def test_otp_send_success_reports_sent(self):
        # Control: when the seam succeeds, the user gets the success 200 — NOT the 502
        # failure surface. The body is the anti-enumeration uniform message (identical
        # to the unknown-phone response by design — see tests/test_portal.py); this
        # control is about success-vs-failure, so we assert it is NOT the error shape.
        with patch('integrations.africastalking._send_sms', return_value=None):
            resp = self.client.post(self.url, {'phone_number': '0712345678'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data, RequestOTPView.UNIFORM_RESPONSE)
        self.assertNotIn('detail', resp.data)


# ═════════════════════════════════════════════════════════════════════════════
# Non-DEBUG no-op guard is GONE — the real send fires with DEBUG=False
# ═════════════════════════════════════════════════════════════════════════════


class NoDebugNoOpGuardTests(TestCase):
    def test_send_fires_outside_debug_and_normalizes_recipient(self):
        # Django's test runner runs with DEBUG=False — so if the SDK is reached
        # here, the old `if settings.DEBUG: return` no-op guard is provably gone.
        self.assertFalse(settings.DEBUG)
        fake_sms = Mock()
        fake_sms.send.return_value = {
            'SMSMessageData': {'Recipients': [{'status': 'Success', 'statusCode': 101}]}
        }
        with patch('africastalking.initialize'), patch('africastalking.SMS', fake_sms):
            send_portal_otp('0712345678', '123456')  # raw 07… input
        fake_sms.send.assert_called_once()
        # Recipient normalized to 254… internally, then handed to the SDK as E.164
        # with a leading '+' (the AT SDK rejects the bare 254… form). Corrected from
        # the former ['254712345678'] assertion that codified the rejected-by-AT bug.
        _msg, recipients = fake_sms.send.call_args.args[:2]
        self.assertEqual(recipients, ['+254712345678'])

    def test_non_success_at_status_raises(self):
        fake_sms = Mock()
        fake_sms.send.return_value = {
            'SMSMessageData': {'Recipients': [{'status': 'InvalidPhoneNumber', 'statusCode': 403}]}
        }
        with patch('africastalking.initialize'), patch('africastalking.SMS', fake_sms):
            with self.assertRaises(SMSDeliveryError):
                send_portal_otp('0712345678', '123456')

    def test_recipient_passed_to_sdk_is_plus_e164(self):
        # The AT SDK validates recipients as E.164 with a leading '+' and rejects the
        # bare 254… form with "Invalid phone number" (proven live, 502 on the real OTP
        # path). This pins that the SDK call receives '+254…'. It patches the SDK ITSELF
        # (africastalking.SMS) — NOT _send_sms — because stubbing _send_sms is exactly
        # what hid this bug from the suite.
        fake_sms = Mock()
        fake_sms.send.return_value = {
            'SMSMessageData': {'Recipients': [{'status': 'Success', 'statusCode': 101}]}
        }
        with patch('africastalking.initialize'), patch('africastalking.SMS', fake_sms):
            send_portal_otp('0712345678', '123456')  # raw 07… input
        _msg, recipients = fake_sms.send.call_args.args[:2]
        self.assertEqual(len(recipients), 1)
        self.assertTrue(
            recipients[0].startswith('+'),
            f'AT SDK recipient must be E.164 with a leading +, got {recipients[0]!r}',
        )
        self.assertEqual(recipients[0], '+254712345678')

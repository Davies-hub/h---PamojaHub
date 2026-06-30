"""Step 2.10b — STK push donation tests: initiate, callback (idempotent), status.

The headline guards:
  * IDEMPOTENCY — the SAME callback fired twice credits the balance EXACTLY once
    (a single-fire test would not prove this). Plus unknown checkout id, failure
    ResultCode, and "every path returns 200".
  * LIVE FEE — fee read from PlatformSettings.fee_percent at callback time and
    stored on the row; raised_amount moves by NET. Forward-only: editing the fee
    afterwards does not rewrite an existing donation's stored fee.
  * CHURCH-MUST-BE-ACTIVE — initiate refused for PENDING/SUSPENDED/REJECTED churches.
  * NET-EVERYWHERE — no platform_fee/net_amount/fee_percent/wallet_balance in any
    public donation response; donor-facing amount is GROSS.
"""

from decimal import Decimal
from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from donations.models import Donation, DonationStatus
from integrations import daraja
from notifications.models import Notification, NotificationType
from superadmin.models import PlatformSettings


# ── HTTP-boundary fakes (initiate calls the real stk_push; only HTTP is mocked) ──


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
_STK_ACK_OK = {
    'MerchantRequestID': 'mr-123',
    'CheckoutRequestID': 'ws_CO_TEST_001',
    'ResponseCode': '0',
    'ResponseDescription': 'Success. Request accepted for processing',
    'CustomerMessage': 'Success. Request accepted for processing',
}


def _stk_seam(*, stk_response=None, stk_exc=None):
    def _fake(method, url, **kwargs):
        if 'oauth' in url:
            return _FakeResponse(200, _OAUTH_OK)
        if stk_exc is not None:
            raise stk_exc
        return stk_response if stk_response is not None else _FakeResponse(200, _STK_ACK_OK)
    return _fake


def _callback_body(checkout_id, *, result_code=0, amount=None, receipt='NLJ7RT61SV'):
    stk = {
        'MerchantRequestID': 'mr-123',
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


def _make_church(status_=ChurchStatus.ACTIVE, name='Church', email='c@example.org'):
    return Church.objects.create(
        name=name, official_email=email, phone='254700000001',
        address='addr', county='Nairobi', denomination='PCEA', status=status_,
    )


def _make_treasurer(church, email='t@example.org'):
    return User.objects.create_user(
        email=email, password='unused', first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _make_campaign(church, treasurer, *, slug='roof-fund',
                   status_=CampaignStatus.ACTIVE, raised=Decimal('0'),
                   wallet=Decimal('0')):
    return Campaign.objects.create(
        slug=slug, church=church, title=f'Campaign {slug}', description='desc',
        goal_amount=Decimal('1000000'), raised_amount=raised, wallet_balance=wallet,
        banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING,
        treasurer_phone='254712345678', treasurer_name='Treas Urer',
        created_by=treasurer, status=status_,
    )


# ═════════════════════════════════════════════════════════════════════════════
# Initiate
# ═════════════════════════════════════════════════════════════════════════════


class InitiateTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church)
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='roof-fund')

    def setUp(self):
        cache.clear()
        daraja._clear_token_cache()
        self.client = APIClient()

    def _initiate(self, **overrides):
        payload = {
            'campaign_slug': 'roof-fund',
            'phone_number': '0712345678',
            'amount': '1000',
        }
        payload.update(overrides)
        return self.client.post(reverse('donation-initiate'), payload, format='json')

    def test_initiate_creates_pending_and_returns_checkout_id(self):
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_stk_seam()):
            resp = self._initiate()
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['checkout_request_id'], 'ws_CO_TEST_001')
        self.assertEqual(resp.data['status'], DonationStatus.PENDING)

        donation = Donation.objects.get(id=resp.data['donation_id'])
        self.assertEqual(donation.status, DonationStatus.PENDING)
        self.assertEqual(donation.checkout_request_id, 'ws_CO_TEST_001')
        # Phone normalized to 254 form.
        self.assertEqual(donation.phone_number, '254712345678')
        # Fee/net stay NULL until the callback confirms.
        self.assertIsNone(donation.platform_fee)
        self.assertIsNone(donation.net_amount)

    def test_initiate_below_minimum_rejected(self):
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_stk_seam()):
            resp = self._initiate(amount='4')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_initiate_invalid_phone_rejected(self):
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_stk_seam()):
            resp = self._initiate(phone_number='12345')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_initiate_unknown_campaign_404(self):
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_stk_seam()):
            resp = self._initiate(campaign_slug='no-such-campaign')
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_initiate_paused_campaign_refused(self):
        _make_campaign(self.church, self.treasurer, slug='paused-camp',
                       status_=CampaignStatus.PAUSED)
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_stk_seam()):
            resp = self._initiate(campaign_slug='paused-camp')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Donation.objects.filter(campaign__slug='paused-camp').count(), 0)

    def test_stk_push_failure_leaves_pending_no_checkout_id(self):
        import requests
        with patch.object(
            daraja.DarajaClient, '_http_request',
            side_effect=_stk_seam(stk_exc=requests.ConnectionError('down')),
        ):
            resp = self._initiate()
        self.assertEqual(resp.status_code, status.HTTP_502_BAD_GATEWAY)
        donation = Donation.objects.get(campaign=self.campaign)
        self.assertEqual(donation.status, DonationStatus.PENDING)
        self.assertIsNone(donation.checkout_request_id)

    def test_stk_ambiguous_ack_missing_checkout_id_is_initiate_failure(self):
        no_id_ack = _FakeResponse(200, {'ResponseCode': '0', 'CustomerMessage': 'ok'})
        with patch.object(
            daraja.DarajaClient, '_http_request',
            side_effect=_stk_seam(stk_response=no_id_ack),
        ):
            resp = self._initiate()
        self.assertEqual(resp.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertEqual(Donation.objects.get(campaign=self.campaign).status,
                         DonationStatus.PENDING)


class InitiateChurchActiveBoundaryTests(TestCase):
    """The money-safety boundary deferred from 2.9c: a non-ACTIVE church must not
    collect, regardless of campaign status."""

    def setUp(self):
        cache.clear()
        daraja._clear_token_cache()
        self.client = APIClient()

    def _refused(self, church_status):
        church = _make_church(status_=church_status,
                              name=f'C-{church_status}',
                              email=f'{church_status}@example.org')
        treasurer = _make_treasurer(church, email=f't-{church_status}@example.org')
        _make_campaign(church, treasurer, slug=f'camp-{church_status}',
                       status_=CampaignStatus.ACTIVE)
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_stk_seam()):
            resp = self.client.post(reverse('donation-initiate'), {
                'campaign_slug': f'camp-{church_status}',
                'phone_number': '0712345678', 'amount': '1000',
            }, format='json')
        return resp

    def test_pending_church_refused(self):
        resp = self._refused(ChurchStatus.PENDING)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Donation.objects.count(), 0)

    def test_suspended_church_refused(self):
        resp = self._refused(ChurchStatus.SUSPENDED)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Donation.objects.count(), 0)

    def test_rejected_church_refused(self):
        resp = self._refused(ChurchStatus.REJECTED)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Donation.objects.count(), 0)


# ═════════════════════════════════════════════════════════════════════════════
# Callback — idempotency, unknown, failure, every-path-200
# ═════════════════════════════════════════════════════════════════════════════


class CallbackTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church)

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        # Fresh campaign per test (balances start at 0).
        self.campaign = _make_campaign(self.church, self.treasurer,
                                       slug='cb-camp', raised=Decimal('0'),
                                       wallet=Decimal('0'))
        self.donation = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678',
            amount=Decimal('1000'), status=DonationStatus.PENDING,
            checkout_request_id='ws_CO_CB_001',
        )

    def _callback(self, body):
        return self.client.post(reverse('donation-callback'), body, format='json')

    def test_duplicate_callback_credits_exactly_once(self):
        body = _callback_body('ws_CO_CB_001', result_code=0, amount=1000)

        r1 = self._callback(body)
        self.assertEqual(r1.status_code, status.HTTP_200_OK)
        self.campaign.refresh_from_db()
        first_raised = self.campaign.raised_amount
        first_wallet = self.campaign.wallet_balance
        # Default fee 2.50% on 1000 → net 975.
        self.assertEqual(first_raised, Decimal('975.00'))
        self.assertEqual(first_wallet, Decimal('975.00'))

        # FIRE THE SAME CALLBACK AGAIN (Safaricom retry).
        r2 = self._callback(body)
        self.assertEqual(r2.status_code, status.HTTP_200_OK)

        self.campaign.refresh_from_db()
        # Balance moved EXACTLY once.
        self.assertEqual(self.campaign.raised_amount, first_raised)
        self.assertEqual(self.campaign.wallet_balance, first_wallet)
        self.donation.refresh_from_db()
        self.assertEqual(self.donation.status, DonationStatus.SUCCESSFUL)
        # Exactly one confirmation audit + one donation notification.
        self.assertEqual(
            AuditLog.objects.filter(action='DONATION_CONFIRMED',
                                    entity_id=self.donation.id).count(), 1)
        self.assertEqual(
            Notification.objects.filter(
                notification_type=NotificationType.DONATION_RECEIVED,
                related_campaign=self.campaign).count(), 1)

    def test_unknown_checkout_id_returns_200_no_mutation(self):
        body = _callback_body('ws_CO_DOES_NOT_EXIST', result_code=0, amount=1000)
        resp = self._callback(body)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('0'))
        self.donation.refresh_from_db()
        self.assertEqual(self.donation.status, DonationStatus.PENDING)

    def test_failure_resultcode_sets_failed_no_balance_change(self):
        body = _callback_body('ws_CO_CB_001', result_code=1032)  # cancelled
        resp = self._callback(body)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.donation.refresh_from_db()
        self.assertEqual(self.donation.status, DonationStatus.FAILED)
        self.assertIsNone(self.donation.net_amount)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('0'))
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))

    def test_missing_checkout_id_returns_200(self):
        resp = self._callback({'Body': {'stkCallback': {'ResultCode': 0}}})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_every_path_returns_200(self):
        # success
        self.assertEqual(
            self._callback(_callback_body('ws_CO_CB_001', result_code=0, amount=1000)).status_code,
            status.HTTP_200_OK)
        # duplicate
        self.assertEqual(
            self._callback(_callback_body('ws_CO_CB_001', result_code=0, amount=1000)).status_code,
            status.HTTP_200_OK)
        # unknown
        self.assertEqual(
            self._callback(_callback_body('ws_CO_UNKNOWN', result_code=0, amount=1000)).status_code,
            status.HTTP_200_OK)
        # failure (on a fresh pending donation)
        d2 = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678',
            amount=Decimal('500'), status=DonationStatus.PENDING,
            checkout_request_id='ws_CO_CB_FAIL')
        self.assertEqual(
            self._callback(_callback_body('ws_CO_CB_FAIL', result_code=1)).status_code,
            status.HTTP_200_OK)

    def test_callback_amount_mismatch_refuses_credit(self):
        # SECURITY: an STK push charges the EXACT initiated amount. A callback whose
        # Amount disagrees with the initiate-stored amount (1000) is not a genuine
        # confirmation (or is forged) — refuse to credit, leave the row PENDING.
        body = _callback_body('ws_CO_CB_001', result_code=0, amount=800)
        resp = self._callback(body)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.donation.refresh_from_db()
        self.assertEqual(self.donation.status, DonationStatus.PENDING)  # no credit
        self.assertIsNone(self.donation.net_amount)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('0'))
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))

    def test_callback_credits_server_stored_amount(self):
        # The credited GROSS derives from the SERVER-STORED initiate amount (1000),
        # never the POST body — matching Amount confirms; credit = 1000 net.
        body = _callback_body('ws_CO_CB_001', result_code=0, amount=1000)
        self._callback(body)
        self.donation.refresh_from_db()
        self.assertEqual(self.donation.amount, Decimal('1000'))          # server-stored GROSS
        self.assertEqual(self.donation.net_amount, Decimal('975.00'))    # 1000 − 2.5%
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('975.00'))


# ═════════════════════════════════════════════════════════════════════════════
# Live fee + forward-only
# ═════════════════════════════════════════════════════════════════════════════


class LiveFeeTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church)

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.campaign = _make_campaign(self.church, self.treasurer, slug='fee-camp')

    def _confirm(self, checkout_id, amount):
        d = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678',
            amount=Decimal(str(amount)), status=DonationStatus.PENDING,
            checkout_request_id=checkout_id)
        self.client.post(reverse('donation-callback'),
                         _callback_body(checkout_id, result_code=0, amount=amount),
                         format='json')
        d.refresh_from_db()
        return d

    def test_fee_read_live_from_platform_settings(self):
        s = PlatformSettings.load()
        s.fee_percent = Decimal('5.00')  # non-default
        s.save()

        d = self._confirm('ws_CO_FEE_1', 1000)
        self.assertEqual(d.platform_fee, Decimal('50.00'))   # 5% of 1000
        self.assertEqual(d.net_amount, Decimal('950.00'))
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('950.00'))  # by NET

    def test_fee_is_forward_only(self):
        s = PlatformSettings.load()
        s.fee_percent = Decimal('5.00')
        s.save()
        d1 = self._confirm('ws_CO_FEE_2', 1000)
        self.assertEqual(d1.platform_fee, Decimal('50.00'))

        # Change the fee AFTER the donation confirmed.
        s = PlatformSettings.load()
        s.fee_percent = Decimal('10.00')
        s.save()

        d1.refresh_from_db()
        # Old donation's stored fee/net are UNCHANGED.
        self.assertEqual(d1.platform_fee, Decimal('50.00'))
        self.assertEqual(d1.net_amount, Decimal('950.00'))

        # A new donation uses the new live rate.
        d2 = self._confirm('ws_CO_FEE_3', 1000)
        self.assertEqual(d2.platform_fee, Decimal('100.00'))  # 10%
        self.assertEqual(d2.net_amount, Decimal('900.00'))


# ═════════════════════════════════════════════════════════════════════════════
# Net-Everywhere leak check on public responses
# ═════════════════════════════════════════════════════════════════════════════


class PublicResponseLeakTests(TestCase):
    _FORBIDDEN = {'platform_fee', 'net_amount', 'fee_percent', 'wallet_balance'}

    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church)
        cls.campaign = _make_campaign(cls.church, cls.treasurer, slug='leak-camp')

    def setUp(self):
        cache.clear()
        daraja._clear_token_cache()
        self.client = APIClient()

    def test_initiate_response_has_no_fee_or_wallet(self):
        with patch.object(daraja.DarajaClient, '_http_request', side_effect=_stk_seam()):
            resp = self.client.post(reverse('donation-initiate'), {
                'campaign_slug': 'leak-camp', 'phone_number': '0712345678',
                'amount': '1000'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertTrue(self._FORBIDDEN.isdisjoint(resp.data.keys()))

    def test_status_response_gross_only_no_fee_breakdown(self):
        donation = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678',
            amount=Decimal('1000'), status=DonationStatus.PENDING,
            checkout_request_id='ws_CO_LEAK_1')
        # Confirm it (gross 1000, default fee → net 975).
        self.client.post(reverse('donation-callback'),
                         _callback_body('ws_CO_LEAK_1', result_code=0, amount=1000),
                         format='json')

        resp = self.client.get(reverse('donation-status', args=[donation.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        keys = set(resp.data.keys())
        self.assertTrue(self._FORBIDDEN.isdisjoint(keys))
        self.assertNotIn('checkout_request_id', keys)
        # Donor-facing amount is GROSS (matches the M-Pesa SMS), not net.
        self.assertEqual(Decimal(str(resp.data['amount'])), Decimal('1000.00'))
        self.assertEqual(resp.data['mpesa_receipt_number'], 'NLJ7RT61SV')

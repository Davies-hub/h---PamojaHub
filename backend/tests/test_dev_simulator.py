"""DEBUG-only Daraja callback simulator — builders + front-door delivery.

The dev trigger route (/api/v1/dev/simulate-callback/) is NOT mounted while
this suite runs: DiscoverRunner.run_tests() calls setup_test_environment()
(django/test/runner.py:1072) BEFORE the URLConf is first imported, and that
sets settings.DEBUG = False (django/test/utils.py; DiscoverRunner defaults
debug_mode=False) — so config/urls.py skips its `if settings.DEBUG:` block.
The route is therefore LIVE-GATED ONLY; DevRouteMountTests pins that fact.

Everything else here exercises what the simulator actually does: build a
synthesized body (shapes from §14.1 prose — no verbatim live capture exists)
and POST it through the REAL routed callback endpoints, asserting the real
handlers' money behavior (credit-once, duplicate no-op, forgery refusal,
failure transitions).
"""

from decimal import Decimal

from django.conf import settings
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase
from django.urls import Resolver404, resolve, reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from config.dev_simulator import (
    build_b2c_result_failure,
    build_b2c_result_success,
    build_stk_failure,
    build_stk_success,
)
from donations.models import Donation, DonationStatus
from withdrawals.models import Withdrawal, WithdrawalStatus


def _make_church():
    return Church.objects.create(
        name='Sim Church', official_email='sim@example.org', phone='254700000001',
        address='addr', county='Nairobi', denomination='PCEA',
        status=ChurchStatus.ACTIVE,
    )


def _make_treasurer(church):
    return User.objects.create_user(
        email='sim-t@example.org', password='unused', first_name='F',
        last_name='L', role=UserRole.CHURCH_TREASURER, church=church,
    )


def _make_campaign(church, treasurer, *, wallet=Decimal('0')):
    return Campaign.objects.create(
        slug='sim-fund', church=church, title='Sim Fund', description='desc',
        goal_amount=Decimal('1000000'), raised_amount=Decimal('0'),
        wallet_balance=wallet, banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING,
        treasurer_phone='254712345678', treasurer_name='Treas Urer',
        created_by=treasurer, status=CampaignStatus.ACTIVE,
    )


# ═════════════════════════════════════════════════════════════════════════════
# Builder shapes (pure functions)
# ═════════════════════════════════════════════════════════════════════════════


class BuilderShapeTests(SimpleTestCase):
    def test_stk_success_shape_carries_live_signature(self):
        body = build_stk_success('ws_CO_X', Decimal('1000.00'), '254712345678')
        stk = body['Body']['stkCallback']
        self.assertEqual(stk['ResultCode'], 0)
        items = {i['Name']: i for i in stk['CallbackMetadata']['Item']}
        # Numerics are JSON numbers, never strings (live: Amount=5).
        self.assertIsInstance(items['Amount']['Value'], int)
        self.assertIsInstance(items['TransactionDate']['Value'], int)
        self.assertIsInstance(items['PhoneNumber']['Value'], int)
        # Live signature: Balance item has NO Value key.
        self.assertNotIn('Value', items['Balance'])
        self.assertTrue(items['MpesaReceiptNumber']['Value'].startswith('SIM-'))

    def test_stk_failure_shape_has_no_metadata(self):
        body = build_stk_failure('ws_CO_X', 1032)
        stk = body['Body']['stkCallback']
        self.assertEqual(stk['ResultCode'], 1032)
        self.assertEqual(
            set(stk),
            {'MerchantRequestID', 'CheckoutRequestID', 'ResultCode', 'ResultDesc'},
        )


class DevRouteMountTests(SimpleTestCase):
    def test_simulator_route_not_mounted_in_suite(self):
        # setup_test_environment() forces DEBUG=False before the URLConf loads,
        # so the dev block never mounts here — the route is live-gated only.
        self.assertFalse(settings.DEBUG)
        with self.assertRaises(Resolver404):
            resolve('/api/v1/dev/simulate-callback/')


# ═════════════════════════════════════════════════════════════════════════════
# STK bodies through the real routed donation callback
# ═════════════════════════════════════════════════════════════════════════════


class StkSimulatedDeliveryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church)
        cls.campaign = _make_campaign(cls.church, cls.treasurer)

    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def _pending(self, checkout='ws_CO_SIM_1', amount=Decimal('1000.00')):
        return Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678', amount=amount,
            status=DonationStatus.PENDING, checkout_request_id=checkout,
        )

    def _post(self, body):
        return self.client.post(reverse('donation-callback'), body, format='json')

    def test_simulated_success_credits_net_once(self):
        donation = self._pending()
        resp = self._post(build_stk_success(
            donation.checkout_request_id, donation.amount, donation.phone_number))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        donation.refresh_from_db()
        self.assertEqual(donation.status, DonationStatus.SUCCESSFUL)
        self.assertTrue(donation.mpesa_receipt_number.startswith('SIM-'))
        self.assertEqual(donation.platform_fee, Decimal('25.00'))
        self.assertEqual(donation.net_amount, Decimal('975.00'))
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('975.00'))
        self.assertEqual(self.campaign.wallet_balance, Decimal('975.00'))

    def test_simulated_success_duplicate_second_is_noop(self):
        donation = self._pending(checkout='ws_CO_SIM_2')
        body = build_stk_success(
            donation.checkout_request_id, donation.amount, donation.phone_number)
        self._post(body)
        donation.refresh_from_db()
        first_receipt = donation.mpesa_receipt_number

        resp = self._post(body)  # Safaricom-retry replay: byte-identical body
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        donation.refresh_from_db()
        self.assertEqual(donation.mpesa_receipt_number, first_receipt)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('975.00'))

    def test_simulated_amount_mismatch_refused_row_stays_pending(self):
        donation = self._pending(checkout='ws_CO_SIM_3')
        # amount_override path: body says 99, server-stored amount is 1000.
        resp = self._post(build_stk_success(
            donation.checkout_request_id, Decimal('99'), donation.phone_number))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)  # 200, but no credit
        donation.refresh_from_db()
        self.assertEqual(donation.status, DonationStatus.PENDING)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))

    def test_simulated_failure_1032_marks_failed(self):
        donation = self._pending(checkout='ws_CO_SIM_4')
        resp = self._post(build_stk_failure(donation.checkout_request_id, 1032))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        donation.refresh_from_db()
        self.assertEqual(donation.status, DonationStatus.FAILED)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))


# ═════════════════════════════════════════════════════════════════════════════
# B2C bodies through the real routed b2c-result callback
# ═════════════════════════════════════════════════════════════════════════════


class B2CSimulatedDeliveryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church()
        cls.treasurer = _make_treasurer(cls.church)
        cls.campaign = _make_campaign(cls.church, cls.treasurer,
                                      wallet=Decimal('5000'))

    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def _processing(self, conv='AG_SIM_1', amount=Decimal('1000')):
        return Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone='254712345678',
            destination_phone='254712345678', destination_name='Treas Urer',
            amount=amount, reason='materials',
            status=WithdrawalStatus.PROCESSING, b2c_conversation_id=conv,
        )

    def _post(self, body):
        return self.client.post(reverse('withdrawal-b2c-result'), body,
                                format='json')

    def test_simulated_b2c_success_pays_exactly_once(self):
        wd = self._processing()
        body = build_b2c_result_success(wd.b2c_conversation_id, '', wd.amount)
        resp = self._post(body)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PAID)
        self.assertTrue(wd.payout_reference.startswith('SIM-'))
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('4000'))

        resp = self._post(body)  # replay — must not decrement again
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('4000'))

    def test_simulated_b2c_2040_marks_failed(self):
        wd = self._processing(conv='AG_SIM_2')
        resp = self._post(build_b2c_result_failure(
            wd.b2c_conversation_id, '', 2040))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        wd.refresh_from_db()
        # retry_count 0 < MAX_RETRIES → treasurer-retriable FAILED, not FINAL.
        self.assertEqual(wd.status, WithdrawalStatus.FAILED)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('5000'))

    def test_failed_row_late_success_finalizes_paid(self):
        """Pins deliberate design: FAILED is never permanent; a genuine late
        success must finalize PAID or a treasurer retry double-pays. Owner
        decision 2026-07-17. If this fails, someone added FAILED to
        RESULT_CALLBACK_IGNORED_STATUSES — stop and escalate.
        """
        wd = Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone='254712345678',
            destination_phone='254712345678', destination_name='Treas Urer',
            amount=Decimal('1000'), reason='materials',
            status=WithdrawalStatus.FAILED, retry_count=0,
            b2c_conversation_id='AG_SIM_LATE_1',
            failure_reason='M-Pesa reported the payout failed.',
        )
        body = build_b2c_result_success(wd.b2c_conversation_id, '', wd.amount)
        resp = self._post(body)
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        wd.refresh_from_db()
        self.assertEqual(wd.status, WithdrawalStatus.PAID)
        self.assertTrue(wd.payout_reference.startswith('SIM-'))
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('4000'))

        resp = self._post(body)  # replay — PAID is in the ignored tuple
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('4000'))

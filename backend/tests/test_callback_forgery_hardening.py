"""Forged-callback hardening (CRITICAL money-security) — all three payment callbacks.

Closes the forged-callback money-injection via:
  (1) a settings-driven SECRET PATH SEGMENT on every callback route — a POST to the
      bare path (no secret) 404s at the router; and
  (2) a per-shape AMOUNT/IDENTITY cross-check — the donation/subscription callback
      credits/activates the SERVER-STORED expected amount and refuses to grant on an
      amount mismatch; the B2C result callback correlates only to a dispatched row by
      a server-generated id (never client-supplied) and finalizes idempotently.

These tests REQUIRE a non-empty MPESA_CALLBACK_SECRET (development.py sets one), so
reverse('<name>-callback') yields the secret path while the bare path 404s. Disposable
test DB only (the runner creates/drops test_<db>, never pamoja_dev).
"""

from decimal import Decimal

from django.conf import settings
from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import (
    Church, ChurchStatus, SubscriptionPayment, SubscriptionPaymentStatus,
    SubscriptionTier,
)
from donations.models import Donation, DonationStatus
from withdrawals.models import Withdrawal, WithdrawalStatus


# Bare (pre-fix) callback paths — what a forger who doesn't know the secret hits.
BARE_DONATION = '/api/v1/donations/callback/'
BARE_SUBSCRIPTION = '/api/v1/subscriptions/callback/'
BARE_B2C = '/api/v1/withdrawals/b2c-result/'


def _church(tier=SubscriptionTier.FREE):
    return Church.objects.create(
        name='H Church', official_email='h@example.org', phone='254700000001',
        address='addr', county='Nairobi', denomination='PCEA',
        status=ChurchStatus.ACTIVE, subscription_tier=tier,
    )


def _treasurer(church):
    return User.objects.create_user(
        email='ht@example.org', password='unused', first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _campaign(church, treasurer, *, wallet=Decimal('0'), raised=Decimal('0')):
    return Campaign.objects.create(
        slug='h-camp', church=church, title='H', description='d',
        goal_amount=Decimal('1000000'), raised_amount=raised, wallet_balance=wallet,
        banner_image_url='https://example.org/x.png', category=CampaignCategory.BUILDING,
        treasurer_phone='254712345678', treasurer_name='T', created_by=treasurer,
        status=CampaignStatus.ACTIVE,
    )


def _stk_body(checkout_id, *, result_code=0, amount=None, receipt='NLJ7RT61SV'):
    stk = {
        'MerchantRequestID': 'mr', 'CheckoutRequestID': checkout_id,
        'ResultCode': result_code, 'ResultDesc': 'd',
    }
    if result_code == 0:
        stk['CallbackMetadata'] = {'Item': [
            {'Name': 'Amount', 'Value': amount},
            {'Name': 'MpesaReceiptNumber', 'Value': receipt},
        ]}
    return {'Body': {'stkCallback': stk}}


def _b2c_body(*, conversation_id='', originator_id='', result_code=0, tx='TX-1'):
    return {'Result': {
        'ConversationID': conversation_id, 'OriginatorConversationID': originator_id,
        'ResultCode': result_code, 'TransactionID': tx,
    }}


# ═════════════════════════════════════════════════════════════════════════════
# Sanity: the secret is configured and baked into the reversed routes
# ═════════════════════════════════════════════════════════════════════════════


class SecretPathConfigTests(TestCase):
    def test_secret_set_and_routes_carry_it(self):
        self.assertTrue(settings.MPESA_CALLBACK_SECRET,
                        'tests require a non-empty MPESA_CALLBACK_SECRET')
        seg = f'/{settings.MPESA_CALLBACK_SECRET}/'
        self.assertTrue(reverse('donation-callback').endswith(seg))
        self.assertTrue(reverse('subscription-callback').endswith(seg))
        self.assertTrue(reverse('withdrawal-b2c-result').endswith(seg))
        # And the bare paths are NOT the live routes.
        self.assertNotEqual(reverse('donation-callback'), BARE_DONATION)


# ═════════════════════════════════════════════════════════════════════════════
# (1) SECRET PATH — forged POST to the bare path 404s, no mutation
# ═════════════════════════════════════════════════════════════════════════════


class BarePath404Tests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.church = _church()
        self.treasurer = _treasurer(self.church)
        self.campaign = _campaign(self.church, self.treasurer, wallet=Decimal('5000'))

    def test_donation_forge_bare_path_404(self):
        Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678', amount=Decimal('1000'),
            status=DonationStatus.PENDING, checkout_request_id='ws_CO_B1')
        resp = self.client.post(
            BARE_DONATION, _stk_body('ws_CO_B1', amount=999999), format='json')
        self.assertEqual(resp.status_code, 404)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('0'))

    def test_subscription_forge_bare_path_404(self):
        SubscriptionPayment.objects.create(
            church=self.church, tier=SubscriptionTier.GROWTH, amount=Decimal('999'),
            phone_number='254712345678', status=SubscriptionPaymentStatus.PENDING,
            checkout_request_id='ws_CO_B2')
        resp = self.client.post(BARE_SUBSCRIPTION, _stk_body('ws_CO_B2', amount=999),
                                format='json')
        self.assertEqual(resp.status_code, 404)
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(self.church.subscription_expires_at)

    def test_b2c_forge_bare_path_404(self):
        w = Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone='254712345678',
            amount=Decimal('5000'), destination_phone='254712345678',
            destination_name='D', reason='r', status=WithdrawalStatus.PROCESSING,
            b2c_conversation_id='CID-B3')
        resp = self.client.post(
            BARE_B2C, _b2c_body(conversation_id='CID-B3'), format='json')
        self.assertEqual(resp.status_code, 404)
        w.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(w.status, WithdrawalStatus.PROCESSING)
        self.assertEqual(self.campaign.wallet_balance, Decimal('5000'))


# ═════════════════════════════════════════════════════════════════════════════
# (2) AMOUNT CROSS-CHECK — mismatch on the SECRET path is rejected (no credit)
# ═════════════════════════════════════════════════════════════════════════════


class AmountMismatchTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.church = _church()
        self.treasurer = _treasurer(self.church)
        self.campaign = _campaign(self.church, self.treasurer)

    def test_donation_amount_mismatch_no_credit(self):
        d = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678', amount=Decimal('1000'),
            status=DonationStatus.PENDING, checkout_request_id='ws_CO_M1')
        # Secret path, but the forged Amount (999999) != server-stored 1000.
        resp = self.client.post(
            reverse('donation-callback'), _stk_body('ws_CO_M1', amount=999999),
            format='json')
        self.assertEqual(resp.status_code, 200)   # 200 so Safaricom stops retrying
        d.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(d.status, DonationStatus.PENDING)   # NOT credited
        self.assertIsNone(d.net_amount)
        self.assertEqual(self.campaign.raised_amount, Decimal('0'))
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))

    def test_subscription_amount_mismatch_no_grant(self):
        pay = SubscriptionPayment.objects.create(
            church=self.church, tier=SubscriptionTier.GROWTH, amount=Decimal('999'),
            phone_number='254712345678', status=SubscriptionPaymentStatus.PENDING,
            checkout_request_id='ws_CO_M2')
        resp = self.client.post(
            reverse('subscription-callback'), _stk_body('ws_CO_M2', amount=1),
            format='json')
        self.assertEqual(resp.status_code, 200)
        pay.refresh_from_db()
        self.church.refresh_from_db()
        self.assertEqual(pay.status, SubscriptionPaymentStatus.PENDING)   # no grant
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(self.church.subscription_expires_at)


# ═════════════════════════════════════════════════════════════════════════════
# (3) LEGITIMATE callback on the SECRET path still works — exactly once
# ═════════════════════════════════════════════════════════════════════════════


class LegitimateOnSecretPathTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.church = _church()
        self.treasurer = _treasurer(self.church)
        self.campaign = _campaign(self.church, self.treasurer, wallet=Decimal('5000'))

    def test_donation_legit_credits_exactly_once(self):
        d = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678', amount=Decimal('1000'),
            status=DonationStatus.PENDING, checkout_request_id='ws_CO_L1')
        body = _stk_body('ws_CO_L1', amount=1000)   # matches server-stored amount
        r1 = self.client.post(reverse('donation-callback'), body, format='json')
        self.assertEqual(r1.status_code, 200)
        d.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(d.status, DonationStatus.SUCCESSFUL)
        self.assertEqual(self.campaign.raised_amount, Decimal('975.00'))  # 1000 − 2.5%
        # Idempotent: a Safaricom retry credits no second time.
        r2 = self.client.post(reverse('donation-callback'), body, format='json')
        self.assertEqual(r2.status_code, 200)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.raised_amount, Decimal('975.00'))

    def test_subscription_legit_activates_once(self):
        pay = SubscriptionPayment.objects.create(
            church=self.church, tier=SubscriptionTier.GROWTH, amount=Decimal('999'),
            phone_number='254712345678', status=SubscriptionPaymentStatus.PENDING,
            checkout_request_id='ws_CO_L2')
        body = _stk_body('ws_CO_L2', amount=999)
        r1 = self.client.post(reverse('subscription-callback'), body, format='json')
        self.assertEqual(r1.status_code, 200)
        pay.refresh_from_db()
        self.church.refresh_from_db()
        self.assertEqual(pay.status, SubscriptionPaymentStatus.SUCCESSFUL)
        self.assertEqual(self.church.subscription_tier, SubscriptionTier.GROWTH)
        first_expiry = self.church.subscription_expires_at
        self.assertIsNotNone(first_expiry)
        # Idempotent: duplicate does not double-extend.
        r2 = self.client.post(reverse('subscription-callback'), body, format='json')
        self.assertEqual(r2.status_code, 200)
        self.church.refresh_from_db()
        self.assertEqual(self.church.subscription_expires_at, first_expiry)

    def test_b2c_legit_flips_once(self):
        w = Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone='254712345678',
            amount=Decimal('5000'), destination_phone='254712345678',
            destination_name='D', reason='r', status=WithdrawalStatus.PROCESSING,
            b2c_conversation_id='CID-L3')
        body = _b2c_body(conversation_id='CID-L3', tx='TX-L3')
        r1 = self.client.post(reverse('withdrawal-b2c-result'), body, format='json')
        self.assertEqual(r1.status_code, 200)
        w.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(w.status, WithdrawalStatus.PAID)
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))   # 5000 − 5000
        # Idempotent: duplicate result does not double-decrement.
        r2 = self.client.post(reverse('withdrawal-b2c-result'), body, format='json')
        self.assertEqual(r2.status_code, 200)
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.wallet_balance, Decimal('0'))


# ═════════════════════════════════════════════════════════════════════════════
# (3e) B2C IDENTITY — a forged success cannot flip a non-dispatched / unknown row
# ═════════════════════════════════════════════════════════════════════════════


class B2CIdentityTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.church = _church()
        self.treasurer = _treasurer(self.church)
        self.campaign = _campaign(self.church, self.treasurer, wallet=Decimal('5000'))

    def test_forged_success_unknown_id_no_flip(self):
        # A never-dispatched PENDING_APPROVAL row carries NO conversation/originator id,
        # so a forged result with an arbitrary id correlates to nothing → 200 no-op.
        w = Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone='254712345678',
            amount=Decimal('5000'), destination_phone='254712345678',
            destination_name='D', reason='r', status=WithdrawalStatus.PENDING_APPROVAL)
        resp = self.client.post(
            reverse('withdrawal-b2c-result'),
            _b2c_body(conversation_id='CID-GUESSED', originator_id='ORIG-GUESSED'),
            format='json')
        self.assertEqual(resp.status_code, 200)
        w.refresh_from_db()
        self.campaign.refresh_from_db()
        self.assertEqual(w.status, WithdrawalStatus.PENDING_APPROVAL)   # untouched
        self.assertEqual(self.campaign.wallet_balance, Decimal('5000'))

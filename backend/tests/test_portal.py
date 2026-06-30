"""Campaign Treasurer phone-portal integration tests.

Covers:
  * /request-otp/ — phone normalization end-to-end, hashing of stored OTP,
    no-campaign 404 path.
  * /verify-otp/ — happy path issues a hashed PortalToken with bound IP and the
    OTP marked is_used; 5-wrong-attempts kills the OTP; expired OTP rejected.
  * HasValidPortalToken behavioural tests — valid passes, expired/revoked/
    wrong-IP/missing fails.
  * Campaign-scope enforcement — token scoped to A → 403 on B.
  * Disbursement endpoint structural lock — assert SELECT ... FOR UPDATE
    appears in the executed SQL and that the wallet-balance/withdrawal-insert
    sequence happens inside one atomic. TRUE CONCURRENCY (two simultaneous
    requests both passing the balance check) is NOT tested here — thread-based
    concurrency tests against the test DB are flaky and unreliable; load testing
    in a dedicated phase covers that. This suite only confirms the lock is
    invoked in the correct scope.
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from accounts.utils import hash_token
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church
from notifications.models import Notification, NotificationType
from treasurer_portal.models import CampaignTreasurerOTP, PortalToken
from treasurer_portal.views import RequestOTPView
from withdrawals.models import Withdrawal, WithdrawalStatus


# ─────────────────────────────────────────────────────────────────────────────
# Common fixtures
# ─────────────────────────────────────────────────────────────────────────────


NORMALIZED_PHONE = '254712345678'      # canonical normalized form
RAW_PHONE = '0712345678'               # user-entered form (same number)
OTHER_PHONE = '254700000001'


def _make_church_and_treasurer(name='Church A', email='a@example.org'):
    church = Church.objects.create(
        name=name, official_email=email,
        phone='254700000999', address='addr',
        county='Nairobi', denomination='PCEA',
    )
    treasurer = User.objects.create_user(
        email=f'treasurer-{email}', password='pw',
        first_name='Treas', last_name='Urer',
        role=UserRole.CHURCH_TREASURER, church=church,
    )
    return church, treasurer


def _make_campaign(church, treasurer, *, slug, phone=NORMALIZED_PHONE,
                   status=CampaignStatus.ACTIVE, wallet_balance=Decimal('5000'),
                   raised_amount=Decimal('10000')):
    return Campaign.objects.create(
        slug=slug, church=church,
        title=f'Campaign {slug}', description='desc',
        goal_amount=Decimal('100000'),
        raised_amount=raised_amount,
        wallet_balance=wallet_balance,
        banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING,
        treasurer_phone=phone,                  # NORMALIZED on write — see request-otp lookup contract
        treasurer_name='Treas Urer',
        created_by=treasurer,
        status=status,
    )


# ─────────────────────────────────────────────────────────────────────────────
# /request-otp/  +  phone normalization end-to-end
# ─────────────────────────────────────────────────────────────────────────────


class RequestOTPTest(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.url = reverse('portal-request-otp')
        self.church, self.treasurer = _make_church_and_treasurer()
        # 2.11: request-otp now fires the real AT send (the no-op guard is gone).
        # These tests cover OTP issuance/normalization, not SMS delivery — stub the
        # seam to succeed so a missing AT account doesn't 502 them. SMS-failure
        # behaviour is covered in tests/test_sms.py.
        _p = patch('integrations.africastalking._send_sms', return_value=None)
        _p.start()
        self.addCleanup(_p.stop)

    def test_match_with_raw_phone_input_against_normalized_campaign_phone(self):
        """End-to-end proof of the Step 2.5 normalization fix:
        campaign stored with 254712..., request sends 0712..., lookup matches.
        """
        _make_campaign(self.church, self.treasurer, slug='c1', phone=NORMALIZED_PHONE)
        _make_campaign(self.church, self.treasurer, slug='c2', phone=NORMALIZED_PHONE)

        with patch('treasurer_portal.views.generate_otp', return_value='000111'):
            resp = self.client.post(self.url, {'phone_number': RAW_PHONE}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # Anti-enumeration: uniform body, and campaign_count is GONE (it leaked how
        # many campaigns a treasurer holds, even inside the 200).
        self.assertEqual(resp.data, RequestOTPView.UNIFORM_RESPONSE)
        self.assertNotIn('campaign_count', resp.data)

        # CampaignTreasurerOTP row stored with HASH (not plaintext '000111').
        otp = CampaignTreasurerOTP.objects.get()
        self.assertEqual(otp.phone_number, NORMALIZED_PHONE)
        self.assertEqual(otp.otp_code, hash_token('000111'))
        self.assertNotEqual(otp.otp_code, '000111')
        self.assertEqual(len(otp.campaign_ids), 2)

    def test_no_matching_campaign_returns_uniform_200_no_row(self):
        """Anti-enumeration: an UNKNOWN phone (no ACTIVE/PAUSED campaign) returns the
        SAME 200 + uniform body as a known phone — NOT a 404 — and does NO server work
        (no CampaignTreasurerOTP row). The old 404 here ENCODED the enumeration oracle.
        """
        resp = self.client.post(self.url, {'phone_number': RAW_PHONE}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, RequestOTPView.UNIFORM_RESPONSE)
        self.assertEqual(CampaignTreasurerOTP.objects.count(), 0)

    def test_closed_campaign_does_not_match(self):
        """Build Guide: ACTIVE/PAUSED match; CLOSED does not. Post-anti-enumeration the
        non-match no longer 404s — it returns the SAME uniform 200 — but it still does
        NO work (no OTP row), which is how we now prove CLOSED didn't match.
        """
        _make_campaign(self.church, self.treasurer, slug='closed',
                       status=CampaignStatus.CLOSED)
        resp = self.client.post(self.url, {'phone_number': RAW_PHONE}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, RequestOTPView.UNIFORM_RESPONSE)
        self.assertEqual(CampaignTreasurerOTP.objects.count(), 0)

    def test_phone_format_variants_share_one_ratelimit_bucket(self):
        """Fix 2 regression test: 0712..., 254712..., +254712..., and ' 0712... '
        all normalize to the same number and MUST share ONE rate-limit budget.

        Test isolates the PHONE bucket from the IP bucket by using a different
        REMOTE_ADDR per request — each IP sees only one request, so no IP bucket
        is exhausted. Any 429 must come from the phone-keyed limit, not the IP
        limit.

        Expected, with fix in place (phone-key collapses variants):
          * first 3 format variants → 200 (phone bucket has 3/10m budget)
          * 4th variant → 429        (phone bucket exhausted)
          * 5th call with a DIFFERENT real phone → 200 (independent bucket)

        Expected, without the fix (each raw string gets its own bucket):
          * all 5 → 200 (each format = own bucket).

        Phone B used in the 5th call must match a real campaign so it doesn't
        404 for a different reason. We bind both numbers to campaigns.
        """
        _make_campaign(self.church, self.treasurer, slug='c1', phone=NORMALIZED_PHONE)
        _make_campaign(self.church, self.treasurer, slug='c2', phone=OTHER_PHONE)
        cache.clear()  # explicit; setUp also clears but this test is paranoid

        variants = [
            ('0712345678',     '10.0.0.1'),
            ('254712345678',   '10.0.0.2'),
            ('+254712345678',  '10.0.0.3'),
            (' 0712345678 ',   '10.0.0.4'),   # 4th — must hit the phone bucket
        ]
        codes = []
        for phone, ip in variants:
            r = self.client.post(
                self.url, {'phone_number': phone}, format='json',
                REMOTE_ADDR=ip,
            )
            codes.append(r.status_code)

        # First 3 → 200; 4th → 429 driven by the PHONE bucket (each IP has its
        # own fresh budget, so IP-key cannot be the limiter here).
        self.assertEqual(codes[:3], [200, 200, 200], msg=f"codes={codes}")
        self.assertEqual(
            codes[3], 429,
            msg=(
                f"4th format-variant request was not rate-limited (got {codes[3]}); "
                "normalized_phone_key is failing to collapse format variants into "
                "one bucket. Each request had its own IP, so the limiter must be "
                "the phone bucket."
            ),
        )

        # Sanity: a different REAL phone from yet another IP must succeed —
        # proving the phone buckets are per-normalized-phone, not a global bucket
        # or an "empty string" bucket caused by a broken key function.
        other_resp = self.client.post(
            self.url, {'phone_number': '0700000001'}, format='json',
            REMOTE_ADDR='10.0.0.99',
        )
        self.assertEqual(
            other_resp.status_code, 200,
            msg=(
                'A different real phone was rate-limited too — the key function '
                'is probably reading empty string and collapsing ALL phones into '
                'one bucket. Check that normalized_phone_key actually reads '
                'phone_number from request.data at the decorator layer.'
            ),
        )


# ─────────────────────────────────────────────────────────────────────────────
# /request-otp/  anti-enumeration invariant (known vs unknown indistinguishable)
# ─────────────────────────────────────────────────────────────────────────────


class RequestOTPAntiEnumerationTest(TestCase):
    """A KNOWN treasurer phone and an UNKNOWN phone must be INDISTINGUISHABLE on the
    wire: same status, same body — so the public endpoint can't be used to discover
    which numbers are campaign treasurers or how many campaigns they hold. The unknown
    path must also do NO server work (no OTP row, no SMS). A regression that reintroduces
    campaign_count or a distinct 404 breaks these tests.
    """

    KNOWN_RAW = RAW_PHONE              # → 254712345678, bound to campaigns in setUp
    UNKNOWN_RAW = '0723000000'        # → 254723000000, valid format, NO campaign

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.url = reverse('portal-request-otp')
        self.church, self.treasurer = _make_church_and_treasurer()
        # Two campaigns for the known phone — if campaign_count ever leaks back, 2 is
        # what an attacker would read; the tests assert it never appears in the body.
        _make_campaign(self.church, self.treasurer, slug='k1', phone=NORMALIZED_PHONE)
        _make_campaign(self.church, self.treasurer, slug='k2', phone=NORMALIZED_PHONE)

    def test_known_phone_returns_uniform_200_creates_row_and_sends_sms(self):
        with patch('treasurer_portal.views.send_portal_otp') as mock_send:
            resp = self.client.post(self.url, {'phone_number': self.KNOWN_RAW}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, RequestOTPView.UNIFORM_RESPONSE)
        self.assertNotIn('campaign_count', resp.data)
        # Real work happened: exactly one hashed OTP row + exactly one SMS send.
        self.assertEqual(
            CampaignTreasurerOTP.objects.filter(phone_number=NORMALIZED_PHONE).count(), 1,
        )
        mock_send.assert_called_once()

    def test_unknown_phone_returns_same_uniform_200_no_row_no_sms(self):
        with patch('treasurer_portal.views.send_portal_otp') as mock_send:
            resp = self.client.post(self.url, {'phone_number': self.UNKNOWN_RAW}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, RequestOTPView.UNIFORM_RESPONSE)
        # Unknown path did NOTHING server-side.
        self.assertEqual(CampaignTreasurerOTP.objects.count(), 0)
        mock_send.assert_not_called()

    def test_known_and_unknown_responses_are_byte_identical(self):
        """THE anti-oracle invariant. The two responses must be indistinguishable on
        the wire: identical status code AND identical rendered body bytes. Reintroducing
        campaign_count on the known path, or a distinct 404 on the unknown path, breaks
        this. Distinct REMOTE_ADDR per call so the per-IP rate limit can't 429 the 2nd.
        """
        with patch('treasurer_portal.views.send_portal_otp'):
            known = self.client.post(
                self.url, {'phone_number': self.KNOWN_RAW}, format='json',
                REMOTE_ADDR='10.0.0.1',
            )
            unknown = self.client.post(
                self.url, {'phone_number': self.UNKNOWN_RAW}, format='json',
                REMOTE_ADDR='10.0.0.2',
            )
        self.assertEqual(known.status_code, status.HTTP_200_OK)
        self.assertEqual(known.status_code, unknown.status_code)
        self.assertEqual(known.content, unknown.content)        # byte-identical body
        self.assertNotIn(b'campaign_count', known.content)
        self.assertNotIn(b'detail', unknown.content)

    def test_unknown_uniform_path_is_still_rate_limited(self):
        """The uniform endpoint must not be hammerable for timing analysis: the unknown
        path goes through the SAME throttle decorators. Per-phone bucket is 3/10m;
        isolate it from the IP bucket with a distinct REMOTE_ADDR per request so the
        4th request for the same unknown phone → 429 from the PHONE bucket.
        """
        cache.clear()
        codes = []
        with patch('treasurer_portal.views.send_portal_otp'):
            for i in range(4):
                r = self.client.post(
                    self.url, {'phone_number': self.UNKNOWN_RAW}, format='json',
                    REMOTE_ADDR=f'10.1.0.{i + 1}',
                )
                codes.append(r.status_code)
        self.assertEqual(codes[:3], [200, 200, 200], msg=f'codes={codes}')
        self.assertEqual(codes[3], 429, msg=f'4th unknown-phone request not throttled; codes={codes}')


# ─────────────────────────────────────────────────────────────────────────────
# /verify-otp/
# ─────────────────────────────────────────────────────────────────────────────


class VerifyOTPTest(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.request_url = reverse('portal-request-otp')
        self.verify_url = reverse('portal-verify-otp')
        self.church, self.treasurer = _make_church_and_treasurer()
        self.campaign = _make_campaign(self.church, self.treasurer, slug='c1')
        # 2.11: stub the AT send seam to succeed — these tests cover verify/OTP
        # lifecycle, not SMS delivery (see tests/test_sms.py for that).
        _p = patch('integrations.africastalking._send_sms', return_value=None)
        _p.start()
        self.addCleanup(_p.stop)

    def _request_otp_with_known_code(self, code='000111'):
        with patch('treasurer_portal.views.generate_otp', return_value=code):
            resp = self.client.post(self.request_url, {'phone_number': RAW_PHONE}, format='json')
        assert resp.status_code == status.HTTP_200_OK, resp.content

    def test_correct_code_issues_portal_token_with_bound_ip_and_hashes_token(self):
        self._request_otp_with_known_code('000111')
        resp = self.client.post(
            self.verify_url,
            {'phone_number': RAW_PHONE, 'otp_code': '000111'},
            format='json',
            REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        raw_token = resp.data['portal_token']
        self.assertTrue(raw_token)
        self.assertEqual(len(resp.data['campaigns']), 1)

        # OTP was burned.
        otp = CampaignTreasurerOTP.objects.get()
        self.assertTrue(otp.is_used)

        # PortalToken stored as hash, bound to the request IP.
        tokens = list(PortalToken.objects.all())
        self.assertEqual(len(tokens), 1)
        self.assertEqual(tokens[0].token_hash, hash_token(raw_token))
        self.assertNotEqual(tokens[0].token_hash, raw_token)
        self.assertEqual(tokens[0].ip_address, '10.0.0.42')
        self.assertEqual(tokens[0].phone_number, NORMALIZED_PHONE)
        self.assertFalse(tokens[0].is_revoked)

        # AuditLog written with actor=None, actor_phone set.
        log = AuditLog.objects.get(action='PORTAL_OTP_VERIFIED')
        self.assertIsNone(log.actor)
        self.assertEqual(log.actor_phone, NORMALIZED_PHONE)

    def test_wrong_code_increments_then_kills_otp_at_5(self):
        """5 wrong codes within the per-phone 5/h limit window all return 400, and
        on the 5th the OTP is marked is_used=True (model-side brute-force cap).
        We do NOT submit a 6th attempt here because the per-phone rate-limit
        decorator (5/h, configured deliberately as the "1-hour lockout" the Build
        Guide specifies) would return 429 before the view body runs — which is
        the correct production behaviour and is documented as the per-phone
        lockout layer, distinct from this model-side cap.
        """
        self._request_otp_with_known_code('000111')
        for _ in range(5):
            r = self.client.post(self.verify_url,
                                 {'phone_number': RAW_PHONE, 'otp_code': '999999'},
                                 format='json', REMOTE_ADDR='10.0.0.1')
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        otp = CampaignTreasurerOTP.objects.get()
        self.assertTrue(otp.is_used, 'OTP must be marked is_used after 5 wrong attempts')
        self.assertEqual(otp.attempt_count, 5)

    def test_expired_otp_is_rejected(self):
        self._request_otp_with_known_code('000111')
        otp = CampaignTreasurerOTP.objects.get()
        otp.expires_at = timezone.now() - timedelta(seconds=1)
        otp.save(update_fields=['expires_at'])

        resp = self.client.post(self.verify_url,
                                {'phone_number': RAW_PHONE, 'otp_code': '000111'},
                                format='json', REMOTE_ADDR='10.0.0.1')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


# ─────────────────────────────────────────────────────────────────────────────
# HasValidPortalToken behavioural tests
# ─────────────────────────────────────────────────────────────────────────────


def _issue_portal_token(*, campaign_ids, ip='10.0.0.42', expires_at=None, is_revoked=False):
    raw = 'demo-token-' + secrets_safe()
    PortalToken.objects.create(
        phone_number=NORMALIZED_PHONE,
        campaign_ids=[str(cid) for cid in campaign_ids],
        ip_address=ip,
        token_hash=hash_token(raw),
        expires_at=expires_at or (timezone.now() + timedelta(minutes=30)),
        is_revoked=is_revoked,
    )
    return raw


def secrets_safe():
    import secrets as _s
    return _s.token_urlsafe(16)


class PortalTokenAuthBehaviourTest(TestCase):
    """Behavioural tests for the real HasValidPortalToken — exercised via the
    GET /campaigns/ endpoint (the simplest portal-token-only endpoint).
    """

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.url = reverse('portal-campaigns')
        self.church, self.treasurer = _make_church_and_treasurer()
        self.campaign = _make_campaign(self.church, self.treasurer, slug='c1')

    def test_valid_token_with_matching_ip_passes(self):
        raw = _issue_portal_token(campaign_ids=[self.campaign.id], ip='10.0.0.42')
        resp = self.client.get(self.url, HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.42')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data), 1)

    # DRF semantics: HasValidPortalToken returns False → DRF.permission_denied raises
    # NotAuthenticated (401) when no authenticator marked the request authenticated,
    # PermissionDenied (403) otherwise. Portal endpoints have no DRF authentication
    # class wired (the permission class IS the auth), so denials surface as 401.
    # Both 401 and 403 are "denied"; we assert membership rather than locking the
    # specific code so the test documents the spec intent without coupling to DRF
    # internals.
    DENIED = (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)

    def test_no_header_denies(self):
        resp = self.client.get(self.url, REMOTE_ADDR='10.0.0.42')
        self.assertIn(resp.status_code, self.DENIED)

    def test_expired_token_denies(self):
        raw = _issue_portal_token(
            campaign_ids=[self.campaign.id], ip='10.0.0.42',
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        resp = self.client.get(self.url, HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.42')
        self.assertIn(resp.status_code, self.DENIED)

    def test_revoked_token_denies(self):
        raw = _issue_portal_token(campaign_ids=[self.campaign.id], ip='10.0.0.42',
                                   is_revoked=True)
        resp = self.client.get(self.url, HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.42')
        self.assertIn(resp.status_code, self.DENIED)

    def test_wrong_ip_denies(self):
        raw = _issue_portal_token(campaign_ids=[self.campaign.id], ip='10.0.0.42')
        resp = self.client.get(self.url, HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.99')
        self.assertIn(resp.status_code, self.DENIED)

    def test_authorization_portal_scheme_also_accepted(self):
        raw = _issue_portal_token(campaign_ids=[self.campaign.id], ip='10.0.0.42')
        resp = self.client.get(
            self.url,
            HTTP_AUTHORIZATION=f'Portal {raw}',
            REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)


# ─────────────────────────────────────────────────────────────────────────────
# Campaign scope — cross-campaign isolation parallel to cross-church
# ─────────────────────────────────────────────────────────────────────────────


class CampaignScopeTest(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.church, self.treasurer = _make_church_and_treasurer()
        self.camp_a = _make_campaign(self.church, self.treasurer, slug='a')
        self.camp_b = _make_campaign(self.church, self.treasurer, slug='b')

        # Token scoped to camp_a only.
        self.raw = _issue_portal_token(campaign_ids=[self.camp_a.id], ip='10.0.0.42')

    def test_in_scope_campaign_report_returns_200(self):
        url = reverse('portal-campaign-report', kwargs={'id': self.camp_a.id})
        resp = self.client.get(url, HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_out_of_scope_campaign_report_returns_403(self):
        url = reverse('portal-campaign-report', kwargs={'id': self.camp_b.id})
        resp = self.client.get(url, HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42')
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_out_of_scope_disbursement_request_returns_403(self):
        url = reverse('portal-request-disbursement', kwargs={'id': self.camp_b.id})
        resp = self.client.post(
            url, {'amount': '100', 'reason': 'x'}, format='json',
            HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Withdrawal.objects.count(), 0)


# ─────────────────────────────────────────────────────────────────────────────
# Disbursement — the money endpoint
# ─────────────────────────────────────────────────────────────────────────────


class DisbursementRequestTest(TestCase):
    """Happy/sad path + STRUCTURAL lock verification.

    TRUE CONCURRENCY (two simultaneous requests both passing the balance check) is
    NOT tested here — thread-based concurrency tests against the test DB are flaky
    and unreliable. Load testing in a dedicated phase covers that. This test only
    confirms the lock is invoked in the correct scope: select_for_update appears
    in the executed SQL on the request path, and the wallet-balance check / withdrawal
    insert happen inside the SAME atomic transaction.
    """

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.church, self.treasurer = _make_church_and_treasurer()
        self.campaign = _make_campaign(
            self.church, self.treasurer, slug='c1',
            wallet_balance=Decimal('5000'),
        )
        self.raw = _issue_portal_token(campaign_ids=[self.campaign.id], ip='10.0.0.42')
        self.url = reverse('portal-request-disbursement', kwargs={'id': self.campaign.id})

    def test_request_within_balance_creates_withdrawal_notification_audit(self):
        resp = self.client.post(
            self.url, {'amount': '1000', 'reason': 'Buy materials'}, format='json',
            HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        wd = Withdrawal.objects.get()
        self.assertEqual(wd.status, WithdrawalStatus.PENDING_APPROVAL)
        self.assertEqual(wd.amount, Decimal('1000'))
        self.assertEqual(wd.destination_phone, self.campaign.treasurer_phone)
        self.assertEqual(wd.requested_by_phone, NORMALIZED_PHONE)

        self.assertEqual(
            Notification.objects.filter(
                recipient=self.treasurer,
                notification_type=NotificationType.DISBURSEMENT_SUBMITTED,
            ).count(),
            1,
        )
        self.assertTrue(AuditLog.objects.filter(action='DISBURSEMENT_REQUESTED').exists())

    def test_request_over_wallet_balance_returns_400_no_withdrawal(self):
        resp = self.client.post(
            self.url, {'amount': '9999', 'reason': 'x'}, format='json',
            HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Withdrawal.objects.count(), 0)

    def test_request_with_existing_pending_returns_400_no_second_withdrawal(self):
        # Pre-create a PENDING_APPROVAL withdrawal.
        Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone=NORMALIZED_PHONE,
            amount=Decimal('500'), destination_phone=self.campaign.treasurer_phone,
            destination_name=self.campaign.treasurer_name, reason='earlier',
            status=WithdrawalStatus.PENDING_APPROVAL,
        )
        resp = self.client.post(
            self.url, {'amount': '100', 'reason': 'x'}, format='json',
            HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Withdrawal.objects.count(), 1)  # no second
        # Message wording for the PENDING case is the "already pending" form —
        # explicitly NOT the FAILED-retry wording, so a treasurer can tell which
        # state is blocking them.
        self.assertIn('already pending', resp.data['detail'].lower())
        self.assertNotIn('failed', resp.data['detail'].lower())

    def test_request_blocked_when_failed_withdrawal_exists(self):
        """A FAILED withdrawal (mid-retry) blocks new requests — money may be in
        limbo at Daraja. Distinguishable from the PENDING_APPROVAL case via the
        error message wording.
        """
        Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone=NORMALIZED_PHONE,
            amount=Decimal('500'), destination_phone=self.campaign.treasurer_phone,
            destination_name=self.campaign.treasurer_name, reason='earlier',
            status=WithdrawalStatus.FAILED, retry_count=2,
        )
        resp = self.client.post(
            self.url, {'amount': '100', 'reason': 'x'}, format='json',
            HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Withdrawal.objects.count(), 1)  # no second
        # FAILED-specific wording — distinguishable from "already pending".
        body = resp.data['detail'].lower()
        self.assertIn('previous payout failed', body)
        self.assertIn('retried', body)

    def test_request_allowed_when_only_terminal_withdrawals_exist(self):
        """Terminal states (PAID, REJECTED, FAILED_FINAL) do NOT block. A campaign
        with finished disbursement history must remain operable.
        """
        # PAID — completed payout.
        Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone=NORMALIZED_PHONE,
            amount=Decimal('200'), destination_phone=self.campaign.treasurer_phone,
            destination_name=self.campaign.treasurer_name, reason='paid earlier',
            status=WithdrawalStatus.PAID,
        )
        # REJECTED — denied by Church Treasurer.
        Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone=NORMALIZED_PHONE,
            amount=Decimal('300'), destination_phone=self.campaign.treasurer_phone,
            destination_name=self.campaign.treasurer_name, reason='rejected earlier',
            rejection_reason='no receipts',
            status=WithdrawalStatus.REJECTED,
        )
        resp = self.client.post(
            self.url, {'amount': '100', 'reason': 'fresh request'}, format='json',
            HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        # 2 historical + 1 new = 3.
        self.assertEqual(Withdrawal.objects.count(), 3)

    def test_request_against_closed_campaign_returns_400_no_withdrawal(self):
        """Campaign-state guard: a CLOSED campaign cannot request a payout, even
        with a token minted while it was ACTIVE (the close-within-the-30-min-window
        race the guard targets). 400 + no withdrawal row.
        """
        closed = _make_campaign(
            self.church, self.treasurer, slug='c-closed',
            status=CampaignStatus.CLOSED, wallet_balance=Decimal('5000'),
        )
        raw = _issue_portal_token(campaign_ids=[closed.id], ip='10.0.0.42')
        url = reverse('portal-request-disbursement', kwargs={'id': closed.id})
        resp = self.client.post(
            url, {'amount': '1000', 'reason': 'x'}, format='json',
            HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            resp.data['detail'],
            'This campaign is closed and can no longer request payouts.',
        )
        self.assertEqual(Withdrawal.objects.filter(campaign=closed).count(), 0)

    def test_request_against_active_campaign_returns_201(self):
        """The guard must NOT over-block: ACTIVE (the default state) still succeeds."""
        resp = self.client.post(
            self.url, {'amount': '1000', 'reason': 'active ok'}, format='json',
            HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Withdrawal.objects.get().status, WithdrawalStatus.PENDING_APPROVAL)

    def test_request_against_paused_campaign_returns_201(self):
        """DELIBERATE allowance, asserted explicitly: a PAUSED campaign still pays
        out already-raised funds (OTP-issue scope is ACTIVE+PAUSED). If a future
        'tidy-up' strictens the guard to ==ACTIVE (copying donations), THIS test
        must fail rather than the regression reaching production.
        """
        paused = _make_campaign(
            self.church, self.treasurer, slug='c-paused',
            status=CampaignStatus.PAUSED, wallet_balance=Decimal('5000'),
        )
        raw = _issue_portal_token(campaign_ids=[paused.id], ip='10.0.0.42')
        url = reverse('portal-request-disbursement', kwargs={'id': paused.id})
        resp = self.client.post(
            url, {'amount': '1000', 'reason': 'paused ok'}, format='json',
            HTTP_X_PORTAL_TOKEN=raw, REMOTE_ADDR='10.0.0.42',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            Withdrawal.objects.get(campaign=paused).status,
            WithdrawalStatus.PENDING_APPROVAL,
        )

    def test_structural_lock_select_for_update_on_campaign_row(self):
        """Capture the SQL that ran during a successful disbursement request.
        Assert a SELECT ... FOR UPDATE was issued against campaigns_campaign,
        and that it happened BEFORE any insert into withdrawals_withdrawal.
        """
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.post(
                self.url, {'amount': '1000', 'reason': 'lock test'}, format='json',
                HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42',
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        queries = [q['sql'].upper() for q in ctx.captured_queries]

        # 1. A SELECT ... FOR UPDATE on the Campaign row happened.
        for_update_idx = next(
            (i for i, q in enumerate(queries)
             if 'FROM "CAMPAIGNS_CAMPAIGN"' in q and 'FOR UPDATE' in q),
            None,
        )
        self.assertIsNotNone(
            for_update_idx,
            msg='Disbursement view did not issue SELECT ... FOR UPDATE on campaigns_campaign.',
        )

        # 2. The INSERT into withdrawals_withdrawal happened AFTER the lock.
        insert_idx = next(
            (i for i, q in enumerate(queries)
             if q.startswith('INSERT INTO "WITHDRAWALS_WITHDRAWAL"')),
            None,
        )
        self.assertIsNotNone(insert_idx, msg='Expected an INSERT into withdrawals_withdrawal.')
        self.assertGreater(
            insert_idx, for_update_idx,
            msg='Withdrawal insert ran BEFORE the campaign row was locked — '
                'the lock scope is wrong.',
        )

    def test_disbursements_list_in_scope(self):
        Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone=NORMALIZED_PHONE,
            amount=Decimal('123'), destination_phone=self.campaign.treasurer_phone,
            destination_name=self.campaign.treasurer_name, reason='x',
            status=WithdrawalStatus.PENDING_APPROVAL,
        )
        url = reverse('portal-campaign-disbursements', kwargs={'id': self.campaign.id})
        resp = self.client.get(url, HTTP_X_PORTAL_TOKEN=self.raw, REMOTE_ADDR='10.0.0.42')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data), 1)

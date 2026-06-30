"""Campaign Treasurer phone-portal endpoints (PRD §8.5).

SECURITY model (cf. Compressed Context Section 7):
  * Campaign Treasurers have no Django user account — they authenticate by phone +
    SMS OTP (request-otp / verify-otp), receiving a short-lived (30 min) IP-bound
    portal token. All other portal endpoints validate that token via
    common.permissions.HasValidPortalToken.
  * The portal token is sent via the X-Portal-Token header (or `Authorization:
    Portal <raw>`) so it never collides with the Church Treasurer's JWT Bearer auth.
  * OTPs and portal tokens are stored only as SHA-256 hashes; plaintext crosses the
    wire (SMS or HTTP response) exactly once and is never persisted.
  * Disbursement requests acquire SELECT FOR UPDATE on the Campaign row before the
    wallet-balance check, holding the lock through the Withdrawal insert — two
    concurrent requests serialize, and the second observes the first's pending
    withdrawal (or the new balance) before deciding.

Deferred (flagged for later steps):
  * CSV/PDF export on the donation report endpoint — currently 501.
  * Real AT SMS send — integrations/africastalking.send_portal_otp logs in DEBUG;
    real SDK call lands in Step 2.11.
  * True concurrency / race tests for the wallet lock — flaky against test DBs;
    handled by load testing in a dedicated phase.
"""

import logging
import secrets
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from django.utils.decorators import method_decorator
from django_ratelimit.decorators import ratelimit
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User, UserRole
from accounts.utils import generate_otp, hash_token
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignStatus
from common.pagination import StandardPagination
from common.permissions import HasValidPortalToken
from common.ratelimit_keys import normalized_phone_key
from donations.models import Donation, DonationStatus
from donations.serializers import PortalDonationReportSerializer
from integrations.africastalking import send_portal_otp, SMSDeliveryError
from notifications.models import Notification, NotificationType
from treasurer_portal.models import CampaignTreasurerOTP, PortalToken
from treasurer_portal.serializers import (
    OTPRequestSerializer,
    OTPVerifySerializer,
    PortalCampaignSerializer,
)
from withdrawals.models import (
    BLOCKING_WITHDRAWAL_STATUSES,
    Withdrawal,
    WithdrawalStatus,
)
from withdrawals.serializers import WithdrawalRequestSerializer, WithdrawalSerializer


logger = logging.getLogger(__name__)


# ───────────────────────── helpers ────────────────────────────────────────────


def _client_ip(request):
    return request.META.get('REMOTE_ADDR') or ''


def _campaign_in_scope(request, campaign_id) -> bool:
    """Is `campaign_id` in this portal token's scoped campaign_ids?

    campaign_ids is a JSONField holding UUID strings. Compare via str() on both
    sides so a UUID object vs string never causes a silent miss.
    """
    return str(campaign_id) in request.portal_token.campaign_ids


# ───────────────────── 2.8.2  POST /request-otp/ ──────────────────────────────


# Phone-keyed limit uses normalized_phone_key (Fix 2): 0712..., 254712..., +254712...,
# and whitespace variants all share ONE budget. The string-key form
# `'post:phone_number'` would let an attacker multiply their SMS budget by
# submitting format variants of the same real phone.
@method_decorator(ratelimit(key=normalized_phone_key, rate='3/10m', method='POST', block=True), name='post')
@method_decorator(ratelimit(key='ip',                 rate='3/10m', method='POST', block=True), name='post')
class RequestOTPView(APIView):
    """POST /api/v1/treasurer/request-otp/ — no auth, rate-limited 3/10m per phone AND per IP.

    PHONE NORMALIZATION: the serializer's validate_phone_number routes through
    common.validators.validate_safaricom_phone, returning the normalized 254XXXXXXXXX
    form. The campaign-treasurer-phone lookup compares against the SAME normalized
    string. Campaign.treasurer_phone is normalized on write by
    AdminCampaignSerializer.validate_treasurer_phone; any campaigns inserted via the
    ORM directly (tests, fixtures) MUST use the normalized form.
    """

    permission_classes = [AllowAny]

    # Anti-enumeration (security): the response to a KNOWN treasurer phone and an
    # UNKNOWN phone is BYTE-IDENTICAL — same 200, same body — so the public endpoint
    # cannot be used to discover which numbers are campaign treasurers, nor how many
    # campaigns one holds. campaign_count was dropped (an oracle even inside the 200).
    # The phrasing is conditional so an unregistered caller is not falsely promised an
    # SMS while a registered one still understands. Residual: TIMING differs (the known
    # path does hash + DB write + SMS the unknown path skips) — accepted, low value
    # against a network-jittered remote attacker; see the uniform-response test in
    # tests/test_portal.py. (The SMS-failure 502 on the known path is preserved so a
    # real treasurer learns their code did not send — it is not an attacker-controllable
    # per-phone signal, so it is not a usable oracle.)
    UNIFORM_RESPONSE = {'message': 'If this number is registered, a code has been sent.'}

    def post(self, request):
        serializer = OTPRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        phone = serializer.validated_data['phone_number']  # normalized

        campaign_ids = list(
            Campaign.objects
            .filter(
                treasurer_phone=phone,
                status__in=[CampaignStatus.ACTIVE, CampaignStatus.PAUSED],
            )
            .values_list('id', flat=True)
        )

        if not campaign_ids:
            # UNKNOWN phone: short-circuit to the IDENTICAL 200 + uniform body. Do NOT
            # generate an OTP, create a CampaignTreasurerOTP row, or send an SMS — there
            # is no treasurer to send to (an SMS here would be a pure cost vector). A
            # response byte-identical to the known path below is the anti-enumeration
            # invariant.
            return Response(self.UNIFORM_RESPONSE, status=status.HTTP_200_OK)

        # Invalidate any older unused OTPs for this phone so only the newest is live.
        CampaignTreasurerOTP.objects.filter(phone_number=phone, is_used=False).update(is_used=True)

        otp_plain = generate_otp()
        CampaignTreasurerOTP.objects.create(
            phone_number=phone,
            otp_code=hash_token(otp_plain),                 # HASH only — plaintext goes to SMS once
            campaign_ids=[str(cid) for cid in campaign_ids],
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        # The OTP send IS the operation, not a courtesy: if it fails, the user
        # must NOT be told "code sent". Surface the failure (502) so they retry.
        # The OTP row already exists but is harmless — it expires unused, and the
        # next request invalidates older unused OTPs for this phone.
        try:
            send_portal_otp(phone, otp_plain)
        except SMSDeliveryError:
            logger.exception('Portal OTP SMS delivery failed for a request')
            return Response(
                {'detail': 'Could not send the verification code. Please try again.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # KNOWN path: identical uniform body to the unknown path above (only timing
        # differs — accepted residual). Never leak campaign_count.
        return Response(self.UNIFORM_RESPONSE, status=status.HTTP_200_OK)


# ───────────────────── 2.8.3  POST /verify-otp/ ───────────────────────────────


# Per-phone 1-hour lockout — uses normalized_phone_key (Fix 2) for the same
# reason as RequestOTPView: format variants of one real phone share one bucket.
@method_decorator(ratelimit(key=normalized_phone_key, rate='5/h', method='POST', block=True), name='post')
class VerifyOTPView(APIView):
    """POST /api/v1/treasurer/verify-otp/.

    Two layers of brute-force defence:
      * per-phone 5/hour decorator (rate-limit): after 5 verify attempts in an hour,
        all attempts for that phone are 429 until the window clears. This is the
        "1-hour lockout" the Build Guide specifies.
      * per-OTP attempt_count (model): each wrong code increments; at MAX_ATTEMPTS
        the OTP is marked is_used=True and a new request-otp is required.

    The two layers are complementary: the decorator caps total tries per phone; the
    model counter caps tries against the specific outstanding OTP.
    """

    permission_classes = [AllowAny]
    MAX_ATTEMPTS = 5
    GENERIC_INVALID = {'detail': 'Invalid or expired code.'}

    def post(self, request):
        serializer = OTPVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        phone = serializer.validated_data['phone_number']  # normalized
        otp_code = serializer.validated_data['otp_code']

        otp = (
            CampaignTreasurerOTP.objects
            .filter(phone_number=phone, is_used=False, expires_at__gt=timezone.now())
            .order_by('-created_at')
            .first()
        )
        if otp is None:
            return Response(self.GENERIC_INVALID, status=status.HTTP_400_BAD_REQUEST)

        otp.attempt_count += 1
        if otp.attempt_count >= self.MAX_ATTEMPTS:
            otp.is_used = True
            otp.save(update_fields=['attempt_count', 'is_used'])
            return Response(self.GENERIC_INVALID, status=status.HTTP_400_BAD_REQUEST)

        if hash_token(otp_code) != otp.otp_code:
            otp.save(update_fields=['attempt_count'])
            return Response(self.GENERIC_INVALID, status=status.HTTP_400_BAD_REQUEST)

        ip = _client_ip(request)
        with transaction.atomic():
            otp.is_used = True
            otp.save(update_fields=['attempt_count', 'is_used'])

            raw_token = secrets.token_urlsafe(32)
            PortalToken.objects.create(
                phone_number=phone,
                campaign_ids=list(otp.campaign_ids),
                ip_address=ip,                              # MANDATORY — permission fails closed without it
                token_hash=hash_token(raw_token),
                expires_at=timezone.now() + timedelta(minutes=30),
            )
            AuditLog.objects.create(
                actor=None,
                actor_phone=phone,
                action='PORTAL_OTP_VERIFIED',
                entity_type='CampaignTreasurerOTP',
                entity_id=otp.id,
                details={'campaign_count': len(otp.campaign_ids)},
                ip_address=ip or None,
            )

        scoped_campaigns = Campaign.objects.filter(id__in=otp.campaign_ids)
        return Response(
            {
                'portal_token': raw_token,
                'campaigns': PortalCampaignSerializer(scoped_campaigns, many=True).data,
            },
            status=status.HTTP_200_OK,
        )


# ───────────────────── 2.8.4  GET /campaigns/ ─────────────────────────────────


class PortalCampaignListView(APIView):
    """GET /api/v1/treasurer/campaigns/ — list this token's scoped campaigns.

    The token only sees its scoped campaigns. We do NOT return all campaigns and
    rely on the serializer to mask — we filter at the queryset (parallel rule to
    the ChurchScopedPermission list-endpoint invariant).
    """

    permission_classes = [HasValidPortalToken]

    def get(self, request):
        campaigns = Campaign.objects.filter(id__in=request.portal_token.campaign_ids)
        return Response(PortalCampaignSerializer(campaigns, many=True).data)


# ───────────────────── 2.8.5  GET /campaigns/{id}/report/ ─────────────────────


class PortalDonationReportView(APIView):
    """GET /api/v1/treasurer/campaigns/{id}/report/ — paginated SUCCESSFUL donations.

    amount = net_amount per Net-Everywhere (enforced inside PortalDonationReportSerializer).
    Donor phone numbers are NOT included (donor privacy).
    """

    permission_classes = [HasValidPortalToken]
    pagination_class = StandardPagination

    def get(self, request, id):
        if not _campaign_in_scope(request, id):
            return Response(
                {'detail': 'Campaign is not in scope for this portal token.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        # CSV / PDF export deferred — see module docstring.
        fmt = request.query_params.get('format')
        if fmt in ('csv', 'pdf'):
            return Response(
                {'detail': f'{fmt.upper()} export is not yet implemented; coming in a later step.'},
                status=status.HTTP_501_NOT_IMPLEMENTED,
            )

        qs = (
            Donation.objects
            .filter(campaign_id=id, status=DonationStatus.SUCCESSFUL)
            .order_by('-created_at')
        )

        date_from = request.query_params.get('from')
        date_to = request.query_params.get('to')
        if date_from:
            qs = qs.filter(created_at__gte=date_from)
        if date_to:
            qs = qs.filter(created_at__lte=date_to)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        data = PortalDonationReportSerializer(page, many=True).data
        return paginator.get_paginated_response(data)


# ───────────────────── 2.8.6  POST /request-disbursement/ ────────────────────


class PortalRequestDisbursementView(APIView):
    """POST /api/v1/treasurer/campaigns/{id}/request-disbursement/.

    THE MONEY ENDPOINT. SELECT FOR UPDATE acquired on the Campaign row BEFORE the
    wallet-balance read; transaction held through the Withdrawal insert. Two
    simultaneous requests serialize on the row lock: the second one waits for the
    first to commit, then either (a) sees the new wallet_balance and re-evaluates,
    or (b) sees the freshly-inserted PENDING_APPROVAL withdrawal and is rejected.
    """

    permission_classes = [HasValidPortalToken]

    def post(self, request, id):
        if not _campaign_in_scope(request, id):
            return Response(
                {'detail': 'Campaign is not in scope for this portal token.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        serializer = WithdrawalRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        amount = serializer.validated_data['amount']
        reason = serializer.validated_data['reason']

        with transaction.atomic():
            # (1) Lock acquired FIRST — before the balance read.
            try:
                campaign = Campaign.objects.select_for_update().get(id=id)
            except Campaign.DoesNotExist:
                return Response(
                    {'detail': 'Campaign not found.'},
                    status=status.HTTP_404_NOT_FOUND,
                )

            # (1b) Campaign-state guard — read off the freshly-LOCKED row so a
            # close committed by another txn before this one acquired the lock is
            # observed (the race a token minted while ACTIVE, then campaign CLOSED
            # within the 30-min window, targets). We reject CLOSED *explicitly*
            # (== CLOSED), NOT `status not in {ACTIVE, PAUSED}`: PAUSED is a
            # deliberate allowance (a paused campaign still pays out already-raised
            # funds — see the OTP-issue scope ACTIVE+PAUSED), and a future status
            # must not be silently blocked here by accident. Contrast donations,
            # which require strict ==ACTIVE (forward money-IN must stop when paused);
            # money-OUT is intentionally different.
            if campaign.status == CampaignStatus.CLOSED:
                return Response(
                    {'detail': 'This campaign is closed and can no longer request payouts.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # (2) Blocking-withdrawal guard — one outstanding payout per campaign
            # (Build Guide), extended to include FAILED. Rationale: a FAILED
            # withdrawal (retry_count < 5) represents money in limbo — the B2C
            # leg might have actually succeeded despite a failure report (known
            # M-Pesa edge case). Allowing a new request while a FAILED one is
            # unresolved risks double-paying. FAILED_FINAL / REJECTED / PAID are
            # terminal/resolved states and do NOT block.
            #
            # SAFETY DEPENDENCY (now satisfied by Step 2.10c): FAILED is driven to
            # PAID (sweep/callback) or escalated to FAILED_FINAL at retry exhaustion;
            # NEEDS_RECONCILIATION is the explicit money-in-limbo freeze. The set is
            # the single source of truth in withdrawals.models (BLOCKING_WITHDRAWAL_STATUSES)
            # so the sweep, callback, and this guard can never drift apart.
            blocking = (
                Withdrawal.objects
                .filter(campaign=campaign, status__in=BLOCKING_WITHDRAWAL_STATUSES)
                .order_by('-created_at')
                .first()
            )
            if blocking is not None:
                if blocking.status == WithdrawalStatus.NEEDS_RECONCILIATION:
                    msg = (
                        'A previous payout is being reconciled with M-Pesa. '
                        'Please wait for it to be resolved before requesting another.'
                    )
                elif blocking.status == WithdrawalStatus.FAILED:
                    msg = (
                        'A previous payout failed and is being retried. '
                        'Please wait for it to resolve before requesting another.'
                    )
                else:
                    msg = 'A payout request is already pending for this campaign.'
                return Response(
                    {'detail': msg},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # (3) Balance check against the locked, fresh wallet_balance.
            if amount > campaign.wallet_balance:
                return Response(
                    {'detail': 'Amount exceeds available wallet balance.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # (4) Withdrawal insert — still inside the locked atomic.
            withdrawal = Withdrawal.objects.create(
                campaign=campaign,
                requested_by_phone=request.portal_token.phone_number,
                destination_phone=campaign.treasurer_phone,
                destination_name=campaign.treasurer_name,
                amount=amount,
                reason=reason,
                status=WithdrawalStatus.PENDING_APPROVAL,
            )

            # (5) Notify every Church Treasurer for this church. 0 treasurers is a
            # degenerate state (church without a registered treasurer) — log and
            # continue; AuditLog still fires.
            recipients = User.objects.filter(
                church=campaign.church, role=UserRole.CHURCH_TREASURER,
            )
            for recipient in recipients:
                Notification.objects.create(
                    recipient=recipient,
                    notification_type=NotificationType.DISBURSEMENT_SUBMITTED,
                    title='New payout request',
                    message=(
                        f"A new payout request of KES {amount} has been submitted "
                        f"for campaign {campaign.title}."
                    ),
                    related_campaign=campaign,
                    related_withdrawal=withdrawal,
                )

            # (6) AuditLog — actor=None (no user account), actor_phone set.
            AuditLog.objects.create(
                actor=None,
                actor_phone=request.portal_token.phone_number,
                action='DISBURSEMENT_REQUESTED',
                entity_type='Withdrawal',
                entity_id=withdrawal.id,
                details={'campaign_id': str(campaign.id), 'amount': str(amount)},
                ip_address=_client_ip(request) or None,
            )

        return Response(
            WithdrawalSerializer(withdrawal).data,
            status=status.HTTP_201_CREATED,
        )


# ───────────────────── 2.8.7  GET /campaigns/{id}/disbursements/ ─────────────


class PortalCampaignDisbursementsView(APIView):
    """GET /api/v1/treasurer/campaigns/{id}/disbursements/ — read-only list."""

    permission_classes = [HasValidPortalToken]

    def get(self, request, id):
        if not _campaign_in_scope(request, id):
            return Response(
                {'detail': 'Campaign is not in scope for this portal token.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        qs = Withdrawal.objects.filter(campaign_id=id).order_by('-created_at')
        return Response(WithdrawalSerializer(qs, many=True).data)

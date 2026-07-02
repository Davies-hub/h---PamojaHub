"""Church endpoints (Step 2.9a) — public browse + the authenticated treasurer's own church.

Surfaces:
  * GET  /api/v1/churches/                         — public, AllowAny, list ACTIVE churches.
  * GET  /api/v1/churches/{id}/                    — public, AllowAny, ACTIVE-only detail (404 otherwise).
  * GET  /api/v1/churches/me/                      — IsChurchTreasurer, the treasurer's own church.
  * PATCH /api/v1/churches/me/                     — ChurchNotSuspended, partial-update own church.
  * GET  /api/v1/churches/me/stats/                — IsChurchTreasurer, dashboard summary derived from this church's
                                                     campaigns, withdrawals, and donations. Net-Everywhere applied
                                                     via PortalDonationReportSerializer (donor phone NOT exposed).

Multi-tenant isolation:
  Public surfaces filter by status=ACTIVE — they never see the requester's own church beyond what a stranger would.
  The `me` endpoints scope by request.user.church directly (no church-id in URL, so no cross-church probe surface).
  The `me/stats/` aggregates filter every query by `church=request.user.church` — leak surface is the get_queryset
  equivalent in each aggregate. Verified by tests/test_church_scoped_endpoints.py.

SUSPENDED enforcement:
  PATCH /me/ uses ChurchNotSuspended (view-level declarative gate) — replaces the
  prior inline `if church.status == SUSPENDED: return 403` check. GET /me/ and
  GET /me/stats/ stay open to SUSPENDED churches (they can still SEE their data).

Stats aggregation Coalesce:
  A church with zero campaigns: Sum returns None, not 0. We wrap each Sum in
  Coalesce so the response always contains a Decimal number (defaulting to 0)
  rather than null. .count() already returns 0 for empty querysets, but the
  Sum aggregations don't — confirmed by test_stats_for_church_with_no_campaigns_returns_zeros.
"""

import logging
import uuid
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.conf import settings
from django.db import transaction
from django.db.models import DecimalField, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import status
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignStatus
from churches.models import (
    REMINDER_STAGE_NONE,
    Church,
    ChurchStatus,
    SubscriptionPayment,
    SubscriptionPaymentStatus,
    SubscriptionTier,
)
from churches.serializers import (
    AdminChurchSerializer,
    PublicChurchSerializer,
    SubscriptionInitiateSerializer,
)
from churches.services import set_church_tier
from common.pagination import StandardPagination
from common.permissions import ChurchNotSuspended, IsChurchTreasurer
from donations.models import Donation, DonationStatus
from donations.serializers import PortalDonationReportSerializer
from donations.views import _extract_stk_callback
from integrations.daraja import DarajaClient, STKPushError
from integrations.object_storage import ObjectStorageClient, ObjectStorageError
from media.models import MediaAsset, MediaKind
from media.replace import delete_prior_assets
from media.validation import MAX_UPLOAD_BYTES, validate_and_reencode
from notifications.models import Notification, NotificationType
from superadmin.models import PlatformSettings
# _parse_date_param: the single date-param parser (YYYY-MM-DD → date, or DRF 400 on
# malformed). Imported (not copied) so /me/donations/ shares the analytics endpoints'
# exact behaviour — same cross-app private-helper reuse as `_extract_stk_callback` above.
from superadmin.views import _parse_date_param
from withdrawals.models import Withdrawal, WithdrawalStatus


logger = logging.getLogger(__name__)


def _client_ip(request):
    """REMOTE_ADDR for audit (mirrors superadmin.views._client_ip)."""
    return request.META.get('REMOTE_ADDR') or ''


# ───────────────────── Public church browse ──────────────────────────────────


class PublicChurchListView(APIView):
    """GET /api/v1/churches/ — paginated list of ACTIVE churches only.

    PENDING/SUSPENDED churches MUST NOT appear in public browse (avoids leaking
    in-flight or disciplined accounts to donors).
    """

    permission_classes = [AllowAny]
    pagination_class = StandardPagination

    def get(self, request):
        qs = Church.objects.filter(status=ChurchStatus.ACTIVE).order_by('name')

        search = request.query_params.get('search', '').strip()
        county = request.query_params.get('county', '').strip()
        denomination = request.query_params.get('denomination', '').strip()
        if search:
            qs = qs.filter(name__icontains=search)
        if county:
            qs = qs.filter(county__iexact=county)
        if denomination:
            qs = qs.filter(denomination__iexact=denomination)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        data = PublicChurchSerializer(page, many=True).data
        return paginator.get_paginated_response(data)


class PublicChurchDetailView(APIView):
    """GET /api/v1/churches/{id}/ — ACTIVE-only detail.

    Non-ACTIVE (PENDING/SUSPENDED) → 404, NOT 403. We do not reveal that a
    non-active church exists at the URL — distinct only as "no such church"
    from a donor's perspective.
    """

    permission_classes = [AllowAny]

    def get(self, request, id):
        try:
            church = Church.objects.get(id=id, status=ChurchStatus.ACTIVE)
        except Church.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(PublicChurchSerializer(church).data)


# ───────────────────── Treasurer's own church (me) ───────────────────────────


class ChurchMeView(APIView):
    """GET/PATCH /api/v1/churches/me/ — the requesting treasurer's own church.

    Permission switching (per-method):
      * GET   → [IsChurchTreasurer] (reads allowed for SUSPENDED churches).
      * PATCH → [ChurchNotSuspended] (state-changing denial when SUSPENDED).

    Multi-tenant: there is no church-id in the URL; the church is always
    request.user.church. A treasurer who somehow had church=None would have
    been rejected by IsChurchTreasurer / ChurchNotSuspended at the role check;
    we still guard defensively here.
    """

    def get_permissions(self):
        if self.request.method == 'PATCH':
            return [ChurchNotSuspended()]
        return [IsChurchTreasurer()]

    def _church(self, request):
        return getattr(request.user, 'church', None)

    def get(self, request):
        church = self._church(request)
        if church is None:
            return Response({'detail': 'No church associated with this account.'},
                            status=status.HTTP_404_NOT_FOUND)
        return Response(AdminChurchSerializer(church).data)

    def patch(self, request):
        # SUSPENDED denial handled view-level by ChurchNotSuspended (see get_permissions).
        church = self._church(request)
        if church is None:
            return Response({'detail': 'No church associated with this account.'},
                            status=status.HTTP_404_NOT_FOUND)
        serializer = AdminChurchSerializer(church, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


class ChurchLogoUploadView(APIView):
    """POST /api/v1/churches/me/logo/ — upload the logo for the treasurer's OWN church.
    Self-scoped: the church is ALWAYS request.user.church. This endpoint reads NO church id
    from the URL (route has no param) or the body — a client-supplied church_id is ignored,
    which is what makes self-scope structural, not incidental. logo_url is server-set here
    (read_only on AdminChurchSerializer since Slice 1). Guard order mirrors the banner endpoint:
      1. ChurchNotSuspended (view-level) — fails closed on church=None and on SUSPENDED.
      2. DoS gate — declared-size reject, then capped read.
      3. Content gate — validate_and_reencode (magic-byte + Pillow decode + re-encode); the
         RE-ENCODED bytes are stored, never the raw upload.
      4. put_object BEFORE the metadata commit — a failed commit leaves a harmless orphan
         object, never a dangling logo_url.
    """
    parser_classes = [MultiPartParser]

    def get_permissions(self):
        return [ChurchNotSuspended()]

    def post(self, request):
        church = getattr(request.user, 'church', None)     # self-scope — the ONLY source of church
        if church is None:                                 # defensive; ChurchNotSuspended already guarantees non-None
            return Response({'detail': 'No church associated with this account.'},
                            status=status.HTTP_404_NOT_FOUND)

        uploaded = request.FILES.get('file')
        if uploaded is None:
            return Response({'detail': 'No file provided (field name: file).'},
                            status=status.HTTP_400_BAD_REQUEST)

        if uploaded.size > MAX_UPLOAD_BYTES:                # DoS gate (declared size)
            return Response({'detail': 'File too large (max 5 MB).'},
                            status=status.HTTP_400_BAD_REQUEST)
        raw = uploaded.read(MAX_UPLOAD_BYTES + 1)           # capped read
        if len(raw) > MAX_UPLOAD_BYTES:
            return Response({'detail': 'File too large (max 5 MB).'},
                            status=status.HTTP_400_BAD_REQUEST)

        clean_bytes, content_type = validate_and_reencode(raw)   # content gate (raises → 400)

        ext = 'jpg' if content_type == 'image/jpeg' else 'png'
        key = f'church/{church.id}/logo/{uuid.uuid4().hex}.{ext}'   # server keygen, church from token

        client = ObjectStorageClient()
        try:
            result = client.put_object(key, clean_bytes, content_type)   # store CLEAN bytes
        except ObjectStorageError:
            return Response({'detail': 'Could not store the image. Please retry.'},
                            status=status.HTTP_502_BAD_GATEWAY)

        with transaction.atomic():                          # metadata AFTER confirmed PUT
            asset = MediaAsset.objects.create(
                kind=MediaKind.LOGO, church=church, campaign=None,
                object_key=result['key'], bucket=settings.S3_BUCKET_NAME,
                content_type=content_type, size_bytes=len(clean_bytes),
                uploaded_by=request.user,
            )
            church.logo_url = result['url']
            church.save(update_fields=['logo_url'])
            AuditLog.objects.create(
                actor=request.user, action='CHURCH_LOGO_UPLOADED',
                entity_type='Church', entity_id=church.id,
                details={'church_id': str(church.id), 'object_key': result['key'],
                         'asset_id': str(asset.id)},
                ip_address=_client_ip(request) or None,
            )
        # Replace: drop the church's PRIOR logos (object + row), best-effort, post-commit.
        # OUTSIDE the atomic block so a delete failure cannot roll back the new asset.
        delete_prior_assets(church, MediaKind.LOGO, asset.id)
        return Response(AdminChurchSerializer(church).data, status=status.HTTP_200_OK)


# ───────────────────── Treasurer dashboard summary ───────────────────────────


class ChurchMeStatsView(APIView):
    """GET /api/v1/churches/me/stats/ — derived dashboard numbers.

    Every aggregate filters by `church=request.user.church`. No leak surface
    beyond that filter — confirmed by the cross-church list-leak probe in
    tests/test_church_scoped_endpoints.py.

    Coalesce: a church with zero campaigns gets total_raised=Sum→None from the
    ORM. Coalesce(Sum(...), Value(0)) forces a 0 default at the DB level so
    the response always carries a Decimal, never null. .count() already returns
    0 for empty querysets, so active_campaigns/pending_disbursements need no
    Coalesce wrapping.

    permission_classes = [IsChurchTreasurer]
      * Read endpoint — SUSPENDED churches still see their stats.
    """

    permission_classes = [IsChurchTreasurer]

    def get(self, request):
        church = getattr(request.user, 'church', None)
        if church is None:
            return Response({'detail': 'No church associated with this account.'},
                            status=status.HTTP_404_NOT_FOUND)

        # ───── leak surface: all four querysets filter by church ─────
        church_campaigns_qs = Campaign.objects.filter(church=church)
        active_campaigns_count = church_campaigns_qs.filter(status=CampaignStatus.ACTIVE).count()

        # Sum across the church's campaigns — NET per Net-Everywhere.
        # Coalesce default: returns Decimal('0') (not null) for a church with
        # zero campaigns or null totals.
        zero = Value(Decimal('0'), output_field=DecimalField(max_digits=12, decimal_places=2))
        sums = church_campaigns_qs.aggregate(
            total_raised=Coalesce(Sum('raised_amount'), zero),
            total_wallet=Coalesce(Sum('wallet_balance'), zero),
        )
        total_raised = sums['total_raised']
        wallet_balance = sums['total_wallet']

        pending_disbursements = Withdrawal.objects.filter(
            campaign__church=church,
            status=WithdrawalStatus.PENDING_APPROVAL,
        ).count()

        # Recent 10 SUCCESSFUL donations across THIS church's campaigns, NET amounts.
        recent_donations_qs = (
            Donation.objects
            .filter(campaign__church=church, status=DonationStatus.SUCCESSFUL)
            .order_by('-created_at')[:10]
        )
        recent_donations = PortalDonationReportSerializer(recent_donations_qs, many=True).data

        return Response({
            'total_raised': str(total_raised),
            'wallet_balance': str(wallet_balance),
            'active_campaigns': active_campaigns_count,
            'pending_disbursements': pending_disbursements,
            'recent_donations': recent_donations,
        })


# ───────────────────── Treasurer donation list (reports source) ───────────────


class ChurchMeDonationsView(APIView):
    """GET /api/v1/churches/me/donations/ — this church's full SUCCESSFUL donation
    history, paginated, NET-only. The JWT church-scoped source for the treasurer
    Reports screen's Donation History (the unbounded sibling of /me/stats/'s
    recent-10 feed).

    LEAK SURFACE: the queryset filters by `campaign__church=request.user.church`
    (the same FK-hop guard as the withdrawals list). That single filter is the
    only thing standing between this treasurer and every church's donations —
    verified by the cross-church leak probe in tests/test_church_scoped_endpoints.py.

    Net-Everywhere: rows are serialized by PortalDonationReportSerializer, so the
    wire carries `amount` = net_amount and the donor-private / gross fields
    (gross amount, platform_fee, phone_number, donor_email, checkout_request_id)
    are NEVER emitted. SUCCESSFUL-only: PENDING/FAILED rows have a null net_amount
    and represent no money the church keeps, so they are excluded.

    Filters (all optional, all applied AFTER the church scope):
      * from / to  — YYYY-MM-DD, date-INCLUSIVE (created_at__date bounds), so a
        donation at 23:30 on the `to` date is returned. Malformed → 400 (via the
        shared _parse_date_param), never a 500.
      * campaign   — restrict to one campaign id (mirrors the withdrawals list);
        still church-scoped, so an out-of-church id simply yields nothing.

    permission_classes = [IsChurchTreasurer]
      * Read endpoint — SUSPENDED churches still see their donation history.
    """

    permission_classes = [IsChurchTreasurer]
    pagination_class = StandardPagination

    def get_queryset(self, request):
        # ★ LEAK GUARD ★ — must filter by campaign__church
        return (
            Donation.objects
            .filter(
                campaign__church=request.user.church,
                status=DonationStatus.SUCCESSFUL,
            )
            .select_related('campaign')
        )

    def get(self, request):
        qs = self.get_queryset(request)

        # Date-inclusive bounds; a bad param raises 400 here (see _parse_date_param),
        # never a 500 reaching the queryset.
        date_from = _parse_date_param(request.query_params.get('from'), 'from')
        date_to = _parse_date_param(request.query_params.get('to'), 'to')
        if date_from is not None:
            qs = qs.filter(created_at__date__gte=date_from)
        if date_to is not None:
            qs = qs.filter(created_at__date__lte=date_to)

        campaign_filter = request.query_params.get('campaign', '').strip()
        if campaign_filter:
            qs = qs.filter(campaign_id=campaign_filter)

        qs = qs.order_by('-created_at')

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        data = PortalDonationReportSerializer(page, many=True).data
        return paginator.get_paginated_response(data)


# ───────────────────── Subscription payment (STK initiate) ────────────────────


class SubscriptionInitiateView(APIView):
    """POST /api/v1/subscriptions/initiate/ — treasurer-only subscription STK push.

    Clones DonationInitiateView's shape (persist-PENDING-before-call, save
    checkout_request_id from the ACK after the call, 502 on STKPushError) with the
    subscription-specific differences:
      * auth: authenticated CHURCH_TREASURER (not public — IsChurchTreasurer);
      * church resolved from request.user.church (no church-id in the URL);
      * target tier validated — FREE rejected (a valid SubscriptionTier value but
        never a payment target);
      * price read LIVE from PlatformSettings at INITIATE and STORED on the row
        (forward-only at initiate, not at confirm);
      * one in-flight renewal per church — refuses (409) while a PENDING
        SubscriptionPayment younger than SUBSCRIPTION_STK_TIMEOUT_MINUTES exists.

    INITIATE GRANTS NOTHING: the church's subscription_tier / subscription_expires_at
    are never touched here. The /subscriptions/callback/ that confirms a payment
    (sets receipt / period_end_granted / confirmed_at and advances the church) is 3b.

    Lock-then-call (Critical Rule #12): the in-flight check + PENDING-row create run
    INSIDE a select_for_update lock on the church row (so concurrent initiates
    serialize and the "one in-flight" invariant is race-safe); the STK HTTP call
    happens OUTSIDE that lock.
    """

    permission_classes = [IsChurchTreasurer]

    def post(self, request):
        serializer = SubscriptionInitiateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        church = getattr(request.user, 'church', None)
        if church is None:
            return Response({'detail': 'No church associated with this account.'},
                            status=status.HTTP_400_BAD_REQUEST)

        tier = data['tier']
        if tier not in (SubscriptionTier.GROWTH, SubscriptionTier.PARISH):
            return Response(
                {'detail': 'You can only subscribe to the Growth or Parish tier.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # The M-Pesa number to charge. REQUIRED + already normalized to 254XXXXXXXXX by
        # the serializer (clone of donation initiate); there is NO fallback to the
        # treasurer's own User.phone — a missing/blank/invalid phone already 400'd above.
        phone = data['phone_number']

        cutoff = timezone.now() - timedelta(
            minutes=settings.SUBSCRIPTION_STK_TIMEOUT_MINUTES,
        )

        # ── lock-then-call: serialize per-church, create PENDING, release the lock ──
        with transaction.atomic():
            locked_church = Church.objects.select_for_update().get(id=church.id)

            # Block a self-service mid-period downgrade: a church with a LIVE Parish
            # subscription cannot pay the cheaper Growth price now (it would flip to Growth
            # immediately AND extend from the unexpired Parish period). Downgrade happens by
            # letting Parish lapse, not by down-paying. Keyed on a LIVE higher tier, NOT tier
            # alone — a past-due/in-grace Parish church (expiry already passed) and a lapsed
            # FREE church fall through and may pay for any paid tier.
            #
            # NARROWED (this slice): the block applies ONLY when expiry is MORE than 7 days
            # out. Inside the last 7 paid days — or anywhere in grace — a Parish church may
            # switch to Growth. Deliberate goodwill leak: the last week of an unexpired Parish
            # period may flip to Growth (it aligns the down-switch with renewal time instead
            # of forcing the church to lapse to FREE first).
            if (
                tier == SubscriptionTier.GROWTH
                and locked_church.subscription_tier == SubscriptionTier.PARISH
                and locked_church.subscription_expires_at is not None
                and locked_church.subscription_expires_at > timezone.now() + timedelta(days=7)
            ):
                return Response(
                    {'detail': (
                        "You're on Parish. To move to Growth, let your current Parish "
                        "period end — you can't switch to a cheaper plan mid-period."
                    )},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            in_flight = SubscriptionPayment.objects.filter(
                church=locked_church,
                status=SubscriptionPaymentStatus.PENDING,
                created_at__gte=cutoff,
            ).exists()
            if in_flight:
                return Response(
                    {'detail': 'A subscription payment is already in progress for your church.'},
                    status=status.HTTP_409_CONFLICT,
                )

            # Price read LIVE at INITIATE and STORED on the row (forward-only at initiate).
            platform_settings = PlatformSettings.load()
            price = (platform_settings.growth_price
                     if tier == SubscriptionTier.GROWTH
                     else platform_settings.parish_price)

            payment = SubscriptionPayment.objects.create(
                church=locked_church,
                tier=tier,
                amount=price,
                phone_number=phone,
                status=SubscriptionPaymentStatus.PENDING,
            )
        # Lock released — STK HTTP happens OUTSIDE the DB lock (Rule #12).

        try:
            result = DarajaClient().stk_push(
                phone=phone,
                amount=price,
                # ≤12-char statement handle identifying this as a subscription charge.
                account_reference=f'SUB-{str(church.id)[:8]}'[:12],
                transaction_desc='Subscription',
                # Result lands on the SUBSCRIPTION callback, not the donation one.
                callback_url=settings.MPESA_SUBSCRIPTION_CALLBACK_URL,
            )
        except STKPushError as exc:
            # 3b fail-at-source: mark the row FAILED (not PENDING). A 502 row has NO
            # checkout_request_id — it is un-correlatable and un-confirmable, so failing
            # it synchronously is both honest AND frees the in-flight guard for an instant
            # retry (the guard counts only live PENDING rows). INITIATE STILL GRANTS
            # NOTHING — the church's tier/expiry are untouched on every path here.
            payment.status = SubscriptionPaymentStatus.FAILED
            payment.save(update_fields=['status'])
            logger.warning('STK push failed for subscription payment %s: %s',
                           payment.id, exc)
            return Response(
                {'detail': "Couldn't start the M-Pesa payment. Please try again."},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        payment.checkout_request_id = result['checkout_request_id']
        payment.save(update_fields=['checkout_request_id'])

        return Response(
            {
                'subscription_payment_id': str(payment.id),
                'checkout_request_id': payment.checkout_request_id,
                'status': payment.status,
            },
            status=status.HTTP_200_OK,
        )


class SubscriptionCancelView(APIView):
    """POST /api/v1/subscriptions/cancel/ — treasurer opts out of auto-renewal.

    FLAG ONLY: sets church.subscription_cancel_requested = True. Does NOT touch the
    tier or the expiry — the church keeps every paid day it already has, runs out the
    grace window, and lapses to FREE on the normal schedule (run_subscription_lapses
    ignores this flag). Its only effect is to suppress renewal reminders
    (run_subscription_reminders skips a cancelled church). A successful renewal payment
    re-clears it (the 3b callback). Idempotent: an already-cancelled church returns 200
    with NO second audit row. Scoped to request.user.church — no church-id in the URL.
    """

    permission_classes = [IsChurchTreasurer]

    def post(self, request):
        church = getattr(request.user, 'church', None)
        if church is None:
            return Response({'detail': 'No church associated with this account.'},
                            status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            locked_church = Church.objects.select_for_update().get(id=church.id)
            if locked_church.subscription_cancel_requested:
                # Already cancelled — no-op, no second audit (idempotent).
                return Response({'subscription_cancel_requested': True},
                                status=status.HTTP_200_OK)

            locked_church.subscription_cancel_requested = True
            locked_church.save(update_fields=['subscription_cancel_requested'])

            AuditLog.objects.create(
                actor=request.user,
                action='SUBSCRIPTION_CANCEL_REQUESTED',
                entity_type='Church',
                entity_id=locked_church.id,
                details={
                    'church_name': locked_church.name,
                    'tier': locked_church.subscription_tier,
                    'expires_at': (
                        locked_church.subscription_expires_at.isoformat()
                        if locked_church.subscription_expires_at else None
                    ),
                },
                ip_address=_client_ip(request) or None,
            )

        return Response({'subscription_cancel_requested': True},
                        status=status.HTTP_200_OK)


class SubscriptionCallbackView(APIView):
    """POST /api/v1/subscriptions/callback/ — Safaricom-called, public, no auth.

    Its OWN handler (never routed through the donation callback). Mirrors
    DonationCallbackView exactly: returns HTTP 200 on EVERY path (success / failure /
    duplicate / unknown) so a non-200 never triggers a Safaricom retry into a
    double-grant; idempotency is the FIRST in-transaction op (select_for_update on
    the payment row + terminal short-circuit).

    On ResultCode 0 it confirms the payment, extends the church's paid period, and
    flips its tier — ALL inside the one transaction.atomic():
      period_end = max(now, church.subscription_expires_at or now) + SUBSCRIPTION_PERIOD_DAYS
    (max() never burns already-paid days). It also re-arms renewal reminders for the
    fresh period. On a non-zero ResultCode it marks the payment FAILED (no grant).

    LOCK ORDER: payment THEN church (select_for_update on the payment row first, then
    on the church). Held consistently across the subscription flow to avoid deadlock.
    The treasurer in-app fan-out is INSIDE the block (mirrors donations); any email
    would be OUTSIDE (none sent here).
    """

    permission_classes = [AllowAny]

    def post(self, request):
        checkout_id, result_code, metadata = _extract_stk_callback(request.data)

        if not checkout_id:
            logger.warning('Subscription STK callback with no CheckoutRequestID: %s',
                           request.data)
            return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                            status=status.HTTP_200_OK)

        with transaction.atomic():
            # ── IDEMPOTENCY FIRST (locked, before any mutation) ──────────────────
            try:
                payment = (
                    SubscriptionPayment.objects
                    .select_for_update()
                    .select_related('church')
                    .get(checkout_request_id=checkout_id)
                )
            except SubscriptionPayment.DoesNotExist:
                logger.warning('Subscription STK callback for unknown CheckoutRequestID %s',
                               checkout_id)
                return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                                status=status.HTTP_200_OK)

            if payment.status in (SubscriptionPaymentStatus.SUCCESSFUL,
                                  SubscriptionPaymentStatus.FAILED):
                # Already processed (Safaricom retry). Short-circuit, NO mutation.
                return Response({'ResultCode': 0, 'ResultDesc': 'Duplicate ignored'},
                                status=status.HTTP_200_OK)

            if str(result_code).strip() != '0':
                # Non-zero ResultCode — no period/tier change.
                payment.status = SubscriptionPaymentStatus.FAILED
                payment.save(update_fields=['status'])
                return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                                status=status.HTTP_200_OK)

            # Cross-check the confirmed amount against the price stored at INITIATE
            # (SubscriptionPayment.amount). The grant below derives the tier/period
            # entirely from the STORED row, never the POST body; this check additionally
            # refuses to grant when a callback echoes a DIFFERENT (or unparseable) amount
            # — not a genuine STK confirmation (STK charges the exact requested amount).
            # Mismatch → no grant, leave the row PENDING for reconciliation, return 200.
            confirmed_amount = metadata.get('Amount')
            if confirmed_amount is not None:
                try:
                    amount_matches = Decimal(str(confirmed_amount)) == payment.amount
                except (InvalidOperation, ValueError, TypeError):
                    amount_matches = False
                if not amount_matches:
                    logger.warning(
                        'Subscription STK callback amount %r != expected %s for payment '
                        '%s — refusing grant (possible forgery)',
                        confirmed_amount, payment.amount, payment.id,
                    )
                    return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                                    status=status.HTTP_200_OK)

            # ── SUCCESS — confirm + extend period + flip tier, all atomic ─────────
            # Lock order: payment (above) THEN church.
            church = Church.objects.select_for_update().get(id=payment.church_id)
            now = timezone.now()
            base = max(church.subscription_expires_at or now, now)  # never burn paid days
            period_end = base + timedelta(days=settings.SUBSCRIPTION_PERIOD_DAYS)

            payment.status = SubscriptionPaymentStatus.SUCCESSFUL
            payment.mpesa_receipt_number = metadata.get('MpesaReceiptNumber')
            payment.period_end_granted = period_end
            payment.confirmed_at = now
            payment.save(update_fields=[
                'status', 'mpesa_receipt_number', 'period_end_granted', 'confirmed_at',
            ])

            church.subscription_expires_at = period_end
            # Re-arm reminders for the fresh period (dedup markers self-reset).
            church.subscription_reminder_period = None
            church.subscription_reminder_stage = REMINDER_STAGE_NONE
            # Renewing clears any standing auto-renew cancellation (same atomic block as
            # the tier/expiry write) — a paid renewal is an explicit "keep me subscribed".
            church.subscription_cancel_requested = False
            church.save(update_fields=[
                'subscription_expires_at',
                'subscription_reminder_period',
                'subscription_reminder_stage',
                'subscription_cancel_requested',
            ])

            # Tier write via the shared spine (no-op + no audit if already on tier).
            set_church_tier(
                church, payment.tier,
                actor=None, action='CHURCH_TIER_CHANGED',
                details_extra={'via': 'subscription_payment'},
            )

            # In-app fan-out to the church's treasurers — INSIDE the block (mirrors donations).
            for treasurer in User.objects.filter(
                church=church, role=UserRole.CHURCH_TREASURER,
            ):
                Notification.objects.create(
                    recipient=treasurer,
                    notification_type=NotificationType.SUBSCRIPTION_ACTIVATED,
                    title='Subscription active',
                    message=(
                        f"Your {payment.tier} subscription is active until "
                        f"{period_end:%Y-%m-%d}."
                    ),
                )

        return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                        status=status.HTTP_200_OK)


class SubscriptionStatusView(APIView):
    """GET /api/v1/subscriptions/{id}/status/ — treasurer-owned poll target.

    Returns the payment status + tier + the church's CURRENT subscription expiry. For
    a still-PENDING row older than SUBSCRIPTION_STK_TIMEOUT_MINUTES it adds a DERIVED
    `stale: true` (computed from created_at age) — it NEVER changes the row's status,
    so a late callback can still confirm it. Multi-tenant: a treasurer can only poll
    their own church's payment (else 404, not revealing existence).
    """

    permission_classes = [IsChurchTreasurer]

    def get(self, request, id):
        church = getattr(request.user, 'church', None)
        try:
            payment = SubscriptionPayment.objects.select_related('church').get(id=id)
        except SubscriptionPayment.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        if church is None or payment.church_id != church.id:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)

        stale = False
        if payment.status == SubscriptionPaymentStatus.PENDING:
            cutoff = timezone.now() - timedelta(
                minutes=settings.SUBSCRIPTION_STK_TIMEOUT_MINUTES,
            )
            stale = payment.created_at < cutoff

        return Response(
            {
                'id': str(payment.id),
                'status': payment.status,
                'tier': payment.tier,
                'subscription_expires_at': payment.church.subscription_expires_at,
                'stale': stale,
            },
            status=status.HTTP_200_OK,
        )

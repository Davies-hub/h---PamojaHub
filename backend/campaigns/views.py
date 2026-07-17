"""Campaign + GroupLabel endpoints (Step 2.9a).

This module is the largest leak surface in the system: every list endpoint must
scope its queryset by `request.user.church`, because DRF's `has_object_permission`
does NOT run on list endpoints. The permission class can only defend per-object
access; the queryset filter is the only thing that defends list access.

Every list/detail/action view below either:
  * is public (filters by status=ACTIVE AND church.status=ACTIVE), or
  * scopes to request.user.church via get_queryset() / get_object() / explicit
    filter, AND uses ChurchScopedPermission for object-level cross-church denial.

Edit rules (decided in Step 2.9a brief):
  * Freely editable: title, description, banner_image_url, document_url, category,
    group_label.
  * goal_amount: editable, but rejected if < current raised_amount (no >100% display).
  * treasurer_phone / treasurer_name: editable, but EACH change writes an AuditLog
    entry AND an in-app Notification to the Church Treasurer. Deeper mitigation
    (re-auth, email alert) deferred to security hardening.
  * status: NOT editable here — pause/resume/close actions only.
  * slug, raised_amount, wallet_balance, created_by, church: immutable (read-only
    on AdminCampaignSerializer; church/status additionally enforced view-side).
  * CLOSED campaigns reject ALL edits.

SUSPENDED-church enforcement: declarative via the ChurchNotSuspended permission
(common/permissions.py) — applied to every state-changing view's permission_classes
(or returned from get_permissions() for views with both GET and PATCH/POST). On
denial DRF returns 403 with the permission's `message`. READ endpoints (me, mine,
stats, group-labels list) stay open so a suspended treasurer can still SEE their
data, just not act on it.

Per the Step 2.9a HARD REQUIREMENT carried forward to 2.9b/2.9c: every NEW
state-changing Church Treasurer view MUST apply ChurchNotSuspended. There is no
inline `church.status == SUSPENDED` check in this file — the permission is the
single source of truth and inheriting from base classes propagates it.

PENDING-church policy: treasurers can create/edit campaigns while PENDING (they
set up campaigns during onboarding). Those campaigns do not appear publicly
until the church is ACTIVE — the public list filter is church.status=ACTIVE.

Manual-pause vs subscription-lapse auto-pause gap: pause/resume here is purely
treasurer-driven. The subscription system (Phase 3) will introduce auto-pause
on lapse. If a campaign is auto-paused for lapse, manual resume by the
treasurer would incorrectly reactivate billing-blocked campaigns. The
collision-resolution is the subscription system's concern, NOT solved here.
Recorded in memory note project_phase2_step29a.md.
"""

import csv
import uuid
from decimal import Decimal

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.http import HttpResponse, StreamingHttpResponse
from django.utils import timezone
from django.utils.text import slugify
from rest_framework import status
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.renderers import BaseRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from audit.models import AuditLog
from campaigns.models import (
    Campaign,
    CampaignStatus,
    CampaignUpdate,
    GroupLabel,
)
from campaigns.serializers import (
    AdminCampaignSerializer,
    CampaignUpdateSerializer,
    GroupLabelSerializer,
    PlatformStatsSerializer,
    PublicCampaignSerializer,
)
from churches.models import Church, ChurchStatus, TIER_ACTIVE_CAMPAIGN_CAP
from donations.models import Donation, DonationStatus
from common.masking import mask_phone
from common.pagination import StandardPagination
from common.pdf import render_report_pdf
from common.permissions import (
    ChurchNotSuspended,
    ChurchScopedPermission,
    IsChurchTreasurer,
)
from integrations.object_storage import ObjectStorageClient, ObjectStorageError
from media.models import MediaAsset, MediaKind
from media.replace import delete_prior_assets
from media.validation import MAX_UPLOAD_BYTES, validate_and_reencode
from notifications.models import Notification, NotificationType
from superadmin.views import _parse_date_param
from withdrawals.models import BLOCKING_WITHDRAWAL_STATUSES


CLOSED_EDIT_MSG = {'detail': 'Closed campaigns cannot be edited.'}


def _client_ip(request):
    return request.META.get('REMOTE_ADDR') or ''


def _next_available_slug(base: str) -> str:
    """Slug-collision logic (PRD §9.5, deferred from Step 2.5).

    Given a base slug ('roof-fund'), returns the first available unique slug in
    the sequence: base, base-2, base-3, ... A wrapping transaction + IntegrityError
    retry guards against the TOCTOU race where two concurrent creates pick the
    same suffix simultaneously.
    """
    if not Campaign.objects.filter(slug=base).exists():
        return base
    n = 2
    while Campaign.objects.filter(slug=f'{base}-{n}').exists():
        n += 1
    return f'{base}-{n}'


def _validate_group_label(value, user_church):
    """Returns (ok, error_response). ok=True means proceed.

    A group label belongs to exactly one church. A treasurer must not be able
    to attach their campaign to ANOTHER church's group label — that would leak
    the existence of the other church's labels via "did the assign work?".
    """
    if value is None:
        return True, None
    if value.church_id != user_church.id:
        return False, Response(
            {'detail': 'Group label does not belong to your church.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return True, None


# ═════════════════════════════════════════════════════════════════════════════
# Public platform stats
# ═════════════════════════════════════════════════════════════════════════════


class PlatformStatsView(APIView):
    """GET /api/v1/stats/ — public, all-time platform totals for the landing hero.

    AllowAny. Every figure is computed SERVER-SIDE (never trust a client) and is
    ALL-TIME (no date filter, no status filter on campaigns/churches):
      * total_raised   — Sum of Donation.net_amount over SUCCESSFUL donations
                         (money on record; net_amount is NULL for PENDING/FAILED,
                         which Sum skips). Same field SuperAnalytics sums.
      * campaign_count — every Campaign, all statuses.
      * church_count   — every Church, all statuses.

    total_raised is a DecimalField → STRING on the wire (rule #11). This is a
    NON-sensitive aggregate: no per-church or per-donor detail, so no allowlist
    concern beyond emitting only these three figures.
    """

    permission_classes = [AllowAny]

    def get(self, request):
        total_raised = Donation.objects.filter(
            status=DonationStatus.SUCCESSFUL,
        ).aggregate(s=Sum('net_amount'))['s'] or Decimal('0')

        data = {
            'total_raised': total_raised,
            'campaign_count': Campaign.objects.count(),
            'church_count': Church.objects.count(),
        }
        return Response(PlatformStatsSerializer(data).data)


# ═════════════════════════════════════════════════════════════════════════════
# Public campaign browse
# ═════════════════════════════════════════════════════════════════════════════


class PublicCampaignListView(APIView):
    """GET /api/v1/campaigns/ — public browse.

    Filter: only campaigns with status=ACTIVE whose church.status=ACTIVE. This
    keeps PAUSED/CLOSED campaigns and campaigns of PENDING/SUSPENDED churches
    out of public listings. Supports search by title, category filter, church
    filter (by id).
    """

    permission_classes = [AllowAny]
    pagination_class = StandardPagination

    def get_queryset(self):
        return Campaign.objects.filter(
            status=CampaignStatus.ACTIVE,
            church__status=ChurchStatus.ACTIVE,
        ).select_related('church', 'group_label')

    def get(self, request):
        qs = self.get_queryset()
        search = request.query_params.get('search', '').strip()
        category = request.query_params.get('category', '').strip()
        church_id = request.query_params.get('church', '').strip()
        if search:
            qs = qs.filter(title__icontains=search)
        if category:
            qs = qs.filter(category=category)
        if church_id:
            # church_id is a UUID PK — an unparseable value would raise
            # ValidationError deep in the queryset (a 500 on this AllowAny
            # endpoint). Validate up-front → clean 400, mirroring how
            # _parse_date_param rejects a malformed date param.
            try:
                uuid.UUID(church_id)
            except (ValueError, AttributeError, TypeError):
                return Response(
                    {'detail': 'Invalid church id.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            qs = qs.filter(church_id=church_id)
        qs = qs.order_by('-created_at')

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        data = PublicCampaignSerializer(page, many=True).data
        return paginator.get_paginated_response(data)


class PublicCampaignDetailView(APIView):
    """GET /api/v1/campaigns/{slug}/ — public detail by slug.

    Only ACTIVE-church campaigns. Includes campaign updates (public-facing
    progress posts). PAUSED/CLOSED campaigns of ACTIVE churches: a donor with
    a direct slug link can still see them (their banner / history is public
    record once posted); only browse-list excludes them. Adjust if the PRD
    requires otherwise in review.
    """

    permission_classes = [AllowAny]

    def get(self, request, slug):
        try:
            campaign = Campaign.objects.select_related('church', 'group_label').get(
                slug=slug, church__status=ChurchStatus.ACTIVE,
            )
        except Campaign.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)

        body = PublicCampaignSerializer(campaign).data
        updates = CampaignUpdate.objects.filter(campaign=campaign).order_by('-created_at')
        body['updates'] = CampaignUpdateSerializer(updates, many=True).data
        return Response(body)


# ═════════════════════════════════════════════════════════════════════════════
# Treasurer's own campaigns — leak surface
# ═════════════════════════════════════════════════════════════════════════════


class TreasurerCampaignListView(APIView):
    """GET /api/v1/campaigns/mine/ — Church Treasurer's campaign-management list.

    LEAK SURFACE: this is the highest-risk list endpoint in 2.9a. The single
    line that defends it is `get_queryset` returning Campaign.objects.filter(
    church=request.user.church). A typo here is the difference between a
    treasurer seeing only their church and seeing every church's campaigns.
    Verified by tests/test_church_scoped_endpoints.py::test_mine_list_leak_probe.

    All statuses included (ACTIVE / PAUSED / CLOSED) — this is the admin view,
    not the public browse. Search by title / group_label / status.

    permission_classes = [IsChurchTreasurer]
      * Read endpoint — SUSPENDED churches can still see their data.
      * NO ChurchNotSuspended here (deliberately).
    """

    permission_classes = [IsChurchTreasurer]
    pagination_class = StandardPagination

    def get_queryset(self, request):
        # ★ LEAK GUARD ★ — must filter by request.user.church
        return Campaign.objects.filter(
            church=request.user.church,
        ).select_related('group_label')

    def get(self, request):
        qs = self.get_queryset(request)
        search = request.query_params.get('search', '').strip()
        status_filter = request.query_params.get('status', '').strip()
        group_label = request.query_params.get('group_label', '').strip()
        if search:
            qs = qs.filter(title__icontains=search)
        if status_filter:
            qs = qs.filter(status=status_filter)
        if group_label:
            qs = qs.filter(group_label_id=group_label)

        # Date-inclusive bounds; a bad param raises 400 here (see _parse_date_param),
        # never a 500 reaching the queryset. Applied BEFORE pagination so the page
        # count stays honest. created_at is NOT indexed on Campaign — a scale
        # follow-up (matches donations/withdrawals list filters).
        date_from = _parse_date_param(request.query_params.get('from'), 'from')
        date_to = _parse_date_param(request.query_params.get('to'), 'to')
        if date_from is not None:
            qs = qs.filter(created_at__date__gte=date_from)
        if date_to is not None:
            qs = qs.filter(created_at__date__lte=date_to)

        qs = qs.order_by('-created_at')

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        data = AdminCampaignSerializer(page, many=True).data
        return paginator.get_paginated_response(data)


# ─────────────────── Campaign-summary CSV export (full, scoped) ──────────────
# Mirrors withdrawals.views.ChurchWithdrawalsExportView / churches
# ChurchMeDonationsExportView: a passthrough renderer so DRF content-negotiation
# accepts ?format=csv, an _Echo file-like driving csv.writer inside a generator,
# and a StreamingHttpResponse. Those helpers are private to each view module, so
# they are re-declared identically here — keep the three in sync.


class _PassthroughCSVRenderer(BaseRenderer):
    """No-op renderer so DRF negotiation accepts ?format=csv instead of 404-ing.
    The view returns a StreamingHttpResponse (a Django response, not a DRF
    Response), so render() is never invoked. Mirrors withdrawals/views.py."""

    media_type = 'text/csv'
    format = 'csv'

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data


class _PassthroughPDFRenderer(BaseRenderer):
    """PDF twin of _PassthroughCSVRenderer — its only job is to make DRF negotiation
    accept ?format=pdf instead of 404-ing. The view returns an HttpResponse(pdf_bytes)
    (a Django response, not a DRF Response), so render() is never invoked. Mirrors
    withdrawals/views.py."""

    media_type = 'application/pdf'
    format = 'pdf'

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data


class _Echo:
    """Write-only file-like whose write() returns the value, so csv.writer can be
    driven row-by-row inside a StreamingHttpResponse generator. Mirrors
    withdrawals/views.py."""

    def write(self, value):
        return value


class ChurchCampaignsExportView(APIView):
    """GET /api/v1/campaigns/mine/export/?format=csv — the FULL, un-paginated CSV
    of this church's campaigns (ALL statuses), for the treasurer Reports download.

    The paginated sibling TreasurerCampaignListView caps at
    StandardPagination.page_size (20), so a church with >20 campaigns can never
    download its complete list there. This view reuses that view's EXACT
    church-scope guard (TreasurerCampaignListView.get_queryset — the single leak
    surface is defined once; it already select_related('group_label') so the
    per-row group name read is not an N+1) and streams every row with NO paginator
    and NO date/group/status filter (full scoped export by product decision —
    matches the donations + payouts exports).

    PII-safety: treasurer_phone / treasurer_name live on the Campaign row but are
    deliberately NOT emitted here (mirrors the payout export skipping phone). Only
    title, group name, goal / raised / wallet_balance (all NET, church-facing),
    status and created date reach the wire. This holds for BOTH wire formats:
    ?format=csv (default) streams the CSV; ?format=pdf renders the SAME rows as a
    PDF via common.pdf.render_report_pdf.
    """

    permission_classes = [IsChurchTreasurer]
    renderer_classes = [_PassthroughCSVRenderer, _PassthroughPDFRenderer]

    HEADER = ['Title', 'Group', 'Goal (KES)', 'Raised (KES)',
              'Wallet Balance (KES)', 'Status', 'Created']

    @staticmethod
    def _row(c):
        """The single column definition shared by the CSV and PDF exports — never
        reads treasurer_phone / treasurer_name. Defining it once means the two wire
        formats cannot drift apart (and neither can leak the PII the other doesn't).
        group_label is nullable (SET_NULL) — emit '' not "None"."""
        group = c.group_label.name if c.group_label else ''
        return [
            c.title,
            group,
            str(c.goal_amount),
            str(c.raised_amount),
            str(c.wallet_balance),
            CampaignStatus(c.status).label,
            c.created_at.date().isoformat(),
        ]

    def _iter_rows(self, qs):
        writer = csv.writer(_Echo())
        yield writer.writerow(self.HEADER)
        for c in qs.iterator():
            yield writer.writerow(self._row(c))

    def get(self, request):
        # Reuse the exact church-scope guard — do not re-invent the church filter.
        qs = TreasurerCampaignListView().get_queryset(request).order_by('-created_at')

        if request.query_params.get('format') == 'pdf':
            return self._pdf_response(request, qs)

        # CSV (default / ?format=csv) — byte-identical to before.
        filename = f'campaigns-{timezone.now().date().isoformat()}.csv'
        response = StreamingHttpResponse(
            self._iter_rows(qs), content_type='text/csv'
        )
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response

    def _pdf_response(self, request, qs):
        generated = timezone.now().date().isoformat()
        subtitle = f'{request.user.church.name} · Generated {generated}'
        rows = [self._row(c) for c in qs.iterator()]
        pdf_bytes = render_report_pdf(
            title='Campaign Summary',
            subtitle=subtitle,
            header=self.HEADER,
            rows=rows,
        )
        filename = f'campaigns-{generated}.pdf'
        response = HttpResponse(pdf_bytes, content_type='application/pdf')
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response


# ═════════════════════════════════════════════════════════════════════════════
# Create campaign
# ═════════════════════════════════════════════════════════════════════════════


class CampaignCreateView(APIView):
    """POST /api/v1/campaigns/ — create a campaign for the treasurer's church.

    Server-set fields (never accept from client): slug (collision-handled),
    church (from request.user), created_by (from request.user), status (ACTIVE),
    raised_amount (0), wallet_balance (0).

    permission_classes = [ChurchNotSuspended]
      * State-changing — SUSPENDED churches denied at the view-level gate.
      * No object scope (creating a new object, no target to check).
      * ChurchNotSuspended implies authenticated + role==CHURCH_TREASURER, so
        IsChurchTreasurer/IsAuthenticated are dropped as redundant.
    """

    permission_classes = [ChurchNotSuspended]

    def post(self, request):
        serializer = AdminCampaignSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)

        # Strip any client-supplied server-controlled fields. The serializer's
        # read_only_fields already excludes slug/raised/wallet/created_by, but
        # `church` and `status` are writable at the serializer layer and the
        # view-level enforcement is the second lock.
        data.pop('church', None)
        data.pop('status', None)
        data.pop('raised_amount', None)
        data.pop('wallet_balance', None)

        # Group label cross-church check.
        ok, err = _validate_group_label(data.get('group_label'), request.user.church)
        if not ok:
            return err

        # Active-campaign cap (FREE tier = 3). Lock the church row for the whole
        # check-then-create so concurrent submits serialize: the second waits on
        # the lock and re-counts only after the first has committed its campaign.
        # The cap check and the existing slug-retry create loop share ONE outer
        # atomic; each loop attempt's `with transaction.atomic()` becomes a
        # savepoint nested inside it.
        base = slugify(data['title']) or 'campaign'
        last_err = None
        with transaction.atomic():
            locked_church = Church.objects.select_for_update().get(
                id=request.user.church_id,
            )
            cap = TIER_ACTIVE_CAMPAIGN_CAP.get(locked_church.subscription_tier)
            if cap is not None:
                active_count = locked_church.campaigns.filter(
                    status=CampaignStatus.ACTIVE,
                ).count()
                if active_count >= cap:
                    return Response(
                        {'detail': (
                            'Your Free plan allows 3 active campaigns. '
                            'Close an active campaign or upgrade to add more.'
                        )},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

            # Slug collision: pre-compute candidate, then retry on the rare race.
            for _ in range(50):
                slug = _next_available_slug(base)
                try:
                    with transaction.atomic():
                        campaign = Campaign.objects.create(
                            slug=slug,
                            church=locked_church,
                            created_by=request.user,
                            status=CampaignStatus.ACTIVE,
                            **data,
                        )
                        AuditLog.objects.create(
                            actor=request.user,
                            action='CAMPAIGN_CREATED',
                            entity_type='Campaign',
                            entity_id=campaign.id,
                            details={
                                'slug': campaign.slug,
                                'title': campaign.title,
                                'church_id': str(campaign.church_id),
                            },
                            ip_address=_client_ip(request) or None,
                        )
                    return Response(
                        AdminCampaignSerializer(campaign).data,
                        status=status.HTTP_201_CREATED,
                    )
                except IntegrityError as exc:
                    last_err = exc
                    continue
        # Pragmatically unreachable: 50 retries means 50 concurrent same-title
        # races, well beyond any realistic load. Surface clearly if it happens.
        return Response(
            {'detail': 'Could not allocate a unique slug — please retry.'},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )


# ═════════════════════════════════════════════════════════════════════════════
# Campaign detail / edit / status transitions
# ═════════════════════════════════════════════════════════════════════════════


class _CampaignActionBase(APIView):
    """Shared get_object — fetches campaign by slug, runs ChurchScopedPermission's
    object-level check (cross-church denial), and returns the campaign.

    The permission class's has_object_permission compares obj.church to
    request.user.church — fail-closed on either side being None.

    Permission switching (per-method):
      * GET           → [IsChurchTreasurer, ChurchScopedPermission]
                        — read is allowed for SUSPENDED churches (they can see their data).
      * POST / PATCH  → [ChurchNotSuspended, ChurchScopedPermission]
                        — state-changing actions are denied when SUSPENDED.

    Action subclasses (Pause/Resume/Close) are POST-only so always get the
    write permission set. TreasurerCampaignDetailView is GET+PATCH and uses
    both branches.
    """

    def get_permissions(self):
        if self.request.method == 'GET':
            return [IsChurchTreasurer(), ChurchScopedPermission()]
        return [ChurchNotSuspended(), ChurchScopedPermission()]

    def get_object(self, request, slug):
        try:
            campaign = Campaign.objects.select_related('church', 'group_label').get(slug=slug)
        except Campaign.DoesNotExist:
            return None, Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        # Run object-level permission (cross-church denial). This invokes
        # ChurchScopedPermission.has_object_permission via DRF's standard flow.
        self.check_object_permissions(request, campaign)
        return campaign, None


class TreasurerCampaignDetailView(_CampaignActionBase):
    """GET/PATCH /api/v1/campaigns/mine/{slug}/ — admin detail + edit.

    The slug path lives under /campaigns/mine/{slug}/ rather than /campaigns/{slug}/
    so the public detail (which exposes only the PublicCampaignSerializer) and the
    admin detail (which exposes AdminCampaignSerializer with treasurer_phone etc)
    are routed separately. A token-confused client cannot accidentally hit the
    admin route as anonymous because the path requires auth.
    """

    def get(self, request, slug):
        campaign, err = self.get_object(request, slug)
        if err is not None:
            return err
        return Response(AdminCampaignSerializer(campaign).data)

    def patch(self, request, slug):
        # SUSPENDED denial is handled view-level by ChurchNotSuspended (see
        # _CampaignActionBase.get_permissions); no inline check needed here.
        campaign, err = self.get_object(request, slug)
        if err is not None:
            return err

        # CLOSED is terminal — reject all edits.
        if campaign.status == CampaignStatus.CLOSED:
            return Response(CLOSED_EDIT_MSG, status=status.HTTP_400_BAD_REQUEST)

        # Server-controlled fields: reject if client tries to set them. We do this
        # at the request.data layer so the serializer's validation errors are
        # consistent and visible.
        IMMUTABLE_ON_EDIT = {
            'slug', 'church', 'status', 'raised_amount',
            'wallet_balance', 'created_by', 'closed_at', 'created_at',
        }
        for k in IMMUTABLE_ON_EDIT:
            if k in request.data:
                return Response(
                    {'detail': f"Field '{k}' is not editable here."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        serializer = AdminCampaignSerializer(campaign, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # goal_amount: editable but not below current raised_amount.
        if 'goal_amount' in data:
            new_goal = data['goal_amount']
            if new_goal < campaign.raised_amount:
                return Response(
                    {
                        'detail': (
                            f'Goal amount ({new_goal}) cannot be set below the '
                            f'amount already raised ({campaign.raised_amount}).'
                        ),
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Group label cross-church check.
        if 'group_label' in data:
            ok, err = _validate_group_label(data['group_label'], request.user.church)
            if not ok:
                return err

        # Treasurer-destination change detection — capture OLD values BEFORE save.
        old_phone = campaign.treasurer_phone
        old_name = campaign.treasurer_name
        new_phone = data.get('treasurer_phone', old_phone)
        new_name = data.get('treasurer_name', old_name)
        destination_changed = (new_phone != old_phone) or (new_name != old_name)

        with transaction.atomic():
            serializer.save()
            if destination_changed:
                AuditLog.objects.create(
                    actor=request.user,
                    action='CAMPAIGN_TREASURER_DESTINATION_CHANGED',
                    entity_type='Campaign',
                    entity_id=campaign.id,
                    details={
                        # PRD §12.10 — phones masked in forensic surfaces.
                        # The full numbers live on the Campaign row; entity_id
                        # links to it.
                        'old_phone': mask_phone(old_phone),
                        'new_phone': mask_phone(new_phone),
                        'old_name': old_name,
                        'new_name': new_name,
                    },
                    ip_address=_client_ip(request) or None,
                )
                # In-app notification to the Church Treasurer who made the change.
                # Deeper mitigation (re-auth, email alert) deferred to security
                # hardening — recorded in memory.
                Notification.objects.create(
                    recipient=request.user,
                    notification_type=NotificationType.CAMPAIGN_DESTINATION_CHANGED,
                    title='Payout destination changed',
                    message=(
                        f"The payout destination for campaign '{campaign.title}' was "
                        f"updated. If you did not make this change, contact support."
                    ),
                    related_campaign=campaign,
                )

        return Response(AdminCampaignSerializer(campaign).data)


# ───────────────────── status-transition actions ─────────────────────────────


class CampaignPauseView(_CampaignActionBase):
    """POST /api/v1/campaigns/mine/{slug}/pause/ — ACTIVE → PAUSED only.

    See module docstring re manual-pause / auto-pause collision (deferred).
    """

    def post(self, request, slug):
        # SUSPENDED denial handled by ChurchNotSuspended via _CampaignActionBase.get_permissions.
        campaign, err = self.get_object(request, slug)
        if err is not None:
            return err
        if campaign.status != CampaignStatus.ACTIVE:
            return Response(
                {'detail': f'Only ACTIVE campaigns can be paused (current: {campaign.status}).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            campaign.status = CampaignStatus.PAUSED
            campaign.save(update_fields=['status'])
            AuditLog.objects.create(
                actor=request.user,
                action='CAMPAIGN_PAUSED',
                entity_type='Campaign',
                entity_id=campaign.id,
                details={'slug': campaign.slug},
                ip_address=_client_ip(request) or None,
            )
        return Response(AdminCampaignSerializer(campaign).data)


class CampaignResumeView(_CampaignActionBase):
    """POST /api/v1/campaigns/mine/{slug}/resume/ — PAUSED → ACTIVE only."""

    def post(self, request, slug):
        # SUSPENDED denial handled by ChurchNotSuspended via _CampaignActionBase.get_permissions.
        campaign, err = self.get_object(request, slug)
        if err is not None:
            return err
        if campaign.status != CampaignStatus.PAUSED:
            return Response(
                {'detail': f'Only PAUSED campaigns can be resumed (current: {campaign.status}).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            campaign.status = CampaignStatus.ACTIVE
            campaign.save(update_fields=['status'])
            AuditLog.objects.create(
                actor=request.user,
                action='CAMPAIGN_RESUMED',
                entity_type='Campaign',
                entity_id=campaign.id,
                details={'slug': campaign.slug},
                ip_address=_client_ip(request) or None,
            )
        return Response(AdminCampaignSerializer(campaign).data)


class CampaignCloseView(_CampaignActionBase):
    """POST /api/v1/campaigns/mine/{slug}/close/ — ACTIVE or PAUSED → CLOSED.

    Terminal: a CLOSED campaign cannot be reopened. Sets closed_at=now.
    """

    def post(self, request, slug):
        # SUSPENDED denial handled by ChurchNotSuspended via _CampaignActionBase.get_permissions.
        campaign, err = self.get_object(request, slug)
        if err is not None:
            return err
        if campaign.status not in (CampaignStatus.ACTIVE, CampaignStatus.PAUSED):
            return Response(
                {'detail': f'Campaign cannot be closed from status {campaign.status}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # In-flight-money guard: a non-terminal (blocking) withdrawal means money is
        # outstanding or in-limbo for this campaign — closing would strand it. Reuse
        # the single source of truth (the disbursement-request path uses the same set);
        # index-backed reverse accessor + .exists() (idx_withdrawal_campaign_status).
        if campaign.withdrawals.filter(
            status__in=BLOCKING_WITHDRAWAL_STATUSES
        ).exists():
            return Response(
                {'detail': 'This campaign has a withdrawal in progress and '
                           'cannot be closed until it is resolved.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            campaign.status = CampaignStatus.CLOSED
            campaign.closed_at = timezone.now()
            campaign.save(update_fields=['status', 'closed_at'])
            AuditLog.objects.create(
                actor=request.user,
                action='CAMPAIGN_CLOSED',
                entity_type='Campaign',
                entity_id=campaign.id,
                details={'slug': campaign.slug},
                ip_address=_client_ip(request) or None,
            )
        return Response(AdminCampaignSerializer(campaign).data)


# ───────────────────── Banner upload ─────────────────────────────────────────


class CampaignBannerUploadView(_CampaignActionBase):
    """POST /api/v1/campaigns/mine/{slug}/banner/ — upload a banner for an OWNED campaign.
    This is the upload surface the security audit noted did not exist. Guard order:
      1. IDOR gate FIRST — get_object() runs ChurchScopedPermission.has_object_permission
         (cross-church denial) BEFORE any byte is read. A cross-tenant caller's bytes never
         reach the validator or the bucket.
      2. DoS gate — reject declared size > MAX_UPLOAD_BYTES, then capped read.
      3. Content gate — validate_and_reencode (magic-byte + Pillow decode + re-encode). The
         RE-ENCODED bytes are stored; the raw upload is never stored.
      4. put_object BEFORE the metadata commit — a failed commit leaves a harmless orphan
         object, never a dangling banner_image_url.
    banner_image_url is server-set here (read_only at the serializer since Slice 1).
    """
    parser_classes = [MultiPartParser]

    def post(self, request, slug):
        campaign, err = self.get_object(request, slug)      # IDOR gate fires here
        if err is not None:
            return err
        if campaign.status == CampaignStatus.CLOSED:
            return Response({'detail': 'Cannot upload a banner to a closed campaign.'},
                            status=status.HTTP_400_BAD_REQUEST)

        uploaded = request.FILES.get('file')
        if uploaded is None:
            return Response({'detail': 'No file provided (field name: file).'},
                            status=status.HTTP_400_BAD_REQUEST)

        if uploaded.size > MAX_UPLOAD_BYTES:                  # DoS gate (declared size)
            return Response({'detail': 'File too large (max 5 MB).'},
                            status=status.HTTP_400_BAD_REQUEST)
        raw = uploaded.read(MAX_UPLOAD_BYTES + 1)             # capped read
        if len(raw) > MAX_UPLOAD_BYTES:
            return Response({'detail': 'File too large (max 5 MB).'},
                            status=status.HTTP_400_BAD_REQUEST)

        clean_bytes, content_type = validate_and_reencode(raw)   # content gate (raises→400)

        ext = 'jpg' if content_type == 'image/jpeg' else 'png'
        key = f'campaign/{campaign.id}/banner/{uuid.uuid4().hex}.{ext}'   # server keygen

        client = ObjectStorageClient()
        try:
            result = client.put_object(key, clean_bytes, content_type)   # store CLEAN bytes
        except ObjectStorageError:
            return Response({'detail': 'Could not store the image. Please retry.'},
                            status=status.HTTP_502_BAD_GATEWAY)

        with transaction.atomic():                            # metadata AFTER confirmed PUT
            asset = MediaAsset.objects.create(
                kind=MediaKind.BANNER, campaign=campaign, church=None,
                object_key=result['key'], bucket=settings.S3_BUCKET_NAME,
                content_type=content_type, size_bytes=len(clean_bytes),
                uploaded_by=request.user,
            )
            # Store the bare OBJECT KEY (2026-07-18) — the absolute URL is minted at
            # serialization time (media_url), so the browser-facing base can change
            # without a DB rewrite. Pre-key rows hold absolute URLs forever (passthrough).
            campaign.banner_image_url = result['key']
            campaign.save(update_fields=['banner_image_url'])
            AuditLog.objects.create(
                actor=request.user, action='CAMPAIGN_BANNER_UPLOADED',
                entity_type='Campaign', entity_id=campaign.id,
                details={'slug': campaign.slug, 'object_key': result['key'],
                         'asset_id': str(asset.id)},
                ip_address=_client_ip(request) or None,
            )
        # Replace: drop the owner's PRIOR banners (object + row), best-effort, post-commit.
        # OUTSIDE the atomic block so a delete failure cannot roll back the new asset.
        delete_prior_assets(campaign, MediaKind.BANNER, asset.id)
        return Response(AdminCampaignSerializer(campaign).data, status=status.HTTP_200_OK)


# ───────────────────── Campaign updates ──────────────────────────────────────


class CampaignUpdatesView(APIView):
    """GET (public) / POST (treasurer) /api/v1/campaigns/{slug}/updates/.

    GET: AllowAny — updates are public-facing campaign progress posts.
    POST: IsChurchTreasurer + ChurchScopedPermission — must own the campaign.

    SECURITY: GET is public, but the path is by SLUG which is itself public.
    POSTing as a different church's treasurer is denied because the object-
    level permission check fires when we resolve the campaign.
    """

    def get_permissions(self):
        if self.request.method == 'POST':
            # State-changing post: ChurchNotSuspended (view-level) +
            # ChurchScopedPermission (object-level, must own the campaign).
            return [ChurchNotSuspended(), ChurchScopedPermission()]
        return [AllowAny()]

    def get(self, request, slug):
        try:
            campaign = Campaign.objects.get(slug=slug)
        except Campaign.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        updates = CampaignUpdate.objects.filter(campaign=campaign).order_by('-created_at')
        return Response(CampaignUpdateSerializer(updates, many=True).data)

    def post(self, request, slug):
        # SUSPENDED denial handled view-level by ChurchNotSuspended (see get_permissions).
        try:
            campaign = Campaign.objects.select_related('church').get(slug=slug)
        except Campaign.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        # Cross-church denial via object-level permission.
        self.check_object_permissions(request, campaign)

        serializer = CampaignUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        with transaction.atomic():
            update = CampaignUpdate.objects.create(
                campaign=campaign,
                posted_by=request.user,
                body=serializer.validated_data['body'],
            )
            AuditLog.objects.create(
                actor=request.user,
                action='CAMPAIGN_UPDATE_POSTED',
                entity_type='CampaignUpdate',
                entity_id=update.id,
                details={'campaign_id': str(campaign.id), 'slug': campaign.slug},
                ip_address=_client_ip(request) or None,
            )
        return Response(
            CampaignUpdateSerializer(update).data,
            status=status.HTTP_201_CREATED,
        )


# ═════════════════════════════════════════════════════════════════════════════
# GroupLabel endpoints — mounted at /api/v1/group-labels/
# ═════════════════════════════════════════════════════════════════════════════


class GroupLabelListCreateView(APIView):
    """GET/POST /api/v1/group-labels/ — list (read on SUSPENDED is fine; write is not).

    LEAK GUARD: get_queryset filters by request.user.church. Same threat model as
    /campaigns/mine/ — DRF doesn't apply object-perms to lists.

    Permission switching (per-method):
      * GET  → [IsChurchTreasurer] (reads allowed for SUSPENDED churches).
      * POST → [ChurchNotSuspended] (state-changing denial when SUSPENDED).
    """

    pagination_class = StandardPagination

    def get_permissions(self):
        if self.request.method == 'POST':
            return [ChurchNotSuspended()]
        return [IsChurchTreasurer()]

    def get_queryset(self, request):
        # ★ LEAK GUARD ★
        return GroupLabel.objects.filter(church=request.user.church).order_by('name')

    def get(self, request):
        qs = self.get_queryset(request)
        archived = request.query_params.get('archived', '').strip().lower()
        if archived == 'true':
            qs = qs.filter(is_archived=True)
        elif archived == 'false':
            qs = qs.filter(is_archived=False)
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        data = GroupLabelSerializer(page, many=True).data
        return paginator.get_paginated_response(data)

    def post(self, request):
        # SUSPENDED denial handled view-level by ChurchNotSuspended (see get_permissions).
        serializer = GroupLabelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)

        # parent_label cross-church check.
        parent = data.get('parent_label')
        if parent is not None and parent.church_id != request.user.church.id:
            return Response(
                {'detail': 'Parent label does not belong to your church.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            label = GroupLabel.objects.create(
                church=request.user.church,
                **data,
            )
            AuditLog.objects.create(
                actor=request.user,
                action='GROUP_LABEL_CREATED',
                entity_type='GroupLabel',
                entity_id=label.id,
                details={'name': label.name},
                ip_address=_client_ip(request) or None,
            )
        return Response(GroupLabelSerializer(label).data, status=status.HTTP_201_CREATED)


class _GroupLabelActionBase(APIView):
    """Shared object-resolver + permission switching for per-label actions.

    Permission switching (per-method):
      * GET           → [IsChurchTreasurer, ChurchScopedPermission]
      * POST / PATCH  → [ChurchNotSuspended, ChurchScopedPermission]

    Archive/Unarchive subclasses are POST-only so always get the write set.
    GroupLabelDetailView is GET+PATCH and uses both branches.
    """

    def get_permissions(self):
        if self.request.method == 'GET':
            return [IsChurchTreasurer(), ChurchScopedPermission()]
        return [ChurchNotSuspended(), ChurchScopedPermission()]

    def get_object(self, request, id):
        try:
            label = GroupLabel.objects.get(id=id)
        except GroupLabel.DoesNotExist:
            return None, Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        self.check_object_permissions(request, label)
        return label, None


class GroupLabelDetailView(_GroupLabelActionBase):
    """GET/PATCH /api/v1/group-labels/{id}/ — rename only via PATCH (parent reassign also)."""

    def get(self, request, id):
        label, err = self.get_object(request, id)
        if err is not None:
            return err
        return Response(GroupLabelSerializer(label).data)

    def patch(self, request, id):
        # SUSPENDED denial handled view-level by ChurchNotSuspended via _GroupLabelActionBase.get_permissions.
        label, err = self.get_object(request, id)
        if err is not None:
            return err
        serializer = GroupLabelSerializer(label, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        # parent_label cross-church check.
        if 'parent_label' in data and data['parent_label'] is not None:
            if data['parent_label'].church_id != request.user.church.id:
                return Response(
                    {'detail': 'Parent label does not belong to your church.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        with transaction.atomic():
            serializer.save()
            AuditLog.objects.create(
                actor=request.user,
                action='GROUP_LABEL_UPDATED',
                entity_type='GroupLabel',
                entity_id=label.id,
                details={'name': label.name},
                ip_address=_client_ip(request) or None,
            )
        return Response(GroupLabelSerializer(label).data)


class GroupLabelArchiveView(_GroupLabelActionBase):
    """POST /api/v1/group-labels/{id}/archive/ — only if no ACTIVE campaigns (PRD 8.5.2)."""

    def post(self, request, id):
        # SUSPENDED denial handled by ChurchNotSuspended via _GroupLabelActionBase.get_permissions.
        label, err = self.get_object(request, id)
        if err is not None:
            return err
        active_count = Campaign.objects.filter(
            group_label=label, status=CampaignStatus.ACTIVE,
        ).count()
        if active_count > 0:
            return Response(
                {'detail': 'Cannot archive a group with active campaigns.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            label.is_archived = True
            label.save(update_fields=['is_archived'])
            AuditLog.objects.create(
                actor=request.user,
                action='GROUP_LABEL_ARCHIVED',
                entity_type='GroupLabel',
                entity_id=label.id,
                details={'name': label.name},
                ip_address=_client_ip(request) or None,
            )
        return Response(GroupLabelSerializer(label).data)


class GroupLabelUnarchiveView(_GroupLabelActionBase):
    """POST /api/v1/group-labels/{id}/unarchive/."""

    def post(self, request, id):
        # SUSPENDED denial handled by ChurchNotSuspended via _GroupLabelActionBase.get_permissions.
        label, err = self.get_object(request, id)
        if err is not None:
            return err
        with transaction.atomic():
            label.is_archived = False
            label.save(update_fields=['is_archived'])
            AuditLog.objects.create(
                actor=request.user,
                action='GROUP_LABEL_UNARCHIVED',
                entity_type='GroupLabel',
                entity_id=label.id,
                details={'name': label.name},
                ip_address=_client_ip(request) or None,
            )
        return Response(GroupLabelSerializer(label).data)

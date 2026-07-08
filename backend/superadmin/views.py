"""Super Admin endpoints (Step 2.9c) — platform-wide reads + state-changers.

INVERTED PERMISSION STORY
─────────────────────────
2.8 / 2.9a / 2.9b: "scope to your own church, deny cross-church." The risk
was leaking another church's data.

2.9c: Super Admin acts ACROSS ALL churches by design. The risk INVERTS — the
danger is forgetting `IsSuperAdmin` on an admin endpoint and leaving it
reachable by treasurers or anonymous users (a treasurer hitting force-retry
would be catastrophic). EVERY endpoint in this module has
`permission_classes = [IsSuperAdmin]`. ChurchScopedPermission is deliberately
NOT used — it would break the cross-church view.

FORCE-RETRY — the money-mover
─────────────────────────────
Same Phase 1 / Phase 2 architecture as the treasurer approve flow (2.9b):
  Phase 1 (locked): SELECT FOR UPDATE campaign, re-verify balance, set
    PROCESSING, AuditLog, commit — lock released here.
  Phase 2 (unlocked): DarajaClient().b2c_payout(). On B2CDispatchError → FAILED
    + reason (strand prevention). The structural test in tests/test_superadmin.py
    pins this — moving the b2c call back inside the locked block fails CI.

Force-retry feeds the stuck-PROCESSING sweep requirement recorded for Step
2.10 (see project_phase2_step29b.md dependency #5): this endpoint also
transitions FAILED_FINAL → PROCESSING, so a process crash between Phase 1
commit and Phase 2 save would strand the row at PROCESSING. The sweep task
covers both paths.

REJECTION-STATUS DECISION (2.9c)
────────────────────────────────
The PRD reject action mapped to no existing ChurchStatus. Decided: ADD
`ChurchStatus.REJECTED`. Reason kept in AuditLog details (action=CHURCH_REJECTED),
NOT on a new Church.rejection_reason field — keeps the model lean and the
audit trail authoritative. The rejection email carries the reason to the user.

PlatformSettings — the fee_percent confinement
───────────────────────────────────────────────
Only GET/PATCH /api/v1/super/billing/ exposes `fee_percent`. No other
endpoint includes it. Confirmed by tests/test_superadmin.py::FeeExposureConfinement.
"""

from decimal import Decimal
import logging

from datetime import date

from django.db import transaction
from django.db.models import Count, Q, Sum
from django.db.models.functions import Coalesce, TruncMonth
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import serializers as drf_serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User, UserRole
from audit.models import AuditLog
from audit.serializers import AuditLogSerializer
from campaigns.models import Campaign, CampaignStatus
from campaigns.serializers import SuperCampaignSerializer
from churches.models import Church, ChurchStatus, SubscriptionTier
from churches.serializers import AdminChurchSerializer
from churches.services import set_church_tier
from common.masking import mask_phone
from common.pagination import StandardPagination
from common.permissions import IsSuperAdmin
from donations.models import Donation, DonationStatus
from donations.serializers import AdminDonationSerializer
from integrations.daraja import (
    B2CDispatchAmbiguousError,
    B2CDispatchCleanError,
    DarajaClient,
    new_originator_conversation_id,
)
from integrations.resend_email import (
    send_registration_approved,
    send_registration_rejected,
)
from notifications.models import Notification, NotificationType
from superadmin.models import PlatformSettings
from withdrawals.models import (
    Withdrawal,
    WithdrawalDispatchOutcome,
    WithdrawalStatus,
)
from withdrawals.serializers import WithdrawalSerializer
from withdrawals.services import finalize_withdrawal_paid, record_dispatch_failure


logger = logging.getLogger(__name__)


def _client_ip(request):
    return request.META.get('REMOTE_ADDR') or ''


def _parse_date_param(raw, field_name):
    """Parse a YYYY-MM-DD query param into a date, or raise DRF ValidationError (→400).

    Returns None for an empty/absent param (filter not applied). A present but
    unparseable value (e.g. 'notadate', '2026-13-99') raises ValidationError so
    DRF emits a clean 400 — a bad param must never reach the aggregate and 500.
    """
    raw = (raw or '').strip()
    if not raw:
        return None
    # parse_date returns None for malformed input ('notadate') but RAISES
    # ValueError for well-formed-but-out-of-range input ('2026-13-99'). Both
    # are bad params → 400, never a 500 leaking out of the aggregate.
    try:
        parsed = parse_date(raw)
    except ValueError:
        parsed = None
    if parsed is None:
        raise drf_serializers.ValidationError(
            {field_name: f"Invalid date '{raw}'. Use YYYY-MM-DD."}
        )
    return parsed


# ═════════════════════════════════════════════════════════════════════════════
# Reads — platform-wide, IsSuperAdmin only
# ═════════════════════════════════════════════════════════════════════════════


class SuperChurchesListView(APIView):
    """GET /api/v1/super/churches/ — ALL churches, all statuses.

    permission_classes = [IsSuperAdmin]
      * Cross-church by design — NO church scoping. The list MUST include
        churches of every status (PENDING, ACTIVE, SUSPENDED, REJECTED).
    """

    permission_classes = [IsSuperAdmin]
    pagination_class = StandardPagination

    def get(self, request):
        # Two per-row aggregates for the Churches screen, both over the SAME
        # reverse relation `campaigns` → a single LEFT JOIN, so the Count and Sum
        # do NOT inflate each other (cartesian inflation only arises across two
        # DIFFERENT to-many relations). distinct=True on the Count is belt-and-
        # suspenders. Coalesce → a church with no campaigns gets 0.00, never null.
        # AdminChurchSerializer reads these annotation attributes (annotated_*).
        qs = Church.objects.annotate(
            annotated_active_campaign_count=Count(
                'campaigns',
                filter=Q(campaigns__status=CampaignStatus.ACTIVE),
                distinct=True,
            ),
            annotated_total_raised=Coalesce(
                Sum('campaigns__raised_amount'), Decimal('0.00'),
            ),
        ).order_by('-created_at')
        status_filter = request.query_params.get('status', '').strip()
        tier_filter = request.query_params.get('tier', '').strip()
        search = request.query_params.get('search', '').strip()
        if status_filter:
            qs = qs.filter(status=status_filter)
        if tier_filter:
            qs = qs.filter(subscription_tier=tier_filter)
        if search:
            qs = qs.filter(name__icontains=search)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(AdminChurchSerializer(page, many=True).data)


class SuperChurchesPendingView(APIView):
    """GET /api/v1/super/churches/pending/ — the registration queue.

    PENDING only, ordered by created_at (oldest first — first in, first reviewed).
    """

    permission_classes = [IsSuperAdmin]
    pagination_class = StandardPagination

    def get(self, request):
        qs = Church.objects.filter(status=ChurchStatus.PENDING).order_by('created_at')
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(AdminChurchSerializer(page, many=True).data)


class SuperCampaignsListView(APIView):
    """GET /api/v1/super/campaigns/ — ALL campaigns, all statuses, cross-church."""

    permission_classes = [IsSuperAdmin]
    pagination_class = StandardPagination

    def get(self, request):
        qs = Campaign.objects.select_related('church', 'group_label').order_by('-created_at')
        status_filter = request.query_params.get('status', '').strip()
        church_filter = request.query_params.get('church', '').strip()
        search = request.query_params.get('search', '').strip()
        if status_filter:
            qs = qs.filter(status=status_filter)
        if church_filter:
            qs = qs.filter(church_id=church_filter)
        if search:
            qs = qs.filter(title__icontains=search)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(SuperCampaignSerializer(page, many=True).data)


class SuperDonationsListView(APIView):
    """GET /api/v1/super/donations/ — ALL donations platform-wide.

    THE authorized place for the gross / platform_fee / net_amount breakdown
    (PRD §8.6). AdminDonationSerializer exposes all three. No other 2.9c
    endpoint leaks fee/net.
    """

    permission_classes = [IsSuperAdmin]
    pagination_class = StandardPagination

    def get(self, request):
        qs = Donation.objects.select_related('campaign', 'campaign__church').order_by('-created_at')
        church_filter = request.query_params.get('church', '').strip()
        status_filter = request.query_params.get('status', '').strip()
        date_from = request.query_params.get('from', '').strip()
        date_to = request.query_params.get('to', '').strip()
        if church_filter:
            qs = qs.filter(campaign__church_id=church_filter)
        if status_filter:
            qs = qs.filter(status=status_filter)
        if date_from:
            qs = qs.filter(created_at__gte=date_from)
        if date_to:
            qs = qs.filter(created_at__lte=date_to)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(AdminDonationSerializer(page, many=True).data)


class SuperWithdrawalsListView(APIView):
    """GET /api/v1/super/withdrawals/ — ALL withdrawals platform-wide.

    Filter by status to surface the FAILED_FINAL force-retry queue.
    WithdrawalSerializer is the authorized-surface serializer — appropriate
    here because Super Admin is authorized for all churches.
    """

    permission_classes = [IsSuperAdmin]
    pagination_class = StandardPagination

    def get(self, request):
        qs = Withdrawal.objects.select_related('campaign', 'campaign__church').order_by('-created_at')
        status_filter = request.query_params.get('status', '').strip()
        church_filter = request.query_params.get('church', '').strip()
        if status_filter:
            qs = qs.filter(status=status_filter)
        if church_filter:
            qs = qs.filter(campaign__church_id=church_filter)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(WithdrawalSerializer(page, many=True).data)


class SuperAnalyticsView(APIView):
    """GET /api/v1/super/analytics/ — platform totals derived from live data.

    Includes total platform fees collected (Pamoja Hub's revenue — sum of
    Donation.platform_fee across SUCCESSFUL donations). This is the Super Admin's
    revenue dashboard.

    Time-range filter: from/to query params restrict donation aggregates.
    """

    permission_classes = [IsSuperAdmin]

    def get(self, request):
        churches_by_status = dict(
            Church.objects.values_list('status').annotate(c=Count('id'))
        )
        active_campaigns = Campaign.objects.filter(status=CampaignStatus.ACTIVE).count()

        donations_qs = Donation.objects.filter(status=DonationStatus.SUCCESSFUL)
        # Date-INCLUSIVE bounds. created_at is a datetime; comparing it against a
        # bare 'to' date with __lte coerces to midnight at the START of that day
        # and silently drops every donation later than 00:00:00 on the to date —
        # i.e. the entire final day is excluded. __date__lte compares the DATE
        # part, so a donation at 23:30 on the to date is included. A bad param
        # raises 400 here (see _parse_date_param), never 500 inside aggregate.
        date_from = _parse_date_param(request.query_params.get('from'), 'from')
        date_to = _parse_date_param(request.query_params.get('to'), 'to')
        if date_from is not None:
            donations_qs = donations_qs.filter(created_at__date__gte=date_from)
        if date_to is not None:
            donations_qs = donations_qs.filter(created_at__date__lte=date_to)

        donation_sums = donations_qs.aggregate(
            count=Count('id'),
            gross_total=Sum('amount'),
            net_total=Sum('net_amount'),
            fee_total=Sum('platform_fee'),
        )

        # ── Chart 1: donations by month — fixed trailing 12-month GROSS series. ──
        # Deliberately INDEPENDENT of the from/to params (they scope the headline
        # totals above; this chart owns its own fixed window). GROSS (amount) to
        # match the headline "Total Donations" card. The 12-month skeleton is built
        # in Python and zero-filled — the DB emits only months that HAVE donations,
        # so relying on it would drop empty months and yield fewer than 12 bars.
        current_month_idx = timezone.now().year * 12 + (timezone.now().month - 1)
        oldest_idx = current_month_idx - 11        # 12 buckets incl. current month
        window_start = date(oldest_idx // 12, oldest_idx % 12 + 1, 1)
        monthly_rows = (
            Donation.objects
            .filter(status=DonationStatus.SUCCESSFUL, created_at__date__gte=window_start)
            .annotate(m=TruncMonth('created_at'))
            .values('m')
            .annotate(gross=Sum('amount'))
        )
        monthly_map = {row['m'].strftime('%Y-%m'): row['gross'] for row in monthly_rows}
        donations_by_month = []
        for offset in range(12):
            idx = oldest_idx + offset
            key = f'{idx // 12:04d}-{idx % 12 + 1:02d}'
            total = monthly_map.get(key) or Decimal('0.00')
            donations_by_month.append({'month': key, 'total': str(total)})

        # ── Chart 2: top 10 churches by NET raised. Reuses the churches-list ──
        # annotation (Coalesce(Sum('campaigns__raised_amount'))). Platform-wide by
        # design (super-admin analytics) — no per-church scope. church_name only;
        # NO phone / treasurer / email leaves this surface.
        top_churches = (
            Church.objects
            .annotate(total_raised=Coalesce(Sum('campaigns__raised_amount'), Decimal('0.00')))
            .order_by('-total_raised', 'name')[:10]
        )
        top_churches_by_raised = [
            {'church_name': c.name, 'total_raised': str(c.total_raised)}
            for c in top_churches
        ]

        return Response({
            'churches_by_status': {
                ChurchStatus.PENDING: churches_by_status.get(ChurchStatus.PENDING, 0),
                ChurchStatus.ACTIVE: churches_by_status.get(ChurchStatus.ACTIVE, 0),
                ChurchStatus.SUSPENDED: churches_by_status.get(ChurchStatus.SUSPENDED, 0),
                ChurchStatus.REJECTED: churches_by_status.get(ChurchStatus.REJECTED, 0),
            },
            'active_campaigns': active_campaigns,
            'donations': {
                'count': donation_sums['count'] or 0,
                'gross_total': str(donation_sums['gross_total'] or Decimal('0')),
                'net_total': str(donation_sums['net_total'] or Decimal('0')),
            },
            'platform_fees_collected': str(donation_sums['fee_total'] or Decimal('0')),
            'donations_by_month': donations_by_month,
            'top_churches_by_raised': top_churches_by_raised,
        })


class SuperAuditLogView(APIView):
    """GET /api/v1/super/audit-log/ — read-only forensic surface."""

    permission_classes = [IsSuperAdmin]
    pagination_class = StandardPagination

    def get(self, request):
        qs = AuditLog.objects.select_related('actor').order_by('-created_at')
        entity_type = request.query_params.get('entity_type', '').strip()
        action = request.query_params.get('action', '').strip()
        actor = request.query_params.get('actor', '').strip()
        date_from = request.query_params.get('from', '').strip()
        date_to = request.query_params.get('to', '').strip()
        if entity_type:
            qs = qs.filter(entity_type=entity_type)
        if action:
            qs = qs.filter(action=action)
        if actor:
            qs = qs.filter(actor__email__icontains=actor)
        if date_from:
            qs = qs.filter(created_at__gte=date_from)
        if date_to:
            qs = qs.filter(created_at__lte=date_to)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(AuditLogSerializer(page, many=True).data)


# ═════════════════════════════════════════════════════════════════════════════
# State-changers — registration approve/reject, suspend/reactivate
# ═════════════════════════════════════════════════════════════════════════════


def _get_church_or_404(church_id):
    try:
        return Church.objects.get(id=church_id), None
    except Church.DoesNotExist:
        return None, Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)


class _RejectReasonSerializer(drf_serializers.Serializer):
    rejection_reason = drf_serializers.CharField(min_length=5, max_length=2000)


class _OptionalReasonSerializer(drf_serializers.Serializer):
    reason = drf_serializers.CharField(required=False, allow_blank=True,
                                       max_length=2000)


class _ResolvePaidInputSerializer(drf_serializers.Serializer):
    # max_length matches Withdrawal.payout_reference (models.py:109).
    # No format regex — M-Pesa B2C codes vary; required + non-blank is the only gate.
    payout_reference = drf_serializers.CharField(
        required=True, allow_blank=False, trim_whitespace=True, max_length=100,
    )


class _SetTierInputSerializer(drf_serializers.Serializer):
    # ChoiceField validates against the model's SubscriptionTier choices — anything
    # outside FREE/GROWTH/PARISH (or a missing field) raises a field-keyed 400
    # {"subscription_tier":[...]}, same shape as _ResolvePaidInputSerializer's
    # field-keyed reject. required=True so an empty body is rejected, not defaulted.
    subscription_tier = drf_serializers.ChoiceField(
        choices=SubscriptionTier.choices, required=True,
    )


def _notify_church_treasurers(church, *, notification_type, title, message):
    """In-app notifications to all CHURCH_TREASURER users of `church`."""
    recipients = User.objects.filter(church=church, role=UserRole.CHURCH_TREASURER)
    for recipient in recipients:
        Notification.objects.create(
            recipient=recipient,
            notification_type=notification_type,
            title=title,
            message=message,
        )


class SuperChurchApproveView(APIView):
    """POST /api/v1/super/churches/{id}/approve/ — PENDING → ACTIVE."""

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        church, err = _get_church_or_404(id)
        if err is not None:
            return err
        if church.status != ChurchStatus.PENDING:
            return Response(
                {'detail': 'Only PENDING churches can be approved.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            church.status = ChurchStatus.ACTIVE
            church.save(update_fields=['status'])
            AuditLog.objects.create(
                actor=request.user,
                action='CHURCH_APPROVED',
                entity_type='Church',
                entity_id=church.id,
                details={'church_name': church.name},
                ip_address=_client_ip(request) or None,
            )

        # In-app notification to treasurers. NotificationType GAP — no enum
        # value matches "registration approved". The DISBURSEMENT_APPROVED /
        # SUBSCRIPTION_REMINDER values don't fit either. Per the established
        # pattern (Step 2.7 CHURCH_REGISTERED gap), do NOT invent an enum
        # silently — record the gap in memory and emit the email + AuditLog
        # as the canonical signal. The frontend can also poll church_status
        # via /churches/me/ to discover the change.
        send_registration_approved(email=church.official_email, church_name=church.name)
        return Response(AdminChurchSerializer(church).data, status=status.HTTP_200_OK)


class SuperChurchRejectView(APIView):
    """POST /api/v1/super/churches/{id}/reject/ — PENDING → REJECTED + reason in AuditLog."""

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        church, err = _get_church_or_404(id)
        if err is not None:
            return err
        if church.status != ChurchStatus.PENDING:
            return Response(
                {'detail': 'Only PENDING churches can be rejected.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = _RejectReasonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        reason = serializer.validated_data['rejection_reason']

        with transaction.atomic():
            church.status = ChurchStatus.REJECTED
            church.rejection_reason = reason  # 2.12b: durable, treasurer-readable home
            church.save(update_fields=['status', 'rejection_reason'])
            AuditLog.objects.create(
                actor=request.user,
                action='CHURCH_REJECTED',
                entity_type='Church',
                entity_id=church.id,
                details={'church_name': church.name, 'reason': reason},
                ip_address=_client_ip(request) or None,
            )

        send_registration_rejected(
            email=church.official_email,
            church_name=church.name,
            reason=reason,
        )
        return Response(AdminChurchSerializer(church).data, status=status.HTTP_200_OK)


class SuperChurchSuspendView(APIView):
    """POST /api/v1/super/churches/{id}/suspend/ — ACTIVE → SUSPENDED.

    The action that makes all ChurchNotSuspended enforcement REAL — after this,
    the church's treasurer's state-changing requests start failing on their
    next call (ChurchNotSuspended re-checks live status; no token revocation
    needed). The cross-layer effect is verified by tests/test_superadmin.py::
    SuspendCrossLayerEffectTest.
    """

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        church, err = _get_church_or_404(id)
        if err is not None:
            return err
        if church.status != ChurchStatus.ACTIVE:
            return Response(
                {'detail': 'Only ACTIVE churches can be suspended.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = _OptionalReasonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        reason = serializer.validated_data.get('reason', '')

        with transaction.atomic():
            church.status = ChurchStatus.SUSPENDED
            church.save(update_fields=['status'])
            AuditLog.objects.create(
                actor=request.user,
                action='CHURCH_SUSPENDED',
                entity_type='Church',
                entity_id=church.id,
                details={'church_name': church.name, 'reason': reason},
                ip_address=_client_ip(request) or None,
            )

        return Response(AdminChurchSerializer(church).data, status=status.HTTP_200_OK)


class SuperChurchReactivateView(APIView):
    """POST /api/v1/super/churches/{id}/reactivate/ — SUSPENDED → ACTIVE."""

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        church, err = _get_church_or_404(id)
        if err is not None:
            return err
        if church.status != ChurchStatus.SUSPENDED:
            return Response(
                {'detail': 'Only SUSPENDED churches can be reactivated.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            church.status = ChurchStatus.ACTIVE
            church.save(update_fields=['status'])
            AuditLog.objects.create(
                actor=request.user,
                action='CHURCH_REACTIVATED',
                entity_type='Church',
                entity_id=church.id,
                details={'church_name': church.name},
                ip_address=_client_ip(request) or None,
            )

        return Response(AdminChurchSerializer(church).data, status=status.HTTP_200_OK)


class SuperChurchSetTierView(APIView):
    """POST /api/v1/super/churches/{id}/set-tier/ — assign a church's subscription tier.

    Body: {"subscription_tier": "<FREE|GROWTH|PARISH>"}. Mirrors the status-change
    views (SuperChurchSuspendView etc.): IsSuperAdmin, _get_church_or_404, a locked
    select_for_update flip under transaction.atomic, an AuditLog write, and an
    AdminChurchSerializer response (which carries subscription_tier).

    ┌─────────────────────────────────────────────────────────────────────────┐
    │ MONEY-INERT — but NO LONGER behaviourally inert.                          │
    │ This endpoint changes ONLY church.subscription_tier (it deliberately does │
    │ NOT touch subscription_expires_at, does NOT pro-rate, refund, or charge —  │
    │ no money behaviour is designed yet, and inventing it here would invent     │
    │ money rules). But subscription_tier is now read by THREE downstream paths: │
    │   (a) the Super churches-list `tier` filter (SuperChurchesListView) +      │
    │       display badge;                                                       │
    │   (b) the FREE active-campaign cap enforced at campaign create             │
    │       (TIER_ACTIVE_CAMPAIGN_CAP, churches/models.py);                      │
    │   (c) the subscription-lapse job, which flips paid→FREE past grace         │
    │       (churches/tasks.run_subscription_lapses).                            │
    │ A tier change is therefore a BEHAVIOURAL event (it arms/disarms the cap),  │
    │ not inert — even though it remains money-inert.                            │
    │                                                                           │
    │ ⚠ MUST BE REVISITED before subscription charging goes live: once tiers    │
    │ are actually billed, a tier change becomes a money event (proration,      │
    │ billing-period boundary, expiry, refund) and this endpoint will need real │
    │ money behaviour added. This is the tracked pre-charging gate.             │
    └─────────────────────────────────────────────────────────────────────────┘

    The lock-then-compare-then-save-then-audit core lives in
    churches.services.set_church_tier (shared with the lapse job).
    """

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        serializer = _SetTierInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        new_tier = serializer.validated_data['subscription_tier']

        church, err = _get_church_or_404(id)
        if err is not None:
            return err

        # No-op safe: set_church_tier returns False (no save, no audit) when the
        # church is already on new_tier — still a 200 with the unchanged row.
        with transaction.atomic():
            locked = Church.objects.select_for_update().get(id=church.id)
            set_church_tier(
                locked, new_tier,
                actor=request.user,
                action='CHURCH_TIER_CHANGED',
                ip_address=_client_ip(request) or None,
            )

        return Response(AdminChurchSerializer(locked).data, status=status.HTTP_200_OK)


# ═════════════════════════════════════════════════════════════════════════════
# Force-retry — the money-mover (FAILED_FINAL → PROCESSING)
# ═════════════════════════════════════════════════════════════════════════════


class SuperWithdrawalForceRetryView(APIView):
    """POST /api/v1/super/withdrawals/{id}/force-retry/ — Super Admin only.

    FAILED_FINAL is unreachable by the treasurer's retry endpoint (Step 2.9b),
    so when a withdrawal exhausts its retry budget the only path back is the
    Super Admin. retry_count is RESET TO 0 here (intentional decision —
    Super Admin is overriding the exhausted state with fresh budget, not
    incrementing toward a second escalation).

    permission_classes = [IsSuperAdmin]
      * NO ChurchScopedPermission — admin acts cross-church.

    Same Phase 1 / Phase 2 architecture as the treasurer approve flow (2.9b).
    The structural test in tests/test_superadmin.py::ForceRetryStructuralTest
    pins this — the DarajaClient().b2c_payout() call MUST happen after the
    locked transaction commits.
    """

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        try:
            withdrawal = (
                Withdrawal.objects
                .select_related('campaign', 'campaign__church')
                .get(id=id)
            )
        except Withdrawal.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)

        if withdrawal.status != WithdrawalStatus.FAILED_FINAL:
            return Response(
                {'detail': 'Only FAILED_FINAL withdrawals can be force-retried.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ── Phase 1 (LOCKED) ──
        try:
            with transaction.atomic():
                campaign = Campaign.objects.select_for_update().get(
                    id=withdrawal.campaign_id,
                )
                fresh = Withdrawal.objects.select_for_update().get(id=withdrawal.id)
                if fresh.status != WithdrawalStatus.FAILED_FINAL:
                    return Response(
                        {'detail': 'Only FAILED_FINAL withdrawals can be force-retried.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if fresh.amount > campaign.wallet_balance:
                    # Stay FAILED_FINAL — do NOT auto-rollback to FAILED.
                    return Response(
                        {'detail': 'Insufficient wallet balance for force-retry.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                fresh.status = WithdrawalStatus.PROCESSING
                fresh.retry_count = 0          # fresh retry budget
                fresh.failure_reason = None
                fresh.dispatch_outcome = None  # clear stale dispatch marker
                fresh.b2c_conversation_id = None  # new dispatch → new ConversationID
                # originator_conversation_id rotation: was the CAS version-key read by
                # redispatch_withdrawal (removed 2026-06-07, A2). No reader remains —
                # this is now just a per-dispatch unique id sent to Daraja. Not a
                # concurrency guard.
                fresh.originator_conversation_id = new_originator_conversation_id()
                fresh.approved_by = request.user
                # update_fields explicitly lists updated_at — Django's auto_now
                # is NOT automatically included when update_fields is passed.
                # Every mutated field must be in the list.
                fresh.save(update_fields=[
                    'status', 'retry_count', 'failure_reason', 'dispatch_outcome',
                    'b2c_conversation_id', 'originator_conversation_id',
                    'approved_by', 'updated_at',
                ])
                AuditLog.objects.create(
                    actor=request.user,
                    action='WITHDRAWAL_FORCE_RETRIED',
                    entity_type='Withdrawal',
                    entity_id=fresh.id,
                    details={
                        'campaign_id': str(campaign.id),
                        'amount': str(fresh.amount),
                        # PRD §12.10 — phones masked in forensic surfaces.
                        # The full destination_phone lives on the Withdrawal
                        # row; entity_id links to it.
                        'destination_phone': mask_phone(fresh.destination_phone),
                    },
                    ip_address=_client_ip(request) or None,
                )
                withdrawal = fresh
        except Campaign.DoesNotExist:
            return Response(
                {'detail': 'Campaign for this withdrawal no longer exists.'},
                status=status.HTTP_404_NOT_FOUND,
            )
        # ── Lock released here ──

        # ── Phase 2 (UNLOCKED) ──
        # Force-retry dispatch failure: FAILED_FINAL → FAILED with retry_count
        # already reset to 0 in Phase 1, so the item is now treasurer-retriable
        # again (FAILED is the treasurer's domain). Copy reflects MANUAL retry —
        # there is no automatic retry job. Clean/ambiguous split stamps the
        # dispatch_outcome marker for 2.10c (an AMBIGUOUS force-retry failure
        # must NOT be blind-re-dispatched even though it's back in FAILED).
        try:
            result = DarajaClient().b2c_payout(withdrawal)
            withdrawal.b2c_conversation_id = result['conversation_id']
            withdrawal.save(update_fields=['b2c_conversation_id', 'updated_at'])
            dispatch_failed = False
        except B2CDispatchCleanError as exc:
            record_dispatch_failure(
                withdrawal=withdrawal, campaign=campaign, actor=request.user,
                ip_address=_client_ip(request),
                outcome=WithdrawalDispatchOutcome.CLEAN_FAILURE,
                action='WITHDRAWAL_FORCE_RETRY_DISPATCH_FAILED', exc=exc,
            )
            dispatch_failed = True
        except B2CDispatchAmbiguousError as exc:
            record_dispatch_failure(
                withdrawal=withdrawal, campaign=campaign, actor=request.user,
                ip_address=_client_ip(request),
                outcome=WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE,
                action='WITHDRAWAL_FORCE_RETRY_DISPATCH_FAILED', exc=exc,
            )
            dispatch_failed = True

        body = WithdrawalSerializer(withdrawal).data
        if dispatch_failed:
            body['dispatch_status'] = 'failed_queued_for_retry'
        return Response(body, status=status.HTTP_200_OK)


# ═════════════════════════════════════════════════════════════════════════════
# NEEDS_RECONCILIATION resolution — the ONLY safe human exit (Step 2.10c)
# ═════════════════════════════════════════════════════════════════════════════
#
# A NEEDS_RECONCILIATION row is money-in-limbo the sweep could not resolve. There
# is deliberately NO force-retry from here (blind re-dispatch is the unsafe action
# for exactly these rows). The only exits are these two, each requiring a human
# who has CHECKED M-PESA, each verifying the row is actually NEEDS_RECONCILIATION
# (else 400), each audited with the human actor.


def _fetch_needs_reconciliation_or_400(id):
    try:
        withdrawal = (
            Withdrawal.objects.select_related('campaign', 'campaign__church').get(id=id)
        )
    except Withdrawal.DoesNotExist:
        return None, Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
    if withdrawal.status != WithdrawalStatus.NEEDS_RECONCILIATION:
        return None, Response(
            {'detail': 'This payout is not awaiting reconciliation.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return withdrawal, None


class SuperWithdrawalResolvePaidView(APIView):
    """POST /api/v1/super/withdrawals/{id}/resolve-paid/ — human checked M-Pesa and
    the payout DID land. Finalize PAID via the shared idempotent helper (credit/
    decrement exactly once, safe even if a late real callback also arrives).
    """

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        serializer = _ResolvePaidInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        withdrawal, err = _fetch_needs_reconciliation_or_400(id)
        if err is not None:
            return err
        with transaction.atomic():
            locked = Withdrawal.objects.select_for_update().get(id=withdrawal.id)
            if locked.status != WithdrawalStatus.NEEDS_RECONCILIATION:
                return Response(
                    {'detail': 'This payout is not awaiting reconciliation.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            finalize_withdrawal_paid(
                withdrawal=locked, actor=request.user,
                ip_address=_client_ip(request), source='resolve_paid',
                payout_reference=serializer.validated_data['payout_reference'],
            )
            AuditLog.objects.create(
                actor=request.user,
                action='WITHDRAWAL_RESOLVED_PAID',
                entity_type='Withdrawal',
                entity_id=locked.id,
                details={
                    'campaign_id': str(locked.campaign_id),
                    'amount': str(locked.amount),
                    'originator_conversation_id': locked.originator_conversation_id,
                },
                ip_address=_client_ip(request) or None,
            )
            # If finalize had no M-Pesa reference to set, this row resolves PAID with
            # a NULL payout_reference — no success callback ever arrived for it. Record
            # an explicit marker so PAID-without-receipt is intentional-and-traced, not
            # a silent gap. The receipt-present case (a reconciliation callback persisted
            # the receipt) already has its receipt + the WITHDRAWAL_RESOLVED_PAID audit
            # above, so it gets no marker. finalize mutates `locked` in place, so its
            # post-finalize payout_reference is authoritative here.
            if not locked.payout_reference:
                AuditLog.objects.create(
                    actor=request.user,
                    action='WITHDRAWAL_RESOLVED_WITHOUT_REFERENCE',
                    entity_type='Withdrawal',
                    entity_id=locked.id,
                    details={
                        'campaign_id': str(locked.campaign_id),
                        'amount': str(locked.amount),
                        'originator_conversation_id': locked.originator_conversation_id,
                        # PRD §12.10 — phones masked in forensic surfaces.
                        'destination_phone': mask_phone(locked.destination_phone),
                        'note': (
                            'Resolved PAID with no M-Pesa reference: no success callback '
                            'ever arrived; reconciled manually by Super Admin against the '
                            'M-Pesa statement.'
                        ),
                    },
                    ip_address=_client_ip(request) or None,
                )
            withdrawal = locked
        return Response(WithdrawalSerializer(withdrawal).data, status=status.HTTP_200_OK)


class SuperWithdrawalResolveRetryView(APIView):
    """POST /api/v1/super/withdrawals/{id}/resolve-retry/ — human checked M-Pesa and
    NO payout exists. Move to a re-dispatchable state.

    CHOICE: FAILED with a CLEAN_FAILURE marker + retry_count reset to 0 (treasurer-
    retriable), NOT a direct re-dispatch from this endpoint. Why: the resolution
    endpoint stays NON-money-moving — re-dispatch then goes through the standard
    locked Phase-1/Phase-2 retry path (one code path for all dispatches), and a
    CLEAN marker is accurate (the human confirmed nothing was queued) so the sweep
    won't re-pick it. retry_count=0 gives a fresh budget since there is provably
    no in-flight payout to protect against.
    """

    permission_classes = [IsSuperAdmin]

    def post(self, request, id):
        withdrawal, err = _fetch_needs_reconciliation_or_400(id)
        if err is not None:
            return err
        with transaction.atomic():
            locked = Withdrawal.objects.select_for_update().get(id=withdrawal.id)
            if locked.status != WithdrawalStatus.NEEDS_RECONCILIATION:
                return Response(
                    {'detail': 'This payout is not awaiting reconciliation.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            locked.status = WithdrawalStatus.FAILED
            locked.dispatch_outcome = WithdrawalDispatchOutcome.CLEAN_FAILURE
            locked.retry_count = 0
            locked.failure_reason = (
                'Reconciled: no payout found. Retry from the Withdrawals panel.'
            )
            locked.b2c_conversation_id = None
            locked.save(update_fields=[
                'status', 'dispatch_outcome', 'retry_count', 'failure_reason',
                'b2c_conversation_id', 'updated_at',
            ])
            AuditLog.objects.create(
                actor=request.user,
                action='WITHDRAWAL_RESOLVED_RETRY',
                entity_type='Withdrawal',
                entity_id=locked.id,
                details={
                    'campaign_id': str(locked.campaign_id),
                    'amount': str(locked.amount),
                    'originator_conversation_id': locked.originator_conversation_id,
                },
                ip_address=_client_ip(request) or None,
            )
            withdrawal = locked
        return Response(WithdrawalSerializer(withdrawal).data, status=status.HTTP_200_OK)


# ═════════════════════════════════════════════════════════════════════════════
# Billing — PlatformSettings GET/PATCH (the only fee_percent surface)
# ═════════════════════════════════════════════════════════════════════════════


# Tier-price bounds. A monthly plan price is money CONFIG, so the guard mirrors
# the fee_percent shape (a single bounded range that 400s on anything outside it).
# LOWER bound is EXCLUSIVE zero — a 0 price is almost certainly a fat-finger, not an
# intended "paid tier that's actually free" (FREE already exists for that). UPPER
# bound is a generous KES 1,000,000/mo ceiling: far above any real plan price yet
# well under the DecimalField's 99,999,999.99 max, so an extra-digit slip is caught.
_PRICE_MIN = Decimal('0')           # exclusive — price must be > 0
_PRICE_MAX = Decimal('1000000')     # inclusive — price must be <= 1,000,000


class _PlatformSettingsSerializer(drf_serializers.ModelSerializer):
    """Bounded validation: fee_percent must be 0..10 (no realistic platform
    fee exceeds 10%); growth/parish prices must be > 0 and <= 1,000,000.
    """

    class Meta:
        model = PlatformSettings
        fields = ['fee_percent', 'growth_price', 'parish_price', 'updated_at']
        read_only_fields = ['updated_at']

    def validate_fee_percent(self, value):
        if value < Decimal('0') or value > Decimal('10'):
            raise drf_serializers.ValidationError(
                'fee_percent must be between 0 and 10.'
            )
        return value

    def validate_growth_price(self, value):
        if value <= _PRICE_MIN or value > _PRICE_MAX:
            raise drf_serializers.ValidationError(
                'growth_price must be greater than 0 and at most 1,000,000.'
            )
        return value

    def validate_parish_price(self, value):
        if value <= _PRICE_MIN or value > _PRICE_MAX:
            raise drf_serializers.ValidationError(
                'parish_price must be greater than 0 and at most 1,000,000.'
            )
        return value


class SuperBillingView(APIView):
    """GET/PATCH /api/v1/super/billing/ — the ONLY fee_percent surface.

    GET on a fresh DB returns DEFAULTS via PlatformSettings.load() — the
    singleton get_or_creates with defaults, never raises DoesNotExist.

    Fee changes apply FORWARD-ONLY: existing Donation rows keep their stored
    `platform_fee` / `net_amount`. Step 2.10's donation processing reads
    PlatformSettings.load().fee_percent LIVE at confirmation time.
    """

    permission_classes = [IsSuperAdmin]

    def get(self, request):
        settings = PlatformSettings.load()
        return Response(_PlatformSettingsSerializer(settings).data)

    def patch(self, request):
        settings = PlatformSettings.load()
        old_snapshot = {
            'fee_percent': str(settings.fee_percent),
            'growth_price': str(settings.growth_price),
            'parish_price': str(settings.parish_price),
        }
        serializer = _PlatformSettingsSerializer(settings, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)

        with transaction.atomic():
            serializer.save()
            new_snapshot = {
                'fee_percent': str(settings.fee_percent),
                'growth_price': str(settings.growth_price),
                'parish_price': str(settings.parish_price),
            }
            AuditLog.objects.create(
                actor=request.user,
                action='PLATFORM_SETTINGS_CHANGED',
                entity_type='PlatformSettings',
                entity_id='00000000-0000-0000-0000-000000000001',  # singleton sentinel
                details={'old': old_snapshot, 'new': new_snapshot},
                ip_address=_client_ip(request) or None,
            )

        return Response(_PlatformSettingsSerializer(settings).data)

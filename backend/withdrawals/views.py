"""Withdrawal lifecycle endpoints (Step 2.9b) — the Church Treasurer side of payouts.

Endpoints (all mounted under /api/v1/withdrawals/):
  * GET   /                  list — IsChurchTreasurer + church-filtered queryset.
  * POST  /{id}/approve/     THE MONEY-MOVER — Phase 1/Phase 2 split, see below.
  * POST  /{id}/reject/      reject with required reason.
  * POST  /{id}/retry/       retry a FAILED withdrawal (retry_count < 5).

──────────────────────────────────────────────────────────────────────────────
THE ARCHITECTURE RULE — read before reviewing the approval endpoint
──────────────────────────────────────────────────────────────────────────────
The B2C call is a NETWORK call. It MUST happen OUTSIDE the SELECT FOR UPDATE
transaction. The pattern:

    # Phase 1 — inside transaction.atomic(), holds the campaign row lock:
    with transaction.atomic():
        campaign = Campaign.objects.select_for_update().get(...)
        # re-check status, re-check balance
        withdrawal.status = PROCESSING; withdrawal.save(...)
        AuditLog.objects.create(...)
        # COMMIT happens at block exit — lock released here

    # Phase 2 — AFTER the lock is released, make the external call:
    try:
        result = DarajaClient().b2c_payout(withdrawal)
        ...store conversation_id...
    except B2CDispatchError:
        ...strand prevention: withdrawal → FAILED + failure_reason...

Why the lock MUST NOT wrap the B2C call: a slow/hanging external HTTP call
would hold the campaign row lock for the entire network round-trip, blocking
every other operation on that campaign (donation-callback wallet updates, the
disbursements list, concurrent approvals on sibling withdrawals) until Daraja
responds or times out. External API latency must never become DB lock-hold
time. The structural test in tests/test_withdrawals.py asserts the B2C call
happens AFTER the transaction commits.

──────────────────────────────────────────────────────────────────────────────
THE CRITICAL CHECK — check_object_permissions
──────────────────────────────────────────────────────────────────────────────
DRF auto-invokes has_object_permission ONLY on generic views (RetrieveAPIView
etc.). These are APIView subclasses — DRF does NOT call it for us. We MUST
call self.check_object_permissions(request, withdrawal) explicitly after
fetching the withdrawal. Forgetting it would mean Treasurer B can approve
Church A's withdrawal because the view-level perms (ChurchNotSuspended,
ChurchScopedPermission's has_permission) only check role + own-church status.
The CROSS-CHURCH denial lives in has_object_permission. Every approve/reject/
retry handler below calls check_object_permissions immediately after fetching
the withdrawal — this is the all-caps CRITICAL CHECK actually firing.

──────────────────────────────────────────────────────────────────────────────
Status guards (per PRD §8.5.5 and the Step 2.9b brief):
  approve: only PENDING_APPROVAL → PROCESSING (then PAID/FAILED via 2.10 callback).
  reject:  only PENDING_APPROVAL → REJECTED.
  retry:   only FAILED (and retry_count < 5) → PROCESSING. FAILED_FINAL needs
           Super Admin (Step 2.9c). PAID/REJECTED/PENDING_APPROVAL/PROCESSING all
           reject with 400.

Insufficient-balance-at-approve-time decision: leave withdrawal at
PENDING_APPROVAL, return 400 with a clear message. Do NOT auto-reject. The
treasurer can request a smaller amount or wait for donations to clear.
"""

import logging

from django.db import transaction
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from audit.models import AuditLog
from campaigns.models import Campaign
from common.masking import mask_phone
from common.pagination import StandardPagination
from common.permissions import (
    ChurchNotSuspended,
    ChurchScopedPermission,
    IsChurchTreasurer,
)
from integrations.africastalking import (
    send_payout_approved,
    send_payout_rejected,
)
from integrations.resend_email import (
    send_payout_approved_email,
    send_payout_rejected_email,
)
from integrations.daraja import (
    B2CDispatchAmbiguousError,
    B2CDispatchCleanError,
    DarajaClient,
    new_originator_conversation_id,
)
from notifications.models import Notification, NotificationType
# _parse_date_param: shared YYYY-MM-DD parser (→ date or DRF 400). Imported (not
# copied) so the withdrawals list from/to behaves EXACTLY like /churches/me/donations/.
from superadmin.views import _parse_date_param
from withdrawals.models import (
    MAX_RETRIES,
    RESULT_CALLBACK_IGNORED_STATUSES,
    Withdrawal,
    WithdrawalDispatchOutcome,
    WithdrawalStatus,
)
from withdrawals.serializers import WithdrawalSerializer
from withdrawals.services import finalize_withdrawal_paid, record_dispatch_failure


logger = logging.getLogger(__name__)


def _client_ip(request):
    return request.META.get('REMOTE_ADDR') or ''


def _notify_church_treasurers(church, notification_type, title, message,
                              related_campaign, related_withdrawal):
    """Fan out an in-app notification to every Church Treasurer of `church`.

    In-app notifications go to the CHURCH TREASURER (has an account). The
    Campaign Treasurer (no account) is notified via SMS — that goes through
    AT, not this function.
    """
    from accounts.models import User, UserRole
    recipients = User.objects.filter(church=church, role=UserRole.CHURCH_TREASURER)
    for recipient in recipients:
        Notification.objects.create(
            recipient=recipient,
            notification_type=notification_type,
            title=title,
            message=message,
            related_campaign=related_campaign,
            related_withdrawal=related_withdrawal,
        )


# ───────────────────── GET /withdrawals/ — list ──────────────────────────────


class WithdrawalListView(APIView):
    """GET /api/v1/withdrawals/ — Church Treasurer's withdrawals across all their
    campaigns.

    LEAK SURFACE: `get_queryset` filters by `campaign__church=request.user.church`.
    This is the only thing that protects the list — ChurchScopedPermission's
    object-level check does not fire on list endpoints. Verified by the
    cross-church list-leak probe in tests/test_withdrawals.py.

    permission_classes = [IsChurchTreasurer]
      * Read endpoint — SUSPENDED churches still see their pending payouts.

    WithdrawalSerializer exposes the FULL destination_phone (authorized surface;
    the Church Treasurer's approval dialog needs the unmasked number). The 2.5
    tripwire applies: this serializer MUST NEVER be wired to a public/cross-
    church endpoint. This endpoint is church-scoped (queryset filter) so it
    satisfies the contract.
    """

    permission_classes = [IsChurchTreasurer]
    pagination_class = StandardPagination

    def get_queryset(self, request):
        # ★ LEAK GUARD ★ — must filter by campaign__church
        return (
            Withdrawal.objects
            .filter(campaign__church=request.user.church)
            .select_related('campaign')
        )

    def get(self, request):
        qs = self.get_queryset(request)
        status_filter = request.query_params.get('status', '').strip()
        campaign_filter = request.query_params.get('campaign', '').strip()
        if status_filter:
            qs = qs.filter(status=status_filter)
        if campaign_filter:
            qs = qs.filter(campaign_id=campaign_filter)
        # Date-inclusive from/to (created_at__date bounds), mirroring
        # /churches/me/donations/. A malformed param raises 400 here, never a 500.
        date_from = _parse_date_param(request.query_params.get('from'), 'from')
        date_to = _parse_date_param(request.query_params.get('to'), 'to')
        if date_from is not None:
            qs = qs.filter(created_at__date__gte=date_from)
        if date_to is not None:
            qs = qs.filter(created_at__date__lte=date_to)
        qs = qs.order_by('-created_at')

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(WithdrawalSerializer(page, many=True).data)


# ───────────────────── helpers shared by state-change endpoints ──────────────


def _fetch_withdrawal_or_404(view, request, withdrawal_id):
    """Fetch withdrawal by id and RUN check_object_permissions (the all-caps
    CRITICAL CHECK).

    DRF does not auto-invoke has_object_permission on APIView; we call it
    explicitly here. ChurchScopedPermission.has_object_permission compares
    withdrawal.campaign.church to request.user.church (via
    resolve_object_church, which handles the via-campaign path), fail-closed
    on either side being None.
    """
    try:
        withdrawal = (
            Withdrawal.objects
            .select_related('campaign', 'campaign__church')
            .get(id=withdrawal_id)
        )
    except Withdrawal.DoesNotExist:
        return None, Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
    # ★ THE CRITICAL CHECK ★ — cross-church denial via has_object_permission.
    view.check_object_permissions(request, withdrawal)
    return withdrawal, None


class _RejectReasonSerializer(serializers.Serializer):
    """rejection_reason required, min length 5 — keeps placeholder-only ('.', 'x')
    inputs out per PRD 8.5.5 ("reason must be communicated to the Campaign Treasurer").
    """
    rejection_reason = serializers.CharField(min_length=5, max_length=2000)


# ───────────────────── POST /withdrawals/{id}/approve/ ───────────────────────


class WithdrawalApproveView(APIView):
    """POST /api/v1/withdrawals/{id}/approve/ — THE MONEY-MOVER.

    permission_classes = [ChurchNotSuspended, ChurchScopedPermission]
      * ChurchNotSuspended (view-level): the acting treasurer's own church is
        not SUSPENDED.
      * ChurchScopedPermission (has_permission + has_object_permission): role
        check at view-level; cross-church denial at object-level (invoked via
        the explicit check_object_permissions call inside the handler).
    """

    permission_classes = [ChurchNotSuspended, ChurchScopedPermission]

    def post(self, request, id):
        # 1) Fetch + CRITICAL cross-church check (has_object_permission via
        # check_object_permissions — see helper).
        withdrawal, err = _fetch_withdrawal_or_404(self, request, id)
        if err is not None:
            return err

        # 2) Status guard: only PENDING_APPROVAL can be approved.
        if withdrawal.status != WithdrawalStatus.PENDING_APPROVAL:
            return Response(
                {'detail': 'Only pending requests can be approved.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ── Phase 1 (LOCKED) ──────────────────────────────────────────────
        # Acquire SELECT FOR UPDATE on the campaign, re-verify balance, flip
        # withdrawal to PROCESSING, AuditLog, then COMMIT to release the lock.
        # The B2C call is NOT inside this block.
        try:
            with transaction.atomic():
                campaign = Campaign.objects.select_for_update().get(
                    id=withdrawal.campaign_id,
                )
                # Re-fetch the withdrawal too to read the freshest state — its
                # status could have changed between the early fetch and lock
                # acquisition (e.g. concurrent reject). Use a fresh row read.
                fresh = Withdrawal.objects.select_for_update().get(id=withdrawal.id)
                if fresh.status != WithdrawalStatus.PENDING_APPROVAL:
                    return Response(
                        {'detail': 'Only pending requests can be approved.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                # Balance re-check against the fresh wallet_balance under the lock.
                if fresh.amount > campaign.wallet_balance:
                    # Decision (Step 2.9b brief): leave at PENDING_APPROVAL — do
                    # NOT auto-reject. Treasurer can request a smaller amount or
                    # wait for donations to clear.
                    return Response(
                        {'detail': 'Insufficient wallet balance at approval time.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                fresh.status = WithdrawalStatus.PROCESSING
                fresh.approved_by = request.user
                # Generate + store the OriginatorConversationID BEFORE the Phase-2
                # HTTP call (committed here) — so even a clean strand keeps the
                # M-Pesa lookup handle for the 2.10c sweep.
                # originator_conversation_id rotation: was the CAS version-key read by
                # redispatch_withdrawal (removed 2026-06-07, A2). No reader remains —
                # this is now just a per-dispatch unique id sent to Daraja. Not a
                # concurrency guard.
                fresh.originator_conversation_id = new_originator_conversation_id()
                fresh.save(update_fields=[
                    'status', 'approved_by', 'originator_conversation_id', 'updated_at',
                ])

                AuditLog.objects.create(
                    actor=request.user,
                    action='WITHDRAWAL_APPROVED',
                    entity_type='Withdrawal',
                    entity_id=fresh.id,
                    details={
                        'campaign_id': str(campaign.id),
                        'amount': str(fresh.amount),
                        # PRD §12.10 — masked.
                        'destination_phone': mask_phone(fresh.destination_phone),
                    },
                    ip_address=_client_ip(request) or None,
                )

                # Re-bind so post-transaction code reads the just-committed row.
                withdrawal = fresh
        except Campaign.DoesNotExist:
            return Response(
                {'detail': 'Campaign for this withdrawal no longer exists.'},
                status=status.HTTP_404_NOT_FOUND,
            )
        # ── Lock released here (block exited; transaction committed) ──────

        # ── Phase 2 (UNLOCKED) ────────────────────────────────────────────
        # External B2C call — no DB lock held. Dispatch-failure → strand
        # prevention: set FAILED (never stuck PROCESSING) so the retry path can
        # pick it up. The clean/ambiguous split (separate except arms) stamps a
        # machine-readable dispatch_outcome marker for Step 2.10c's sweep — a
        # CLEAN failure provably never queued (re-dispatchable); an AMBIGUOUS
        # failure may be queued (must verify before retry). Do NOT collapse them.
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
                action='WITHDRAWAL_DISPATCH_FAILED', exc=exc,
            )
            dispatch_failed = True
        except B2CDispatchAmbiguousError as exc:
            record_dispatch_failure(
                withdrawal=withdrawal, campaign=campaign, actor=request.user,
                ip_address=_client_ip(request),
                outcome=WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE,
                action='WITHDRAWAL_DISPATCH_FAILED', exc=exc,
            )
            dispatch_failed = True

        # Notifications (idempotent w.r.t. retry — each invocation creates new rows).
        _notify_church_treasurers(
            church=campaign.church,
            notification_type=NotificationType.DISBURSEMENT_APPROVED,
            title='Payout approved',
            message=(
                f"Payout of KES {withdrawal.amount} for '{campaign.title}' was "
                f"approved and is being processed."
            ),
            related_campaign=campaign,
            related_withdrawal=withdrawal,
        )
        # Campaign Treasurer (no account) — SMS channel.
        send_payout_approved(
            phone=withdrawal.requested_by_phone,
            amount=withdrawal.amount,
            campaign_title=campaign.title,
        )
        # Church Treasurer account — email channel (courtesy; never raises).
        send_payout_approved_email(
            email=campaign.church.official_email,
            amount=withdrawal.amount,
            campaign_title=campaign.title,
        )

        body = WithdrawalSerializer(withdrawal).data
        if dispatch_failed:
            # The HTTP request succeeded; the underlying dispatch did not. Use
            # 200 + an explicit flag so the frontend can show "queued for retry"
            # rather than treating this as a hard failure (which would lose the
            # PROCESSING→FAILED context).
            body['dispatch_status'] = 'failed_queued_for_retry'
        return Response(body, status=status.HTTP_200_OK)


# ───────────────────── POST /withdrawals/{id}/reject/ ────────────────────────


class WithdrawalRejectView(APIView):
    """POST /api/v1/withdrawals/{id}/reject/ — rejection_reason required.

    permission_classes = [ChurchNotSuspended, ChurchScopedPermission]
    """

    permission_classes = [ChurchNotSuspended, ChurchScopedPermission]

    def post(self, request, id):
        withdrawal, err = _fetch_withdrawal_or_404(self, request, id)
        if err is not None:
            return err

        if withdrawal.status != WithdrawalStatus.PENDING_APPROVAL:
            return Response(
                {'detail': 'Only pending requests can be rejected.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = _RejectReasonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        reason = serializer.validated_data['rejection_reason']

        # Reject is purely a status flip — no balance touched, no external call.
        # Still atomic so AuditLog + withdrawal save commit together.
        with transaction.atomic():
            withdrawal.status = WithdrawalStatus.REJECTED
            withdrawal.rejection_reason = reason
            withdrawal.approved_by = request.user  # records WHO acted, approve OR reject
            withdrawal.save(update_fields=[
                'status', 'rejection_reason', 'approved_by', 'updated_at',
            ])
            AuditLog.objects.create(
                actor=request.user,
                action='WITHDRAWAL_REJECTED',
                entity_type='Withdrawal',
                entity_id=withdrawal.id,
                details={
                    'campaign_id': str(withdrawal.campaign_id),
                    'reason': reason,
                    'destination_phone': mask_phone(withdrawal.destination_phone),
                },
                ip_address=_client_ip(request) or None,
            )

        # Notify Church Treasurer (in-app) + Campaign Treasurer (SMS — they have no account).
        _notify_church_treasurers(
            church=withdrawal.campaign.church,
            notification_type=NotificationType.DISBURSEMENT_REJECTED,
            title='Payout rejected',
            message=f"Payout of KES {withdrawal.amount} was rejected: {reason}",
            related_campaign=withdrawal.campaign,
            related_withdrawal=withdrawal,
        )
        send_payout_rejected(
            phone=withdrawal.requested_by_phone,
            campaign_title=withdrawal.campaign.title,
            reason=reason,
        )
        # Church Treasurer account — email channel (courtesy; never raises).
        send_payout_rejected_email(
            email=withdrawal.campaign.church.official_email,
            campaign_title=withdrawal.campaign.title,
            reason=reason,
        )

        return Response(WithdrawalSerializer(withdrawal).data, status=status.HTTP_200_OK)


# ───────────────────── POST /withdrawals/{id}/retry/ ─────────────────────────


class WithdrawalRetryView(APIView):
    """POST /api/v1/withdrawals/{id}/retry/ — retry a FAILED withdrawal.

    Only FAILED (retry_count < MAX_RETRIES) is retriable. FAILED_FINAL is for
    Super Admin only (Step 2.9c). The FAILED → FAILED_FINAL transition at
    retry_count >= MAX_RETRIES is owned by Step 2.10's B2C-callback worker —
    this view only guards against retrying a maxed-out row.

    Same Phase 1/Phase 2 lock-then-call architecture as approve.

    permission_classes = [ChurchNotSuspended, ChurchScopedPermission]
    """

    permission_classes = [ChurchNotSuspended, ChurchScopedPermission]

    def post(self, request, id):
        withdrawal, err = _fetch_withdrawal_or_404(self, request, id)
        if err is not None:
            return err

        if withdrawal.status != WithdrawalStatus.FAILED:
            return Response(
                {'detail': 'Only failed payouts can be retried.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if withdrawal.retry_count >= MAX_RETRIES:
            return Response(
                {'detail': 'Maximum retries reached; contact support.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if withdrawal.dispatch_outcome == WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE:
            return Response(
                {'detail': 'This payout could not be confirmed as un-sent '
                           'and must be reconciled before it can be retried.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ── Phase 1 (LOCKED) ──
        try:
            with transaction.atomic():
                campaign = Campaign.objects.select_for_update().get(
                    id=withdrawal.campaign_id,
                )
                fresh = Withdrawal.objects.select_for_update().get(id=withdrawal.id)

                # Re-verify under the lock — status could have changed (e.g. an
                # asynchronous callback flipped it to PAID between the early
                # fetch and lock acquisition).
                if fresh.status != WithdrawalStatus.FAILED:
                    return Response(
                        {'detail': 'Only failed payouts can be retried.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if fresh.retry_count >= MAX_RETRIES:
                    return Response(
                        {'detail': 'Maximum retries reached; contact support.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if fresh.dispatch_outcome == WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE:
                    return Response(
                        {'detail': 'This payout could not be confirmed as un-sent '
                                   'and must be reconciled before it can be retried.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if fresh.amount > campaign.wallet_balance:
                    return Response(
                        {'detail': 'Insufficient wallet balance at retry time.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                fresh.retry_count += 1
                fresh.status = WithdrawalStatus.PROCESSING
                fresh.failure_reason = None  # clear prior failure reason
                fresh.dispatch_outcome = None  # clear stale dispatch marker
                fresh.b2c_conversation_id = None  # new dispatch → new ConversationID
                # originator_conversation_id rotation: was the CAS version-key read by
                # redispatch_withdrawal (removed 2026-06-07, A2). No reader remains —
                # this is now just a per-dispatch unique id sent to Daraja. Not a
                # concurrency guard.
                fresh.originator_conversation_id = new_originator_conversation_id()
                fresh.save(update_fields=[
                    'retry_count', 'status', 'failure_reason', 'dispatch_outcome',
                    'b2c_conversation_id', 'originator_conversation_id', 'updated_at',
                ])
                AuditLog.objects.create(
                    actor=request.user,
                    action='WITHDRAWAL_RETRIED',
                    entity_type='Withdrawal',
                    entity_id=fresh.id,
                    details={
                        'campaign_id': str(campaign.id),
                        'retry_count': fresh.retry_count,
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
        # ── Lock released here (transaction committed) ──

        # ── Phase 2 (UNLOCKED) — external B2C call. Clean/ambiguous split (see
        # the approve handler) so 2.10c can branch on dispatch_outcome. ──
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
                action='WITHDRAWAL_RETRY_DISPATCH_FAILED', exc=exc,
            )
            dispatch_failed = True
        except B2CDispatchAmbiguousError as exc:
            record_dispatch_failure(
                withdrawal=withdrawal, campaign=campaign, actor=request.user,
                ip_address=_client_ip(request),
                outcome=WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE,
                action='WITHDRAWAL_RETRY_DISPATCH_FAILED', exc=exc,
            )
            dispatch_failed = True

        _notify_church_treasurers(
            church=campaign.church,
            notification_type=NotificationType.DISBURSEMENT_APPROVED,
            title='Payout retry initiated',
            message=(
                f"Payout of KES {withdrawal.amount} for '{campaign.title}' is being "
                f"retried (attempt {withdrawal.retry_count})."
            ),
            related_campaign=campaign,
            related_withdrawal=withdrawal,
        )

        body = WithdrawalSerializer(withdrawal).data
        if dispatch_failed:
            body['dispatch_status'] = 'failed_queued_for_retry'
        return Response(body, status=status.HTTP_200_OK)


# ───────────────────── POST /withdrawals/b2c-result/ ─────────────────────────


def _extract_b2c_result(body):
    """Pull (conversation_id, originator_conversation_id, result_code, transaction_id)
    from a Daraja B2C Result callback. Shape:
        {"Result": {"ConversationID", "OriginatorConversationID", "ResultCode",
                    "TransactionID", ...}}
    """
    result = (body or {}).get('Result', {}) or {}
    conversation_id = str(result.get('ConversationID') or '').strip()
    originator_id = str(result.get('OriginatorConversationID') or '').strip()
    result_code = result.get('ResultCode')
    transaction_id = str(result.get('TransactionID') or '').strip() or None
    return conversation_id, originator_id, result_code, transaction_id


class B2CResultCallbackView(APIView):
    """POST /api/v1/withdrawals/b2c-result/ — Safaricom-called B2C ResultURL.

    The ASYNCHRONOUS result of a B2C dispatch (the 2.10a sync ack only said
    "queued"). Public, no auth, returns HTTP 200 on EVERY path (a non-200 makes
    Safaricom retry). Correlates by ConversationID, falling back to our
    OriginatorConversationID.

    On SUCCESS (ResultCode 0): finalize PAID via the shared idempotent helper —
    so if the sweep already finalized this row (CONFIRMED_PAID), this is a no-op
    (no double-finalize, no double wallet decrement).

    On FAILURE: this is the DRIVER of FAILED → FAILED_FINAL escalation. A failed
    payout with retry_count >= MAX_RETRIES escalates to FAILED_FINAL (terminal,
    non-blocking); otherwise FAILED (treasurer-retriable). block-on-FAILED's
    safety rests on FAILED never being permanent — this is what advances it.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        conversation_id, originator_id, result_code, transaction_id = (
            _extract_b2c_result(request.data)
        )

        if not conversation_id and not originator_id:
            logger.warning('B2C result with no correlation id: %s', request.data)
            return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                            status=status.HTTP_200_OK)

        with transaction.atomic():
            withdrawal = None
            if conversation_id:
                withdrawal = (
                    Withdrawal.objects.select_for_update()
                    .filter(b2c_conversation_id=conversation_id).first()
                )
            if withdrawal is None and originator_id:
                withdrawal = (
                    Withdrawal.objects.select_for_update()
                    .filter(originator_conversation_id=originator_id).first()
                )
            if withdrawal is None:
                logger.warning(
                    'B2C result for unknown ids conv=%s orig=%s', conversation_id, originator_id)
                return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                                status=status.HTTP_200_OK)

            # States in which a result callback must NOT finalize the row — see
            # RESULT_CALLBACK_IGNORED_STATUSES (distinct from the finalize guard
            # and the BLOCKING set; deliberately not merged).
            if withdrawal.status in RESULT_CALLBACK_IGNORED_STATUSES:
                # (Change 3) A SUCCESS callback landing on a row HELD for manual
                # reconciliation: M-Pesa now confirms the payment, but we do NOT
                # auto-pay it (a Super Admin resolves it). Record the receipt,
                # audit the confirmation, and alert Super Admins. Idempotent:
                # only the FIRST confirming callback (payout_reference still
                # unset) persists/audits/notifies; duplicate success callbacks
                # carry the same TransactionID and fall through to a plain 200.
                # Wallet and status are untouched here. PAID/FAILED_FINAL/REJECTED,
                # and a FAILURE callback on a reconciliation row, are unchanged
                # (plain short-circuit — failure-on-reconciliation is out of scope).
                if (
                    withdrawal.status == WithdrawalStatus.NEEDS_RECONCILIATION
                    and str(result_code).strip() == '0'
                    and transaction_id
                    and not withdrawal.payout_reference
                ):
                    # (3a) Persist the receipt — the only payout_reference write
                    # off the finalize-to-PAID path, kept inside the atomic (:607)
                    # under the existing select_for_update so it is lock-safe.
                    withdrawal.payout_reference = transaction_id
                    withdrawal.save(update_fields=['payout_reference', 'updated_at'])
                    # (3b) Audit the confirmation. transaction_id is an M-Pesa
                    # receipt (NOT PII) so stored plainly; phone masked per §12.10.
                    AuditLog.objects.create(
                        actor=None,
                        action='WITHDRAWAL_RECONCILIATION_PAYMENT_CONFIRMED',
                        entity_type='Withdrawal',
                        entity_id=withdrawal.id,
                        details={
                            'campaign_id': str(withdrawal.campaign_id),
                            'amount': str(withdrawal.amount),
                            'destination_phone': mask_phone(withdrawal.destination_phone),
                            'transaction_id': transaction_id,
                        },
                        ip_address=_client_ip(request) or None,
                    )
                    # (3c) Reuse the Super-Admin fan-out mechanism from
                    # services.mark_needs_reconciliation (services.py:179-186), but
                    # with the dedicated NotificationType.RECONCILIATION_PAYMENT_CONFIRMED
                    # (this is a confirmed SUCCESS, not a failure — see the enum). NOT
                    # the church-treasurer 'paid' notification — the row is not paid,
                    # it is held for a human.
                    from accounts.models import User, UserRole  # local import (file pattern)
                    recon_alert = (
                        f'M-Pesa confirmed payment on payout {withdrawal.id} '
                        f'(KES {withdrawal.amount}) that is awaiting reconciliation. '
                        f'Resolve it from the Withdrawals panel.'
                    )
                    for admin in User.objects.filter(role=UserRole.SUPER_ADMIN):
                        Notification.objects.create(
                            recipient=admin,
                            notification_type=NotificationType.RECONCILIATION_PAYMENT_CONFIRMED,
                            title='Payout payment confirmed — needs resolution',
                            message=recon_alert,
                            related_withdrawal=withdrawal,
                        )
                return Response({'ResultCode': 0, 'ResultDesc': 'Already terminal'},
                                status=status.HTTP_200_OK)

            if str(result_code).strip() == '0':
                # Success — idempotent against a sweep CONFIRMED_PAID finalize.
                finalize_withdrawal_paid(
                    withdrawal=withdrawal, actor=None, source='callback',
                    payout_reference=transaction_id,
                )
                _notify_church_treasurers(
                    church=withdrawal.campaign.church,
                    notification_type=NotificationType.DISBURSEMENT_PAID,
                    title='Payout completed',
                    message=f'Payout of KES {withdrawal.amount} was completed.',
                    related_campaign=withdrawal.campaign,
                    related_withdrawal=withdrawal,
                )
            else:
                # Failure — DRIVE the escalation. FAILED is never permanent.
                if withdrawal.retry_count >= MAX_RETRIES:
                    withdrawal.status = WithdrawalStatus.FAILED_FINAL
                    withdrawal.failure_reason = (
                        'Payout failed after the maximum number of attempts. Contact support.'
                    )
                    action = 'WITHDRAWAL_ESCALATED_FAILED_FINAL'
                else:
                    withdrawal.status = WithdrawalStatus.FAILED
                    withdrawal.failure_reason = (
                        'M-Pesa reported the payout failed. Retry from the Withdrawals panel.'
                    )
                    # Confirmed-by-M-Pesa failure — not a dispatch ambiguity. Clear
                    # any stale dispatch marker so the sweep doesn't re-pick it.
                    withdrawal.dispatch_outcome = None
                    action = 'WITHDRAWAL_RESULT_FAILED'
                withdrawal.save(update_fields=[
                    'status', 'failure_reason', 'dispatch_outcome', 'updated_at',
                ])
                AuditLog.objects.create(
                    actor=None,
                    action=action,
                    entity_type='Withdrawal',
                    entity_id=withdrawal.id,
                    details={
                        'campaign_id': str(withdrawal.campaign_id),
                        'amount': str(withdrawal.amount),
                        'destination_phone': mask_phone(withdrawal.destination_phone),
                        'result_code': str(result_code),
                        'retry_count': withdrawal.retry_count,
                    },
                    ip_address=_client_ip(request) or None,
                )

        return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                        status=status.HTTP_200_OK)

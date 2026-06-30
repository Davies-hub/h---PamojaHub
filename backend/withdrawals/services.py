"""Shared withdrawal money-mover helpers (treasurer + super admin views + sweep).

These are the SINGLE places the dangerous state transitions happen, so the
clean/ambiguous handling, the idempotent PAID finalize (with its exactly-once
wallet decrement), the retry escalation, and the NEEDS_RECONCILIATION freeze can
never drift between call sites (treasurer approve/retry, super force-retry, the
B2C result callback, and the stuck-PROCESSING sweep).
"""

import logging

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign
from common.masking import mask_phone
from notifications.models import Notification, NotificationType
from withdrawals.models import (
    MAX_RETRIES,
    Withdrawal,
    WithdrawalDispatchOutcome,
    WithdrawalStatus,
)


logger = logging.getLogger(__name__)


# Treasurer-facing copy is identical for CLEAN and AMBIGUOUS — the split is for
# the sweep (machine-readable dispatch_outcome), not for the treasurer.
DISPATCH_FAILURE_REASON = (
    'Could not dispatch payout to M-Pesa. Retry from the Withdrawals panel.'
)
MAX_RETRIES_REASON = 'Payout failed after the maximum number of attempts. Contact support.'


def record_dispatch_failure(*, withdrawal, campaign, actor, ip_address,
                            outcome, action, exc):
    """Resolve a withdrawal that failed B2C dispatch in the Phase-2 (unlocked)
    position. b2c_conversation_id is left None (no strand).

    Branches on the certainty class AND the retry budget:
      * AMBIGUOUS_FAILURE → ALWAYS status=FAILED (+ marker). The payout MAY be in
        flight, so the row stays BLOCKING and the sweep must status-query it; it
        is NEVER escalated to FAILED_FINAL (that is non-blocking and would unfreeze
        a campaign while money might be moving).
      * CLEAN_FAILURE → provably never queued, so it is safe to declare terminal:
        FAILED while retry_count < MAX_RETRIES (treasurer-retriable), else
        FAILED_FINAL. The FAILED_FINAL branch is what keeps block-on-FAILED safe
        on the no-callback clean path (a clean failure produces no result callback
        to drive escalation, so the escalation must happen here).
    """
    escalate = (
        outcome == WithdrawalDispatchOutcome.CLEAN_FAILURE
        and withdrawal.retry_count >= MAX_RETRIES
    )
    if escalate:
        withdrawal.status = WithdrawalStatus.FAILED_FINAL
        withdrawal.failure_reason = MAX_RETRIES_REASON
    else:
        withdrawal.status = WithdrawalStatus.FAILED
        withdrawal.failure_reason = DISPATCH_FAILURE_REASON
    withdrawal.dispatch_outcome = outcome
    withdrawal.save(update_fields=[
        'status', 'failure_reason', 'dispatch_outcome', 'updated_at',
    ])
    AuditLog.objects.create(
        actor=actor,
        action=action,
        entity_type='Withdrawal',
        entity_id=withdrawal.id,
        details={
            'campaign_id': str(campaign.id),
            'amount': str(withdrawal.amount),
            'destination_phone': mask_phone(withdrawal.destination_phone),
            'dispatch_outcome': outcome,
            'resulting_status': withdrawal.status,
            'reason': str(exc)[:255],
        },
        ip_address=ip_address or None,
    )
    logger.warning(
        'B2C dispatch failed (%s → %s) for withdrawal %s: %s',
        outcome, withdrawal.status, withdrawal.id, exc,
    )


def finalize_withdrawal_paid(*, withdrawal, actor, ip_address=None,
                             payout_reference=None, source):
    """IDEMPOTENTLY finalize a withdrawal as PAID, decrementing the campaign's
    wallet_balance by the withdrawal amount EXACTLY ONCE.

    Callable from the B2C result callback (real success), the sweep
    (CONFIRMED_PAID), and resolve-paid (human-confirmed) — whichever runs second
    sees status==PAID and no-ops, so the wallet is never double-decremented.

    CALLER CONTRACT: must already hold a SELECT FOR UPDATE lock on `withdrawal`
    (so the PAID guard is race-free). Returns True if it finalized, False if it
    was already PAID.
    """
    # Guard is == PAID ONLY — NOT RESULT_CALLBACK_IGNORED_STATUSES. resolve-paid
    # calls this on a row whose status is still NEEDS_RECONCILIATION; widening
    # this guard to that set would make resolve-paid a silent no-op and strand
    # the row in reconciliation forever. See test_reconciliation_finalize.
    if withdrawal.status == WithdrawalStatus.PAID:
        return False

    campaign = Campaign.objects.select_for_update().get(id=withdrawal.campaign_id)
    campaign.wallet_balance = campaign.wallet_balance - withdrawal.amount
    campaign.save(update_fields=['wallet_balance'])

    withdrawal.status = WithdrawalStatus.PAID
    withdrawal.failure_reason = None
    if payout_reference:
        withdrawal.payout_reference = payout_reference
    withdrawal.save(update_fields=[
        'status', 'failure_reason', 'payout_reference', 'updated_at',
    ])
    AuditLog.objects.create(
        actor=actor,
        action='WITHDRAWAL_PAID',
        entity_type='Withdrawal',
        entity_id=withdrawal.id,
        details={
            'campaign_id': str(campaign.id),
            'amount': str(withdrawal.amount),
            'destination_phone': mask_phone(withdrawal.destination_phone),
            'payout_reference': withdrawal.payout_reference,
            'source': source,  # 'callback' | 'sweep' | 'resolve_paid'
        },
        ip_address=ip_address or None,
    )
    logger.info('Withdrawal %s finalized PAID (source=%s)', withdrawal.id, source)
    return True


def mark_needs_reconciliation(*, withdrawal, actor=None, ip_address=None, reason):
    """Move a withdrawal to the NEEDS_RECONCILIATION terminal floor (BLOCKING) and
    fire a Super Admin alert carrying the OriginatorConversationID + amount +
    withdrawal id for M-Pesa back-office lookup.

    CALLER CONTRACT: must hold a SELECT FOR UPDATE lock on `withdrawal`.
    """
    withdrawal.status = WithdrawalStatus.NEEDS_RECONCILIATION
    withdrawal.failure_reason = (
        'Payout could not be confirmed with M-Pesa and needs manual reconciliation.'
    )
    withdrawal.save(update_fields=['status', 'failure_reason', 'updated_at'])

    AuditLog.objects.create(
        actor=actor,
        action='WITHDRAWAL_NEEDS_RECONCILIATION',
        entity_type='Withdrawal',
        entity_id=withdrawal.id,
        details={
            'campaign_id': str(withdrawal.campaign_id),
            'amount': str(withdrawal.amount),
            'destination_phone': mask_phone(withdrawal.destination_phone),
            # The M-Pesa lookup handle — unmasked here ON PURPOSE is NOT done;
            # the OriginatorConversationID is our own generated id (not PII).
            'originator_conversation_id': withdrawal.originator_conversation_id,
            'b2c_conversation_id': withdrawal.b2c_conversation_id,
            'reason': reason,
        },
        ip_address=ip_address or None,
    )

    # Super Admin alert. NotificationType has no NEEDS_RECONCILIATION value
    # (gap noted in memory); DISBURSEMENT_FAILED is the closest existing type and
    # the AuditLog above is the canonical record. The message carries the lookup
    # handle + amount + withdrawal id.
    alert = (
        f'Payout {withdrawal.id} (KES {withdrawal.amount}) could not be confirmed '
        f'with M-Pesa. Look it up by OriginatorConversationID '
        f'{withdrawal.originator_conversation_id} before resolving.'
    )
    for admin in User.objects.filter(role=UserRole.SUPER_ADMIN):
        Notification.objects.create(
            recipient=admin,
            notification_type=NotificationType.DISBURSEMENT_FAILED,
            title='Payout needs reconciliation',
            message=alert,
            related_withdrawal=withdrawal,
        )
    logger.error(
        'Withdrawal %s → NEEDS_RECONCILIATION (originator=%s): %s',
        withdrawal.id, withdrawal.originator_conversation_id, reason,
    )


# NOTE (2026-06-07, A2): redispatch_withdrawal was REMOVED here. Its only non-test
# caller was the B2C stuck-PROCESSING sweep's CONFIRMED_NOT_SENT branch, which is gone
# (the Transaction Status query that produced CONFIRMED_NOT_SENT cannot locate an
# unconfirmed row on the live wire — see §14.1 "DISPROVEN 2026-06-07"). Treasurer retry
# and super force-retry never used this helper; they call DarajaClient().b2c_payout()
# directly. The sweep is now escalate-only (run_stranded_withdrawal_sweep) and never
# re-dispatches.

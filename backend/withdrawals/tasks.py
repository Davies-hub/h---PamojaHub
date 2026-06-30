"""B2C stranded-withdrawal escalation sweep (Step 2.10c; A2 escalate-only rebuild 2026-06-07).

WHAT THIS DOES: find B2C payout rows stuck in limbo (a dispatch whose terminal
result callback never arrived) and escalate them to NEEDS_RECONCILIATION — the
money-in-limbo freeze that blocks the campaign and alerts a Super Admin to
reconcile against the M-Pesa statement by hand.

WHY ESCALATE-ONLY (no active Transaction Status query anymore): the prior design
queried Daraja's Transaction Status to auto-resolve a stuck row (CONFIRMED_PAID →
finalize, CONFIRMED_NOT_SENT → re-dispatch, else escalate). That query was proven
on the live sandbox wire to be UNABLE to locate an unconfirmed payout: the only
lookup key Daraja accepts is the M-Pesa receipt (TransactionID), which a row that
never reached PAID does not have (see §14.1 "DISPROVEN 2026-06-07"). Against real
Daraja the query therefore ALWAYS returned INCONCLUSIVE — i.e. the stuck row
already escalated to NEEDS_RECONCILIATION every time. Removing the query removes an
impossible-on-the-wire branch, NOT an outcome: this rewrite is BEHAVIOUR-PRESERVING
against live Daraja. The sweep no longer guesses, re-dispatches, or auto-finalizes —
a human resolves via resolve-paid / resolve-retry.

CANDIDATES (unchanged): rows stale past the staleness threshold that are either
  * status=PROCESSING (dispatched, no terminal callback; or crashed mid-dispatch), OR
  * status=FAILED with dispatch_outcome=AMBIGUOUS_FAILURE (2.10a ambiguous dispatch —
    may be queued, never confirmed).

TRIGGER: the `sweep_stranded_withdrawals` management command (A2), run manually or by
system cron. NOT wired to Celery beat. `sweep_stuck_withdrawals` is retained as a thin
@shared_task wrapper so a future beat schedule (A1) needs no rework; it is harmless
while never scheduled.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from celery import shared_task

from withdrawals.models import Withdrawal, WithdrawalDispatchOutcome, WithdrawalStatus
from withdrawals.services import mark_needs_reconciliation


logger = logging.getLogger(__name__)


def _is_still_candidate(withdrawal):
    """Re-check under the lock that the row is still a sweepable candidate (a
    concurrent callback may have resolved it to PAID/FAILED_FINAL/etc.)."""
    if withdrawal.status == WithdrawalStatus.PROCESSING:
        return True
    return (
        withdrawal.status == WithdrawalStatus.FAILED
        and withdrawal.dispatch_outcome == WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE
    )


def run_stranded_withdrawal_sweep(staleness_minutes=None):
    """Escalate every stale, still-stranded withdrawal to NEEDS_RECONCILIATION.

    Plain function (no Celery, no DarajaClient, no network) so the management command
    can call it synchronously in-process. For each stale candidate: transaction.atomic()
    + select_for_update + _is_still_candidate recheck (a concurrent callback may have
    resolved it between selection and lock) → mark_needs_reconciliation (which fires the
    Super-Admin alert + audit). Safe to re-run / overlap: a row already escalated is no
    longer PROCESSING/AMBIGUOUS, so the recheck drops it on a second run. Returns the
    count of rows escalated.
    """
    if staleness_minutes is None:
        staleness_minutes = settings.B2C_SWEEP_STALENESS_MINUTES

    threshold = timezone.now() - timedelta(minutes=staleness_minutes)
    candidates = list(
        Withdrawal.objects.filter(
            Q(status=WithdrawalStatus.PROCESSING)
            | Q(status=WithdrawalStatus.FAILED,
                dispatch_outcome=WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)
        ).filter(updated_at__lte=threshold)
    )

    escalated = 0
    for withdrawal in candidates:
        with transaction.atomic():
            fresh = Withdrawal.objects.select_for_update().get(id=withdrawal.id)
            if not _is_still_candidate(fresh):
                # Resolved concurrently (e.g. a real callback) — leave it.
                continue
            mark_needs_reconciliation(
                withdrawal=fresh, actor=None,
                reason='Stranded payout: no terminal M-Pesa callback received; '
                       'escalated by sweep for manual reconciliation.',
            )
            escalated += 1

    logger.info('Stranded-withdrawal sweep complete: examined=%s escalated=%s',
                len(candidates), escalated)
    return escalated


@shared_task(name='withdrawals.sweep_stuck_withdrawals')
def sweep_stuck_withdrawals(staleness_minutes=None):
    """Thin Celery wrapper around run_stranded_withdrawal_sweep — retained so a future
    beat schedule (A1) can wire it with no rework. NOT scheduled today (no beat_schedule,
    no PeriodicTask); the A2 management command is the live trigger. Harmless while
    never enqueued.
    """
    return run_stranded_withdrawal_sweep(staleness_minutes=staleness_minutes)

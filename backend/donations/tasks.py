"""Stranded-donation resolver (Step 3) — query Daraja STK Push Query for PENDING
donations whose terminal STK callback never arrived, and ESCALATE. MONEY-SAFE BY
DESIGN: it can mark a donation FAILED and flag a "looks paid" row for manual review,
but it NEVER credits a donation. There is deliberately no call to
finalize_donation_successful here.

WHY THIS CAN ACTIVELY QUERY (unlike the B2C withdrawal sweep, which is escalate-only):
STK Push Query CAN locate an unconfirmed donation by CheckoutRequestID — the key a
Strand-B donation already stores — and returns a synchronous, authoritative outcome
(§14.1, live-proven). B2C Transaction Status could not locate an unconfirmed payout at
all (§14.1 DISPROVEN), so that sweep only escalates. Here we map the query outcome:
  NOT_PAID      -> fail_donation (no money moved)
  PAID          -> DO NOT CREDIT. Flag for review + alert a Super Admin; leave PENDING.
  PENDING       -> still under processing (ResultCode 4999) — leave, re-poll next run.
  INCONCLUSIVE  -> could not determine — leave, re-poll next run.

WHY PAID IS NOT AUTO-CREDITED: the STK Push Query "paid" response has not been proven
on our sandbox wire to carry the confirmed amount + M-Pesa receipt (the sandbox cannot
drive an STK to PAID — §14.1), and a credit must move NET by the confirmed GROSS. So a
PAID verdict here is a STRONG SIGNAL, not an authority to credit: a human confirms
against the M-Pesa statement and credits via the normal callback/manual path. This
keeps the resolver money-safe — its worst case is a FAILED or a flag, never a wrong credit.

CANDIDATES: status=PENDING AND checkout_request_id IS NOT NULL (Strand A — a 502-initiate
row with NO checkout id — is un-queryable, so it is skipped) AND created_at older than the
staleness threshold (Donation has no updated_at; a stranded PENDING never advances a
timestamp, so created_at is the only age signal).

THROTTLE: STK Push Query is spike-arrested at ~5/min (§14.1). We query at most ~4/min by
sleeping query_interval_seconds (default 15s) between rows. The interval is injectable so
tests run at 0.

LOCK DISCIPLINE (Phase-1/Phase-2): the network query runs OUTSIDE any DB lock; the lock is
held ONLY around the re-check + the DB action. A real callback may resolve the row between
selection and lock, so under the lock we re-check `fresh.status == PENDING` and skip if not.

TRIGGER: the `sweep_stranded_donations` management command, run manually or by system cron
(NOT Celery beat), mirroring the A2 withdrawal command.
"""

import logging
import time
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from accounts.models import User, UserRole
from audit.models import AuditLog
from common.masking import mask_phone
from donations.models import Donation, DonationStatus
from donations.services import fail_donation
from integrations.daraja import DarajaClient, STKQueryOutcome
from notifications.models import Notification, NotificationType


logger = logging.getLogger(__name__)


def _flag_donation_needs_review(*, donation):
    """PAID verdict from STK Push Query: record the flag audit + alert every Super Admin.
    Does NOT change donation status (it stays PENDING) and moves NO money. Caller holds
    the donation lock."""
    AuditLog.objects.create(
        actor=None,
        actor_phone=mask_phone(donation.phone_number),
        action='DONATION_FLAGGED_NEEDS_REVIEW',
        entity_type='Donation',
        entity_id=donation.id,
        details={
            'campaign_id': str(donation.campaign_id),
            'checkout_request_id': donation.checkout_request_id,
            'requested_amount': str(donation.amount),
            'source': 'resolver',
            'note': ('STK Push Query reports PAID; confirm against M-Pesa statement '
                     'and credit manually'),
        },
        ip_address=None,
    )
    alert = (
        f'Donation {donation.id} (KES {donation.amount}) looks PAID on M-Pesa but has '
        f'no confirmation callback. Confirm by CheckoutRequestID '
        f'{donation.checkout_request_id} against the M-Pesa statement, then credit manually.'
    )
    for admin in User.objects.filter(role=UserRole.SUPER_ADMIN):
        Notification.objects.create(
            recipient=admin,
            notification_type=NotificationType.DONATION_NEEDS_REVIEW,
            title='Donation needs review',
            message=alert,
            related_campaign=donation.campaign,
        )
    logger.warning(
        'Donation %s flagged NEEDS_REVIEW (STK Query=PAID, not auto-credited); '
        'checkout_request_id=%s', donation.id, donation.checkout_request_id,
    )


def run_stranded_donation_sweep(staleness_minutes=None, query_interval_seconds=15):
    """Query-and-escalate every stale, still-PENDING, queryable donation. NEVER credits.

    For each candidate: DarajaClient().stk_push_query(checkout_request_id) is called
    OUTSIDE the lock (network), then under transaction.atomic() + select_for_update we
    re-check the row is still PENDING and act on the outcome. Returns count dict
    {examined, failed, flagged, pending, inconclusive}. Safe to re-run / overlap: a row
    failed/credited concurrently is no longer PENDING, so the re-check drops it.
    """
    if staleness_minutes is None:
        staleness_minutes = settings.DONATION_SWEEP_STALENESS_MINUTES

    threshold = timezone.now() - timedelta(minutes=staleness_minutes)
    candidates = list(
        Donation.objects.filter(
            status=DonationStatus.PENDING,
            checkout_request_id__isnull=False,   # Strand A (no checkout id) is un-queryable.
            created_at__lte=threshold,
        )
    )

    counts = {'examined': len(candidates), 'failed': 0, 'flagged': 0,
              'pending': 0, 'inconclusive': 0}
    client = DarajaClient()

    for index, donation in enumerate(candidates):
        # Throttle for the ~5/min STK Query spike-arrest — but not before the first row,
        # and not after the last (the sleep only separates back-to-back queries).
        if index > 0 and query_interval_seconds:
            time.sleep(query_interval_seconds)

        # Network query OUTSIDE the lock (no lock held across HTTP).
        outcome = client.stk_push_query(donation.checkout_request_id)

        with transaction.atomic():
            fresh = Donation.objects.select_for_update().get(id=donation.id)
            if fresh.status != DonationStatus.PENDING:
                # A real callback resolved it between selection and lock — leave it.
                logger.info('Donation %s no longer PENDING under lock (%s); skipping.',
                            fresh.id, fresh.status)
                continue

            if outcome == STKQueryOutcome.NOT_PAID:
                # stk_push_query returns only the outcome, not the raw ResultCode, so the
                # audit records a query-sourced marker rather than a specific M-Pesa code.
                fail_donation(donation=fresh, result_code='query:not_paid',
                              source='resolver')
                counts['failed'] += 1
            elif outcome == STKQueryOutcome.PAID:
                # MONEY-SAFE: do NOT credit. Flag for manual review + alert; stays PENDING.
                _flag_donation_needs_review(donation=fresh)
                counts['flagged'] += 1
            elif outcome == STKQueryOutcome.PENDING:
                counts['pending'] += 1
            else:  # INCONCLUSIVE
                counts['inconclusive'] += 1

    logger.info('Stranded-donation sweep complete: %s', counts)
    return counts

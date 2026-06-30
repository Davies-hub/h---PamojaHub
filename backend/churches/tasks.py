"""Subscription lifecycle jobs (Slice 2): renewal reminders + grace-period lapse.

Plain functions (no Celery, no network) so the `process_subscriptions` management
command can call them synchronously in-process — mirrors withdrawals/tasks.py.

Both jobs operate ONLY on paid churches with a non-null expiry (tier != FREE AND
subscription_expires_at IS NOT NULL). FREE churches and admin-granted permanent-tier
(null-expiry) churches are never touched. Each church is processed under
transaction.atomic() + select_for_update() with a re-check under the lock, so a
concurrent set-tier / lapse cannot race the decision.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from accounts.models import User, UserRole
from churches.models import (
    Church,
    REMINDER_STAGE_1D,
    REMINDER_STAGE_7D,
    REMINDER_STAGE_GRACE,
    REMINDER_STAGE_NONE,
    SubscriptionTier,
)
from churches.services import set_church_tier
from notifications.models import Notification, NotificationType


logger = logging.getLogger(__name__)

REMINDER_WINDOW_7D = timedelta(days=7)
REMINDER_WINDOW_1D = timedelta(days=1)


def _notify_church_treasurers(church, *, notification_type, title, message):
    """Fan out one Notification per CHURCH_TREASURER user of the church (clone of
    the donations/services.py church fan-out). Returns the recipient count."""
    count = 0
    for treasurer in User.objects.filter(
        church=church, role=UserRole.CHURCH_TREASURER,
    ):
        Notification.objects.create(
            recipient=treasurer,
            notification_type=notification_type,
            title=title,
            message=message,
        )
        count += 1
    return count


def run_subscription_reminders(now=None, grace_days=None):
    """Send the 7-day, 1-day, and final-grace-day renewal reminders, once each per period.

    Candidate = paid church with a non-null expiry. For each (locked) compute
    delta = expires_at - now and pick a milestone, else skip:
      * delta > 7 days                         → skip (too early)
      * 1 day  < delta <= 7 days               → 7-day stage
      * 0      < delta <= 1 day                → 1-day stage
      * -(grace_days-1) < delta <= 0           → skip (mid-grace, still silent)
      * -grace_days < delta <= -(grace_days-1) → GRACE stage (last full grace day)
      * delta <= -grace_days                   → skip (past grace — the lapse job owns it)
    grace_days is read from settings.SUBSCRIPTION_GRACE_DAYS (same source the lapse
    job uses) so the grace window and the lapse flip never desync. Dedup: if
    reminder_period == expires_at AND reminder_stage >= target, skip — the GRACE
    stage (3) extends the monotonic high-water above 1D (2). Else fan out and
    advance (reminder_period, reminder_stage) in the SAME transaction. Returns the
    count of churches notified.
    """
    now = now or timezone.now()
    grace_days = grace_days if grace_days is not None else settings.SUBSCRIPTION_GRACE_DAYS
    # Grace-reminder fire window: the last FULL grace day, i.e. the lapse (which the
    # lapse job fires at delta < -grace_days) is <= 1 day away. Strictly before the
    # flip + the marker reset.
    grace_window = timedelta(days=grace_days)               # -grace_window = lapse edge
    last_grace_day = timedelta(days=grace_days - 1)         # -last_grace_day = window's near edge
    # Cancelled churches (auto-renew opted out) get NO renewal reminders — they have
    # chosen to lapse. They still run out their paid period + grace and lapse normally
    # (run_subscription_lapses does NOT filter on this flag).
    candidates = list(
        Church.objects.filter(subscription_expires_at__isnull=False)
        .exclude(subscription_tier=SubscriptionTier.FREE)
        .exclude(subscription_cancel_requested=True)
    )

    notified = 0
    for church in candidates:
        with transaction.atomic():
            locked = Church.objects.select_for_update().get(id=church.id)
            expires_at = locked.subscription_expires_at
            # Re-check under the lock (a concurrent lapse may have NULLed expiry / flipped
            # FREE; a concurrent cancel may have opted the church out after selection).
            if (
                expires_at is None
                or locked.subscription_tier == SubscriptionTier.FREE
                or locked.subscription_cancel_requested
            ):
                continue
            delta = expires_at - now
            # Pre-expiry 7d/1d path (unchanged), then the in-grace last-day path.
            # The early-skip is NARROWED, not removed: it still drops delta > 7d
            # (too early), -(grace_days-1) < delta <= 0 (mid-grace, silent), and
            # delta <= -grace_days (past lapse — owned by run_subscription_lapses).
            if timedelta(0) < delta <= REMINDER_WINDOW_7D:
                target = REMINDER_STAGE_1D if delta <= REMINDER_WINDOW_1D else REMINDER_STAGE_7D
            elif -grace_window < delta <= -last_grace_day:
                target = REMINDER_STAGE_GRACE
            else:
                continue
            if (
                locked.subscription_reminder_period == expires_at
                and locked.subscription_reminder_stage >= target
            ):
                continue

            # Milestone-framed copy: each reminder fires across a window, so state the
            # window + the exact date, never a hardcoded day count that would frequently
            # be wrong. The GRACE reminder additionally names the lapse date
            # (expires_at + grace_days) — the day the church reverts to Free.
            if target == REMINDER_STAGE_GRACE:
                lapse_date = (expires_at + grace_window).date().isoformat()
                title = 'Subscription ends tomorrow — last day to renew'
                message = (
                    f"Your {locked.get_subscription_tier_display()} plan has expired and is in "
                    f"its final grace day. It reverts to the Free plan tomorrow, on {lapse_date}, "
                    f"unless you renew. Renew now to keep your paid features (including unlimited "
                    f"active campaigns)."
                )
            else:
                if target == REMINDER_STAGE_1D:
                    title = 'Subscription expires tomorrow'
                    window_phrase = 'within 24 hours'
                else:
                    title = 'Subscription expiring soon'
                    window_phrase = 'within a week'
                message = (
                    f"Your {locked.get_subscription_tier_display()} subscription expires "
                    f"{window_phrase}, on {expires_at.date().isoformat()}. Renew to keep your "
                    f"paid features and avoid reverting to the Free plan."
                )
            _notify_church_treasurers(
                locked, notification_type=NotificationType.SUBSCRIPTION_REMINDER,
                title=title, message=message,
            )
            locked.subscription_reminder_period = expires_at
            locked.subscription_reminder_stage = target
            locked.save(update_fields=[
                'subscription_reminder_period', 'subscription_reminder_stage',
            ])
            notified += 1

    logger.info('Subscription reminders: examined=%s churches_notified=%s',
                len(candidates), notified)
    return notified


def run_subscription_lapses(now=None, grace_days=None):
    """Flip paid churches past their grace window to FREE.

    Candidate = paid church with expires_at < now - grace_days. For each (locked):
    re-check still-paid + still-past-grace, then set_church_tier(→FREE,
    action=CHURCH_TIER_LAPSED_TO_FREE) via the shared spine, NULL the expiry, reset
    the reminder marker, and emit one SUBSCRIPTION_LAPSED Notification per treasurer
    — all in one transaction. Returns the count of churches lapsed.
    """
    now = now or timezone.now()
    grace_days = grace_days if grace_days is not None else settings.SUBSCRIPTION_GRACE_DAYS
    threshold = now - timedelta(days=grace_days)
    candidates = list(
        Church.objects.filter(subscription_expires_at__isnull=False)
        .exclude(subscription_tier=SubscriptionTier.FREE)
        .filter(subscription_expires_at__lt=threshold)
    )

    lapsed = 0
    for church in candidates:
        with transaction.atomic():
            locked = Church.objects.select_for_update().get(id=church.id)
            # Re-check under the lock.
            if (
                locked.subscription_tier == SubscriptionTier.FREE
                or locked.subscription_expires_at is None
                or locked.subscription_expires_at >= threshold
            ):
                continue
            set_church_tier(
                locked, SubscriptionTier.FREE,
                actor=None, action='CHURCH_TIER_LAPSED_TO_FREE',
                details_extra={'reason': 'grace_period_expired'},
            )
            locked.subscription_expires_at = None
            locked.subscription_reminder_period = None
            locked.subscription_reminder_stage = REMINDER_STAGE_NONE
            locked.save(update_fields=[
                'subscription_expires_at',
                'subscription_reminder_period',
                'subscription_reminder_stage',
            ])
            _notify_church_treasurers(
                locked, notification_type=NotificationType.SUBSCRIPTION_LAPSED,
                title='Subscription lapsed — reverted to Free plan',
                message=(
                    'Your subscription expired and the grace period has passed, so your '
                    'church has been moved to the Free plan. Some paid features (including '
                    'unlimited active campaigns) are now limited. Renew to restore them.'
                ),
            )
            lapsed += 1

    logger.info('Subscription lapses: examined=%s churches_lapsed=%s',
                len(candidates), lapsed)
    return lapsed

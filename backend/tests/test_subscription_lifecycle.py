"""Subscription lifecycle — lapse flip + 7-day/1-day renewal reminders (Slice 2).

Drives the two job functions directly with an explicit `now=` (and `grace_days=`
where relevant) so no real clock is involved. Clones the church/treasurer
fixtures from tests/test_church_scoped_endpoints.py.

Locked rules under test:
  * grace = 7 days after subscription_expires_at; lapse flips tier→FREE and NULLs
    subscription_expires_at; lapse audit action = CHURCH_TIER_LAPSED_TO_FREE.
  * reminders fire at 7-day and 1-day before expiry, once each per period.
  * both jobs operate ONLY on churches with tier != FREE AND expires_at IS NOT NULL.
  * grace window is silent (no reminders).
"""

from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone

from audit.models import AuditLog
from churches.models import (
    Church,
    REMINDER_STAGE_1D,
    REMINDER_STAGE_7D,
    REMINDER_STAGE_GRACE,
    REMINDER_STAGE_NONE,
    SubscriptionTier,
)
from churches.tasks import run_subscription_lapses, run_subscription_reminders
from notifications.models import Notification, NotificationType
from tests.test_church_scoped_endpoints import _make_church, _make_treasurer


def _make_paid_church(*, tier, expires_at, email):
    ch = _make_church(name='Sub Church', email=email)
    ch.subscription_tier = tier
    ch.subscription_expires_at = expires_at
    ch.save(update_fields=['subscription_tier', 'subscription_expires_at'])
    treas = _make_treasurer(ch, f'sub-treas-{email}')
    return ch, treas


class SubscriptionLapseTest(TestCase):
    def setUp(self):
        self.now = timezone.now()

    def test_past_grace_lapses_to_free(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH,
            expires_at=self.now - timedelta(days=8),
            email='lapse-past@example.org',
        )
        run_subscription_lapses(now=self.now, grace_days=7)

        ch.refresh_from_db()
        self.assertEqual(ch.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(ch.subscription_expires_at)
        self.assertEqual(
            Notification.objects.filter(
                recipient=treas, notification_type=NotificationType.SUBSCRIPTION_LAPSED,
            ).count(),
            1,
        )
        self.assertEqual(
            AuditLog.objects.filter(
                action='CHURCH_TIER_LAPSED_TO_FREE', entity_id=ch.id,
            ).count(),
            1,
        )

    def test_within_grace_does_not_lapse(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH,
            expires_at=self.now - timedelta(days=3),
            email='lapse-within@example.org',
        )
        original_expiry = ch.subscription_expires_at
        run_subscription_lapses(now=self.now, grace_days=7)

        ch.refresh_from_db()
        self.assertEqual(ch.subscription_tier, SubscriptionTier.GROWTH)
        self.assertEqual(ch.subscription_expires_at, original_expiry)
        self.assertFalse(
            AuditLog.objects.filter(action='CHURCH_TIER_LAPSED_TO_FREE', entity_id=ch.id).exists()
        )
        self.assertFalse(
            Notification.objects.filter(
                recipient=treas, notification_type=NotificationType.SUBSCRIPTION_LAPSED,
            ).exists()
        )

    def test_free_church_ignored_by_lapse(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.FREE,
            expires_at=self.now - timedelta(days=30),
            email='lapse-free@example.org',
        )
        run_subscription_lapses(now=self.now, grace_days=7)

        ch.refresh_from_db()
        self.assertEqual(ch.subscription_tier, SubscriptionTier.FREE)
        self.assertFalse(
            AuditLog.objects.filter(action='CHURCH_TIER_LAPSED_TO_FREE', entity_id=ch.id).exists()
        )
        self.assertFalse(Notification.objects.filter(recipient=treas).exists())

    def test_null_expiry_paid_church_never_lapses(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=None,
            email='lapse-null@example.org',
        )
        run_subscription_lapses(now=self.now, grace_days=7)

        ch.refresh_from_db()
        self.assertEqual(ch.subscription_tier, SubscriptionTier.GROWTH)
        self.assertIsNone(ch.subscription_expires_at)
        self.assertFalse(
            AuditLog.objects.filter(action='CHURCH_TIER_LAPSED_TO_FREE', entity_id=ch.id).exists()
        )


class SubscriptionReminderTest(TestCase):
    def setUp(self):
        # Fixed expiry T; tests move `now` relative to it.
        self.T = timezone.now() + timedelta(days=30)

    def _reminder_count(self, treas):
        return Notification.objects.filter(
            recipient=treas, notification_type=NotificationType.SUBSCRIPTION_REMINDER,
        ).count()

    def test_7day_reminder_fires_once(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='rem-7d@example.org',
        )
        run_subscription_reminders(now=self.T - timedelta(days=6))

        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 1)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_7D)
        self.assertEqual(ch.subscription_reminder_period, self.T)

        # Re-run at the same now → dedup, no new notification.
        run_subscription_reminders(now=self.T - timedelta(days=6))
        self.assertEqual(self._reminder_count(treas), 1)

    def test_1day_reminder_after_7day_same_period(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='rem-1d@example.org',
        )
        run_subscription_reminders(now=self.T - timedelta(days=6))   # 7-day milestone
        self.assertEqual(self._reminder_count(treas), 1)

        run_subscription_reminders(now=self.T - timedelta(days=0.5))  # 1-day milestone
        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 2)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_1D)

        # Re-run at the same now → dedup.
        run_subscription_reminders(now=self.T - timedelta(days=0.5))
        self.assertEqual(self._reminder_count(treas), 2)

    def test_no_reminder_outside_window(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='rem-outside@example.org',
        )
        run_subscription_reminders(now=self.T - timedelta(days=10))

        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 0)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_NONE)

    def test_free_and_null_expiry_get_no_reminders(self):
        free_ch, free_treas = _make_paid_church(
            tier=SubscriptionTier.FREE, expires_at=self.T,
            email='rem-free@example.org',
        )
        null_ch, null_treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=None,
            email='rem-null@example.org',
        )
        run_subscription_reminders(now=self.T - timedelta(days=6))

        self.assertEqual(self._reminder_count(free_treas), 0)
        self.assertEqual(self._reminder_count(null_treas), 0)


@override_settings(SUBSCRIPTION_GRACE_DAYS=7)
class SubscriptionGraceReminderTest(TestCase):
    """The grace-period (last-day) reminder — REMINDER_STAGE_GRACE.

    Fires exactly once, on the last full grace day (lapse <= 1 day away), strictly
    after the 7d/1d milestones and strictly BEFORE the lapse flip. grace_days is
    pinned to 7 via override_settings so an env override can't shift the window
    under the test (the job reads settings.SUBSCRIPTION_GRACE_DAYS — same source as
    the lapse job, so the two never desync).
    """

    def setUp(self):
        # Fixed expiry T at "now"; tests move `now` into the grace window (T + ~6.5d).
        self.T = timezone.now()

    def _reminder_count(self, treas):
        return Notification.objects.filter(
            recipient=treas, notification_type=NotificationType.SUBSCRIPTION_REMINDER,
        ).count()

    def test_grace_reminder_fires_last_grace_day(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='grace-fires@example.org',
        )
        # now = T + 6.5d : delta = -6.5d -> inside (-7, -6] -> last grace day, lapse ~0.5d away.
        run_subscription_reminders(now=self.T + timedelta(days=6.5))

        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 1)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_GRACE)
        self.assertEqual(ch.subscription_reminder_period, self.T)
        # Church is NOT lapsed — the grace reminder precedes the flip.
        self.assertEqual(ch.subscription_tier, SubscriptionTier.GROWTH)
        self.assertIsNotNone(ch.subscription_expires_at)
        # Grace-specific copy carries the lapse date (expires_at + grace_days), which
        # the 7d/1d copy never does (those use expires_at itself).
        note = Notification.objects.filter(
            recipient=treas, notification_type=NotificationType.SUBSCRIPTION_REMINDER,
        ).latest('created_at')
        expected_lapse_date = (self.T + timedelta(days=7)).date().isoformat()
        self.assertIn(expected_lapse_date, note.message)

    def test_grace_reminder_dedup(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='grace-dedup@example.org',
        )
        run_subscription_reminders(now=self.T + timedelta(days=6.5))
        self.assertEqual(self._reminder_count(treas), 1)

        # Re-run later but still on the last grace day -> high-water holds, no new note.
        run_subscription_reminders(now=self.T + timedelta(days=6.6))
        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 1)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_GRACE)

    def test_no_grace_reminder_early_in_grace(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='grace-early@example.org',
        )
        # now = T + 2d : delta = -2d -> mid-grace, lapse ~5d away -> silent.
        run_subscription_reminders(now=self.T + timedelta(days=2))

        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 0)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_NONE)

    def test_grace_reminder_after_1day_same_period(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='grace-sequence@example.org',
        )
        # 7-day milestone (delta +6d).
        run_subscription_reminders(now=self.T - timedelta(days=6))
        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 1)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_7D)

        # 1-day milestone (delta +0.5d).
        run_subscription_reminders(now=self.T - timedelta(days=0.5))
        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 2)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_1D)

        # Grace milestone (delta -6.5d, last grace day).
        run_subscription_reminders(now=self.T + timedelta(days=6.5))
        ch.refresh_from_db()
        self.assertEqual(self._reminder_count(treas), 3)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_GRACE)
        self.assertEqual(ch.subscription_reminder_period, self.T)

    def test_grace_reminder_then_lapse_resets(self):
        ch, treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=self.T,
            email='grace-then-lapse@example.org',
        )
        run_subscription_reminders(now=self.T + timedelta(days=6.5))
        ch.refresh_from_db()
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_GRACE)

        # A day later the lapse owns it (delta -8d < -7d -> past grace).
        run_subscription_lapses(now=self.T + timedelta(days=8), grace_days=7)
        ch.refresh_from_db()
        self.assertEqual(ch.subscription_tier, SubscriptionTier.FREE)
        self.assertIsNone(ch.subscription_expires_at)
        self.assertEqual(ch.subscription_reminder_stage, REMINDER_STAGE_NONE)
        self.assertIsNone(ch.subscription_reminder_period)

    def test_free_and_null_expiry_still_no_grace_reminder(self):
        free_ch, free_treas = _make_paid_church(
            tier=SubscriptionTier.FREE, expires_at=self.T,
            email='grace-reg-free@example.org',
        )
        null_ch, null_treas = _make_paid_church(
            tier=SubscriptionTier.GROWTH, expires_at=None,
            email='grace-reg-null@example.org',
        )
        run_subscription_reminders(now=self.T + timedelta(days=6.5))

        self.assertEqual(self._reminder_count(free_treas), 0)
        self.assertEqual(self._reminder_count(null_treas), 0)

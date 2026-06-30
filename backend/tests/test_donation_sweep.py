"""Step 3 — stranded-donation resolver (query Daraja STK Push Query + escalate).

MONEY-SAFETY is the headline invariant: the resolver may mark a donation FAILED or flag
a "looks paid" row for manual review, but it NEVER credits a donation. The PAID test is
the seen-failing-first guard for that invariant — PAID must leave the campaign balances
UNCHANGED.

stk_push_query is the only Daraja seam the resolver touches; every test patches that
method on DarajaClient to return a canned STKQueryOutcome (so zero real HTTP), and calls
run_stranded_donation_sweep with query_interval_seconds=0 to skip the spike-arrest throttle.
"""

from datetime import timedelta
from decimal import Decimal
from io import StringIO
from unittest.mock import patch

from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from donations.models import Donation, DonationStatus
from donations.tasks import run_stranded_donation_sweep
from integrations.daraja import DarajaClient, STKQueryOutcome
from notifications.models import Notification, NotificationType


REVIEW_AUDIT = 'DONATION_FLAGGED_NEEDS_REVIEW'
FAILED_AUDIT = 'DONATION_FAILED'


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_church():
    return Church.objects.create(
        name='Church', official_email='c@example.org', phone='254700000001',
        address='addr', county='Nairobi', denomination='PCEA',
        status=ChurchStatus.ACTIVE,
    )


def _make_treasurer(church):
    return User.objects.create_user(
        email='t@example.org', password='unused', first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _make_super_admin():
    return User.objects.create_user(
        email='admin@pamoja.example', password='unused', first_name='S', last_name='A',
        role=UserRole.SUPER_ADMIN, church=None,
    )


def _make_campaign(church, treasurer):
    return Campaign.objects.create(
        slug='c1', church=church, title='Campaign', description='desc',
        goal_amount=Decimal('1000000'), raised_amount=Decimal('5000'),
        wallet_balance=Decimal('5000'), banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING, treasurer_phone='254712345678',
        treasurer_name='Treas Urer', created_by=treasurer,
        status=CampaignStatus.ACTIVE,
    )


def _patch_query(outcome=None, side_effect=None):
    """Patch DarajaClient.stk_push_query to return a canned outcome (or run side_effect)."""
    if side_effect is not None:
        return patch.object(DarajaClient, 'stk_push_query', side_effect=side_effect)
    return patch.object(DarajaClient, 'stk_push_query', return_value=outcome)


class StrandedDonationSweepTests(TestCase):
    def setUp(self):
        cache.clear()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        self.super_admin = _make_super_admin()
        self.campaign = _make_campaign(self.church, self.treasurer)

    def _donation(self, *, checkout='ws_CO_1', amount=Decimal('100'),
                  status=DonationStatus.PENDING, stale_minutes=60):
        d = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678',
            amount=amount, status=status, checkout_request_id=checkout,
        )
        if stale_minutes is not None:
            # created_at is auto_now_add; .update() bypasses it to backdate the row.
            Donation.objects.filter(id=d.id).update(
                created_at=timezone.now() - timedelta(minutes=stale_minutes))
        d.refresh_from_db()
        return d

    def _balances(self):
        c = Campaign.objects.get(id=self.campaign.id)
        return c.raised_amount, c.wallet_balance

    # ── NOT_PAID → FAILED, no credit ─────────────────────────────────────────
    def test_not_paid_fails_donation_without_credit(self):
        d = self._donation()
        before = self._balances()
        with _patch_query(STKQueryOutcome.NOT_PAID):
            counts = run_stranded_donation_sweep(staleness_minutes=0,
                                                 query_interval_seconds=0)
        d.refresh_from_db()
        self.assertEqual(d.status, DonationStatus.FAILED)
        self.assertEqual(self._balances(), before, 'NOT_PAID must move NO money')
        self.assertEqual(counts['failed'], 1)
        self.assertTrue(AuditLog.objects.filter(
            action=FAILED_AUDIT, entity_id=d.id).exists())

    # ── PAID → flagged, NOT credited, stays PENDING (the money-safety guard) ──
    def test_paid_is_flagged_not_credited(self):
        d = self._donation()
        before = self._balances()
        with _patch_query(STKQueryOutcome.PAID):
            counts = run_stranded_donation_sweep(staleness_minutes=0,
                                                 query_interval_seconds=0)
        d.refresh_from_db()
        # NOT credited: status untouched and balances UNCHANGED.
        self.assertEqual(d.status, DonationStatus.PENDING,
                         'PAID must NOT change donation status (no credit)')
        self.assertEqual(self._balances(), before,
                         'PAID must NOT move campaign balances (no credit)')
        self.assertEqual(counts['flagged'], 1)
        # Exactly one flag audit + one Super-Admin DONATION_NEEDS_REVIEW notification.
        self.assertEqual(AuditLog.objects.filter(
            action=REVIEW_AUDIT, entity_id=d.id).count(), 1)
        notif = Notification.objects.filter(
            recipient=self.super_admin,
            notification_type=NotificationType.DONATION_NEEDS_REVIEW).first()
        self.assertIsNotNone(notif)
        self.assertIn(str(d.id), notif.message)
        self.assertIn(d.checkout_request_id, notif.message)
        self.assertEqual(notif.related_campaign_id, self.campaign.id)

    # ── PENDING (4999) → untouched ───────────────────────────────────────────
    def test_pending_left_untouched(self):
        d = self._donation()
        before = self._balances()
        with _patch_query(STKQueryOutcome.PENDING):
            counts = run_stranded_donation_sweep(staleness_minutes=0,
                                                 query_interval_seconds=0)
        d.refresh_from_db()
        self.assertEqual(d.status, DonationStatus.PENDING)
        self.assertEqual(self._balances(), before)
        self.assertEqual(counts['pending'], 1)
        self.assertFalse(AuditLog.objects.filter(entity_id=d.id).exists())
        self.assertFalse(Notification.objects.filter(recipient=self.super_admin).exists())

    # ── INCONCLUSIVE → untouched ─────────────────────────────────────────────
    def test_inconclusive_left_untouched(self):
        d = self._donation()
        before = self._balances()
        with _patch_query(STKQueryOutcome.INCONCLUSIVE):
            counts = run_stranded_donation_sweep(staleness_minutes=0,
                                                 query_interval_seconds=0)
        d.refresh_from_db()
        self.assertEqual(d.status, DonationStatus.PENDING)
        self.assertEqual(self._balances(), before)
        self.assertEqual(counts['inconclusive'], 1)
        self.assertFalse(AuditLog.objects.filter(entity_id=d.id).exists())

    # ── Strand A (no checkout_request_id) → never selected, never queried ────
    def test_null_checkout_id_is_skipped(self):
        d = self._donation(checkout=None)
        with _patch_query(STKQueryOutcome.PAID) as mock_query:
            counts = run_stranded_donation_sweep(staleness_minutes=0,
                                                 query_interval_seconds=0)
        d.refresh_from_db()
        self.assertEqual(d.status, DonationStatus.PENDING)
        self.assertEqual(counts['examined'], 0, 'Strand A row must not be a candidate')
        self.assertFalse(mock_query.called, 'un-queryable row must never be queried')

    # ── Fresh row (within staleness window) → not selected ───────────────────
    def test_fresh_row_not_selected(self):
        d = self._donation(stale_minutes=None)  # created_at = now
        with _patch_query(STKQueryOutcome.NOT_PAID) as mock_query:
            counts = run_stranded_donation_sweep(query_interval_seconds=0)  # default 30m
        d.refresh_from_db()
        self.assertEqual(d.status, DonationStatus.PENDING)
        self.assertEqual(counts['examined'], 0)
        self.assertFalse(mock_query.called)

    # ── Concurrent callback: row flips to SUCCESSFUL before the lock ─────────
    def test_concurrent_callback_resolution_is_skipped(self):
        d = self._donation()

        def _flip_then_paid(checkout_id):
            # Simulate a real callback resolving the row in the window between candidate
            # selection and the resolver acquiring the row lock.
            Donation.objects.filter(id=d.id).update(status=DonationStatus.SUCCESSFUL)
            return STKQueryOutcome.PAID

        with _patch_query(side_effect=_flip_then_paid):
            counts = run_stranded_donation_sweep(staleness_minutes=0,
                                                 query_interval_seconds=0)
        d.refresh_from_db()
        # The under-lock re-check (fresh.status != PENDING) drops it: no flag, no failure.
        self.assertEqual(d.status, DonationStatus.SUCCESSFUL)
        self.assertEqual(counts['flagged'], 0)
        self.assertEqual(counts['failed'], 0)
        self.assertFalse(AuditLog.objects.filter(
            action=REVIEW_AUDIT, entity_id=d.id).exists())


# ═════════════════════════════════════════════════════════════════════════════
# Management command (the Step 3 trigger) — fails/flags the right rows, reports
# ═════════════════════════════════════════════════════════════════════════════


class SweepStrandedDonationsCommandTests(TestCase):
    def setUp(self):
        cache.clear()
        self.church = _make_church()
        self.treasurer = _make_treasurer(self.church)
        self.super_admin = _make_super_admin()
        self.campaign = _make_campaign(self.church, self.treasurer)

    def _stale_donation(self, checkout, outcome_tag):
        d = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678',
            amount=Decimal('100'), status=DonationStatus.PENDING,
            checkout_request_id=checkout,
        )
        Donation.objects.filter(id=d.id).update(
            created_at=timezone.now() - timedelta(minutes=60))
        d.outcome_tag = outcome_tag
        return d

    def test_command_fails_and_flags_right_rows_and_reports(self):
        not_paid = self._stale_donation('ws_CO_np', STKQueryOutcome.NOT_PAID)
        paid = self._stale_donation('ws_CO_pd', STKQueryOutcome.PAID)

        def _by_checkout(checkout_id):
            return {'ws_CO_np': STKQueryOutcome.NOT_PAID,
                    'ws_CO_pd': STKQueryOutcome.PAID}[checkout_id]

        out = StringIO()
        # Patch the throttle sleep so the command (which uses the default 15s interval)
        # doesn't actually wait between the two rows.
        with _patch_query(side_effect=_by_checkout), \
                patch('donations.tasks.time.sleep'):
            call_command('sweep_stranded_donations', '--staleness-minutes', '0', stdout=out)

        not_paid.refresh_from_db()
        paid.refresh_from_db()
        self.assertEqual(not_paid.status, DonationStatus.FAILED)
        self.assertEqual(paid.status, DonationStatus.PENDING)  # flagged, NOT credited

        printed = out.getvalue()
        self.assertIn('failed=1', printed)
        self.assertIn('flagged=1', printed)
        self.assertIn('examined=2', printed)
        # Dev-default-settings defense: settings module + DB name printed at startup.
        self.assertIn('settings=', printed)
        self.assertIn('DB=', printed)

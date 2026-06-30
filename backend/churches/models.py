"""churches.Church — pulled forward from Step 2.4 alongside accounts.User.

accounts.User has a forward FK to churches.Church; Django's auth system check
resolves the FK target at startup (check_user_model instantiates User and calls
get_default on every field), so Church must exist for manage.py check to pass.

Only Church moves forward — GroupLabel and all other foundational models stay
in Step 2.4, which also owns the first migration.

Spec: PRD Section 9.1.
"""

import uuid

from django.db import models


class ChurchStatus(models.TextChoices):
    PENDING = 'PENDING', 'Pending'
    ACTIVE = 'ACTIVE', 'Active'
    SUSPENDED = 'SUSPENDED', 'Suspended'
    # Added Step 2.9c — terminal state for rejected registrations. Mirrors the
    # frontend Queue screen's reject action. Public browse filter (status=ACTIVE)
    # automatically excludes REJECTED. Treasurer login is still allowed for a
    # REJECTED church (frontend branches on church_status).
    # Step 2.12b: the reason is now ALSO persisted on `Church.rejection_reason`
    # (below) and surfaced to the rejected treasurer in the login response — so
    # the rejection email is no longer the sole human-readable channel. (The
    # AuditLog CHURCH_REJECTED entry still records it for forensic history.)
    REJECTED = 'REJECTED', 'Rejected'


class SubscriptionTier(models.TextChoices):
    FREE = 'FREE', 'Free'
    GROWTH = 'GROWTH', 'Growth'
    PARISH = 'PARISH', 'Parish'


# Active-campaign cap per tier. None = unlimited. FREE is the only capped tier
# (spec §6: Free = 3 active campaigns). Paid tiers are uncapped.
TIER_ACTIVE_CAMPAIGN_CAP = {
    SubscriptionTier.FREE: 3,
    SubscriptionTier.GROWTH: None,
    SubscriptionTier.PARISH: None,
}

# Subscription renewal-reminder dedup stages (monotonic). The reminder job
# advances Church.subscription_reminder_stage at most once per milestone per
# billing period, so a re-run never re-notifies.
REMINDER_STAGE_NONE = 0   # no reminder sent for the current period
REMINDER_STAGE_7D = 1     # 7-day reminder sent
REMINDER_STAGE_1D = 2     # 1-day reminder sent
# Most-urgent milestone: fires on the LAST full grace day (lapse ≤ 1 day away),
# strictly above 1D in the monotonic high-water order. Derived from
# SUBSCRIPTION_GRACE_DAYS, never hardcoded; the lapse job resets the marker at
# day GRACE_DAYS so GRACE→reset ordering holds. No migration — it's a Python
# constant and subscription_reminder_stage is already a PositiveSmallIntegerField.
REMINDER_STAGE_GRACE = 3


class Church(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    official_email = models.EmailField(unique=True)
    phone = models.CharField(max_length=20)
    address = models.TextField()
    county = models.CharField(max_length=100, null=True, blank=True)
    denomination = models.CharField(max_length=100)
    logo_url = models.URLField(null=True, blank=True)
    description = models.TextField(null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=ChurchStatus.choices,
        default=ChurchStatus.PENDING,
    )
    # Set on reject (SuperChurchRejectView, Step 2.12b); surfaced to the rejected
    # treasurer in the login response. NEVER exposed on public/cross-church
    # surfaces (AdminChurchSerializer is IsSuperAdmin-only; public church
    # serializers don't include it).
    rejection_reason = models.TextField(null=True, blank=True)
    subscription_tier = models.CharField(
        max_length=20,
        choices=SubscriptionTier.choices,
        default=SubscriptionTier.FREE,
    )
    subscription_expires_at = models.DateTimeField(null=True, blank=True)
    # Dedup state for subscription renewal reminders. period = the
    # subscription_expires_at value the last reminder was sent for (self-resets when
    # a new expiry is set). stage = the most-urgent milestone already sent for that
    # period (monotonic; see REMINDER_STAGE_*).
    subscription_reminder_period = models.DateTimeField(null=True, blank=True)
    subscription_reminder_stage = models.PositiveSmallIntegerField(default=REMINDER_STAGE_NONE)
    # Treasurer opt-out of auto-renewal. When True, renewal reminders are suppressed
    # (run_subscription_reminders skips it); the church KEEPS its paid time until expiry,
    # then runs out the grace window and lapses to FREE normally (the lapse job ignores
    # this flag). A successful renewal payment (3b callback) clears it back to False.
    subscription_cancel_requested = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class SubscriptionPaymentStatus(models.TextChoices):
    PENDING = 'PENDING', 'Pending'
    SUCCESSFUL = 'SUCCESSFUL', 'Successful'
    FAILED = 'FAILED', 'Failed'


class SubscriptionPayment(models.Model):
    """A church's M-Pesa STK payment toward a paid subscription tier.

    Mirrors the Donation row's PENDING→SUCCESSFUL/FAILED lifecycle and its
    checkout_request_id idempotency key, but is its OWN model (donations are
    money-IN to a campaign; this is the church paying PamojaHub). Slice 3a builds
    only initiate: a row is created PENDING with the price read live at initiate;
    the /subscriptions/callback/ that confirms it — setting mpesa_receipt_number,
    period_end_granted, confirmed_at and advancing the church's tier/expiry — is 3b.
    INITIATE GRANTS NOTHING: the church's subscription_tier / subscription_expires_at
    are never touched by the initiate path.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    church = models.ForeignKey(
        Church,
        on_delete=models.CASCADE,
        related_name='subscription_payments',
    )
    # The tier being paid for. GROWTH/PARISH only — enforced at the view, not the DB
    # (FREE is a valid SubscriptionTier value but is never a payment target).
    tier = models.CharField(max_length=20, choices=SubscriptionTier.choices)
    # Price read LIVE from PlatformSettings at INITIATE and stored here (forward-only
    # at initiate — a later price change does not rewrite an in-flight row's amount).
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    phone_number = models.CharField(max_length=20)  # the M-Pesa number charged
    status = models.CharField(
        max_length=20,
        choices=SubscriptionPaymentStatus.choices,
        default=SubscriptionPaymentStatus.PENDING,
    )
    # Daraja idempotency key — unique so duplicate STK callbacks can't double-process.
    checkout_request_id = models.CharField(max_length=100, unique=True, null=True, blank=True)
    mpesa_receipt_number = models.CharField(max_length=50, null=True, blank=True)  # set by 3b
    # The expiry this payment bought — set by the 3b callback; NULL until confirmed.
    period_end_granted = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)  # set by 3b

    class Meta:
        ordering = ['-created_at']
        indexes = [
            # checkout_request_id is unique=True (already has a unique index); do NOT
            # add a second plain index on it — mirrors the Donation model comment.
            models.Index(fields=['church', 'status'], name='idx_subpay_church_status'),
        ]

    def __str__(self):
        return f'{self.church_id} {self.tier} {self.status}'

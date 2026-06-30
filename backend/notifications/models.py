import uuid

from django.db import models


class NotificationType(models.TextChoices):
    """Backend enum keeps DISBURSEMENT_* names; "Payout" is UI-only (Section 14)."""

    DONATION_RECEIVED = 'DONATION_RECEIVED', 'Donation Received'
    # Emitted by the stranded-donation resolver when STK Push Query reports a PENDING
    # donation as PAID. This is NOT a credit — the resolver never credits — it asks a
    # Super Admin to confirm against the M-Pesa statement and credit manually. Paired
    # with AuditLog action DONATION_FLAGGED_NEEDS_REVIEW.
    DONATION_NEEDS_REVIEW = 'DONATION_NEEDS_REVIEW', 'Donation Needs Review'
    DISBURSEMENT_SUBMITTED = 'DISBURSEMENT_SUBMITTED', 'Disbursement Submitted'
    DISBURSEMENT_APPROVED = 'DISBURSEMENT_APPROVED', 'Disbursement Approved'
    DISBURSEMENT_REJECTED = 'DISBURSEMENT_REJECTED', 'Disbursement Rejected'
    DISBURSEMENT_PAID = 'DISBURSEMENT_PAID', 'Disbursement Paid'
    DISBURSEMENT_FAILED = 'DISBURSEMENT_FAILED', 'Disbursement Failed'
    # Emitted when a B2C result callback confirms payment on a row already HELD
    # for manual reconciliation (NEEDS_RECONCILIATION). This is a CONFIRMED
    # SUCCESS awaiting a human resolve — NOT a failure — so it must not reuse
    # DISBURSEMENT_FAILED. Paired with AuditLog action
    # WITHDRAWAL_RECONCILIATION_PAYMENT_CONFIRMED.
    RECONCILIATION_PAYMENT_CONFIRMED = (
        'RECONCILIATION_PAYMENT_CONFIRMED', 'Reconciliation Payment Confirmed'
    )
    SUBSCRIPTION_REMINDER = 'SUBSCRIPTION_REMINDER', 'Subscription Reminder'
    SUBSCRIPTION_LAPSED = 'SUBSCRIPTION_LAPSED', 'Subscription Lapsed'
    # Slice 3b: emitted when a subscription STK payment is confirmed (callback
    # ResultCode 0) — the church's paid period was extended and its tier set.
    # Distinct from REMINDER (expiring) / LAPSED (downgraded) — neither fits a
    # successful activation, so a new type is genuinely needed.
    SUBSCRIPTION_ACTIVATED = 'SUBSCRIPTION_ACTIVATED', 'Subscription Activated'
    # Step 2.9a: emitted when a campaign's treasurer_phone or treasurer_name (the
    # payout destination) is changed via the campaigns edit endpoint. AuditLog
    # entry CAMPAIGN_TREASURER_DESTINATION_CHANGED captures the old/new values;
    # this notification surfaces the change to the Church Treasurer in-app so
    # silent payout-destination changes never go unnoticed. Deeper mitigation —
    # re-auth on change, email alert — is deferred to a security hardening pass.
    CAMPAIGN_DESTINATION_CHANGED = 'CAMPAIGN_DESTINATION_CHANGED', 'Campaign Destination Changed'


class Notification(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipient = models.ForeignKey(
        'accounts.User',
        on_delete=models.CASCADE,
        related_name='notifications',
    )
    notification_type = models.CharField(
        max_length=40,  # widened from 30 for RECONCILIATION_PAYMENT_CONFIRMED (32 chars)
        choices=NotificationType.choices,
    )
    title = models.CharField(max_length=255)
    message = models.TextField()
    related_campaign = models.ForeignKey(
        'campaigns.Campaign',
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name='notifications',
    )
    related_withdrawal = models.ForeignKey(
        'withdrawals.Withdrawal',
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name='notifications',
    )
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            # Shortened from idx_notification_recipient_read (31 chars > Postgres 30).
            models.Index(fields=['recipient', 'is_read'], name='idx_notif_recipient_read'),
        ]

import uuid

from django.db import models


class DonationStatus(models.TextChoices):
    PENDING = 'PENDING', 'Pending'
    SUCCESSFUL = 'SUCCESSFUL', 'Successful'
    FAILED = 'FAILED', 'Failed'


class Donation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    campaign = models.ForeignKey(
        'campaigns.Campaign',
        on_delete=models.CASCADE,
        related_name='donations',
    )
    phone_number = models.CharField(max_length=20)
    donor_name = models.CharField(max_length=255, null=True, blank=True)
    donor_email = models.EmailField(null=True, blank=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    # NULL until the STK callback confirms (ResultCode 0). Computed there from the
    # LIVE PlatformSettings.fee_percent and stored on the row — forward-only fees.
    platform_fee = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    net_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=DonationStatus.choices,
        default=DonationStatus.PENDING,
    )
    # Daraja idempotency key — unique so duplicate STK callbacks can't double-process.
    checkout_request_id = models.CharField(max_length=100, unique=True, null=True, blank=True)
    mpesa_receipt_number = models.CharField(max_length=50, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            # checkout_request_id is unique=True (already has a unique index); do NOT
            # add a second plain index on it — it would duplicate that unique index.
            models.Index(fields=['campaign', 'status'], name='idx_donation_campaign_status'),
        ]
        constraints = [
            models.CheckConstraint(condition=models.Q(amount__gte=5),
                                   name='donation_min_amount'),
            # platform_fee is NULL until the STK callback credits. A Postgres CHECK
            # passes when the expression is NULL (UNKNOWN), so existing PENDING rows
            # with NULL platform_fee are ACCEPTED, not rejected.
            models.CheckConstraint(condition=models.Q(platform_fee__gte=0),
                                   name='donation_fee_non_negative'),
        ]

import uuid

from django.db import models


class CampaignStatus(models.TextChoices):
    ACTIVE = 'ACTIVE', 'Active'
    PAUSED = 'PAUSED', 'Paused'
    CLOSED = 'CLOSED', 'Closed'


class CampaignCategory(models.TextChoices):
    BUILDING = 'Building', 'Building'
    OUTREACH = 'Outreach', 'Outreach'
    YOUTH = 'Youth', 'Youth'
    EDUCATION = 'Education', 'Education'
    MEDICAL = 'Medical', 'Medical'
    RELIEF = 'Relief', 'Relief'
    OTHER = 'Other', 'Other'


class GroupLabel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    church = models.ForeignKey(
        'churches.Church',
        on_delete=models.CASCADE,
        related_name='group_labels',
    )
    parent_label = models.ForeignKey(
        'self',
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name='children',
    )
    name = models.CharField(max_length=255)
    is_archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']


class Campaign(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    slug = models.SlugField(max_length=280, unique=True)
    church = models.ForeignKey(
        'churches.Church',
        on_delete=models.CASCADE,
        related_name='campaigns',
    )
    group_label = models.ForeignKey(
        GroupLabel,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='campaigns',
    )
    title = models.CharField(max_length=120)
    description = models.TextField()
    goal_amount = models.DecimalField(max_digits=12, decimal_places=2)
    raised_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    wallet_balance = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    status = models.CharField(
        max_length=20,
        choices=CampaignStatus.choices,
        default=CampaignStatus.ACTIVE,
    )
    banner_image_url = models.URLField(null=True, blank=True)
    document_url = models.URLField(null=True, blank=True)
    category = models.CharField(max_length=20, choices=CampaignCategory.choices)
    treasurer_phone = models.CharField(max_length=20)
    treasurer_name = models.CharField(max_length=255)
    created_by = models.ForeignKey(
        'accounts.User',
        on_delete=models.PROTECT,
        related_name='created_campaigns',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['church', 'status'], name='idx_campaign_church_status'),
            models.Index(fields=['status', 'category'], name='idx_campaign_status_category'),
            models.Index(fields=['treasurer_phone'], name='idx_campaign_treasurer_phone'),
        ]
        constraints = [
            models.CheckConstraint(condition=models.Q(goal_amount__gt=0),
                                   name='campaign_goal_positive'),
            models.CheckConstraint(condition=models.Q(raised_amount__gte=0),
                                   name='campaign_raised_non_negative'),
            # wallet_balance >= 0 is DELIBERATELY OMITTED. finalize_withdrawal_paid
            # decrements unguarded, so a DB CHECK would roll back the PAID finalize
            # mid-transaction; the request/approval/retry balance guards + the
            # one-outstanding-withdrawal blocking invariant + add-only donation credits
            # already prevent a negative balance. Do not "complete the set" without
            # revisiting that decision.
        ]


class CampaignUpdate(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    campaign = models.ForeignKey(
        Campaign,
        on_delete=models.CASCADE,
        related_name='updates',
    )
    posted_by = models.ForeignKey(
        'accounts.User',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='campaign_updates',
    )
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

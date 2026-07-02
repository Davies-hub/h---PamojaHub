import uuid

from django.db import models


class MediaKind(models.TextChoices):
    BANNER = 'BANNER', 'Banner'
    LOGO = 'LOGO', 'Logo'


class MediaAsset(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=10, choices=MediaKind.choices)
    campaign = models.ForeignKey(
        'campaigns.Campaign',
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name='media_assets',
    )
    church = models.ForeignKey(
        'churches.Church',
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name='media_assets',
    )
    object_key = models.CharField(max_length=512, unique=True)   # server-gen uuid4 key; unique index is the DB backstop (cleanup slice)
    bucket = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    size_bytes = models.PositiveIntegerField()
    uploaded_by = models.ForeignKey(
        'accounts.User',
        on_delete=models.PROTECT,
        related_name='uploaded_media',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['campaign'], name='idx_mediaasset_campaign'),
            models.Index(fields=['church'], name='idx_mediaasset_church'),
        ]
        constraints = [
            # ONE constraint = ONE truth. XOR of owner pinned to kind: a BANNER has a campaign
            # and NO church; a LOGO has a church and NO campaign. Defeats "both set", "neither
            # set", and "kind mismatched to owner" in a single named CHECK. NOTE the NULL-passes
            # -CHECK semantics (see donation_fee_non_negative): every arm here pins the OTHER
            # owner to __isnull=True explicitly, so NULL can't be used to slip a second owner in.
            models.CheckConstraint(
                condition=(
                    (models.Q(kind='BANNER') & models.Q(campaign__isnull=False) & models.Q(church__isnull=True))
                    | (models.Q(kind='LOGO') & models.Q(church__isnull=False) & models.Q(campaign__isnull=True))
                ),
                name='mediaasset_owner_matches_kind',
            ),
        ]

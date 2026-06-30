import uuid

from django.db import models


class CampaignTreasurerOTP(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    phone_number = models.CharField(max_length=20)
    # SHA-256 hex digest is 64 chars; OTP stored hashed at rest (Section 7 security model).
    otp_code = models.CharField(max_length=64)
    campaign_ids = models.JSONField(default=list)
    # Mirrors PasswordResetOTP.attempt_count — increments on each verify; at MAX_ATTEMPTS
    # (currently 5) the OTP is marked is_used=True even with no further requests.
    attempt_count = models.IntegerField(default=0)
    is_used = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['phone_number', 'is_used', 'expires_at'], name='idx_otp_phone_active'),
        ]


class PortalToken(models.Model):
    """Portal token bound to IP, 30-min expiry (Compressed Context Section 7).

    token_hash added beyond the Section 10 list for the same reason RefreshToken and OTP
    are hashed: stores SHA-256 of the issued token so validation never compares plaintext.
    Recorded as a Section 14 deviation.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    phone_number = models.CharField(max_length=20)
    campaign_ids = models.JSONField(default=list)
    ip_address = models.CharField(max_length=45, null=True, blank=True)
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    is_revoked = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

import uuid

from django.db import models


class AuditLog(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor = models.ForeignKey(
        'accounts.User',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='audit_logs',
    )
    actor_phone = models.CharField(max_length=20, null=True, blank=True)
    action = models.CharField(max_length=100)
    entity_type = models.CharField(max_length=50)
    entity_id = models.UUIDField()
    details = models.JSONField(default=dict)
    ip_address = models.CharField(max_length=45, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['entity_type', 'entity_id'], name='idx_auditlog_entity'),
            models.Index(fields=['created_at'], name='idx_auditlog_created'),
        ]

    # NOTE: This Python-level guard only catches instance .save()/.delete() calls.
    # QuerySet.update() and QuerySet.delete() bypass these methods entirely (they go
    # straight to SQL). Full immutability is enforced at the PostgreSQL role level in
    # Phase 3 Step 3.3 (REVOKE UPDATE, DELETE on audit_auditlog FROM pamoja_app).
    # Do not treat this Python override as complete protection.
    def save(self, *args, **kwargs):
        # UUID PKs are populated by default=uuid.uuid4 at instantiation, so self.pk
        # is truthy even on brand-new unsaved records. The existence check distinguishes
        # genuine updates (row already in DB) from first inserts (row not yet in DB).
        if self.pk and AuditLog.objects.filter(pk=self.pk).exists():
            raise ValueError("AuditLog records are immutable and cannot be updated.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("AuditLog records cannot be deleted.")

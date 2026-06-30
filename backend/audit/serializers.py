"""AuditLog serializer — read-only, Super-Admin-only surface.

Step 2.9c exposes the audit log via GET /api/v1/super/audit-log/. NO write endpoint:
  * AuditLog model enforces Python-level immutability via save()/delete() overrides.
  * Phase 3 Step 3.3 will REVOKE UPDATE, DELETE on the postgres table from the app
    role for defence in depth.
  * The API offers READ only; there is no PATCH/PUT/DELETE.

Fields exposed: id, actor email or actor_phone (whichever is set — actor is FK to
User, actor_phone is the bare string for portal/SMS-initiated actions), action,
entity_type, entity_id, details, ip_address, created_at. The audit log is the
forensic surface for Super Admin investigation.
"""

from rest_framework import serializers

from audit.models import AuditLog


class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = [
            'id',
            'actor_email',
            'actor_phone',
            'action',
            'entity_type',
            'entity_id',
            'details',
            'ip_address',
            'created_at',
        ]
        read_only_fields = fields

    def get_actor_email(self, obj):
        return obj.actor.email if obj.actor_id else None

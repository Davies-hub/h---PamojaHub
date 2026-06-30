"""Notification serializer — read-mostly; only is_read is writable (mark-as-read flow)."""

from rest_framework import serializers

from notifications.models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    related_campaign = serializers.PrimaryKeyRelatedField(read_only=True, allow_null=True)
    related_withdrawal = serializers.PrimaryKeyRelatedField(read_only=True, allow_null=True)

    class Meta:
        model = Notification
        fields = [
            'id',
            'notification_type',
            'title',
            'message',
            'related_campaign',
            'related_withdrawal',
            'is_read',
            'created_at',
        ]
        read_only_fields = [
            'id',
            'notification_type',
            'title',
            'message',
            'related_campaign',
            'related_withdrawal',
            'created_at',
        ]

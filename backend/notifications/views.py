"""Notification read surface (Slice 1) — list + unread-count + mark-read + mark-all-read.

Read-only enum + emission sites are owned elsewhere (churches/tasks.py,
churches/views.py, etc.). This module ONLY exposes the recipient-scoped read API the
frontend's notifications.service.ts Phase-4 stubs target. Paths/verbs/shapes match
those stubs exactly:
  GET  /api/v1/notifications/                 → PaginatedResponse {count, results}
  GET  /api/v1/notifications/unread-count/    → {"count": N}
  POST /api/v1/notifications/{id}/read/       → the updated serialized notification
  POST /api/v1/notifications/read-all/        → {"updated": N}

LEAK GUARD: every endpoint operates on Notification.objects.filter(recipient=
request.user) and nothing wider. A foreign or nonexistent id is a 404 (never 403) so
existence is not leaked across users.
"""

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from common.pagination import StandardPagination
from notifications.models import Notification
from notifications.serializers import NotificationSerializer


class NotificationListView(APIView):
    """GET /api/v1/notifications/ — the caller's own notifications, newest first."""

    permission_classes = [IsAuthenticated]
    pagination_class = StandardPagination

    def get(self, request):
        qs = (
            Notification.objects
            .filter(recipient=request.user)
            .order_by('-created_at')
        )
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(
            NotificationSerializer(page, many=True).data
        )


class NotificationUnreadCountView(APIView):
    """GET /api/v1/notifications/unread-count/ — {"count": N} of the caller's unread."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        count = Notification.objects.filter(
            recipient=request.user, is_read=False,
        ).count()
        return Response({'count': count}, status=status.HTTP_200_OK)


class NotificationReadView(APIView):
    """POST /api/v1/notifications/{id}/read/ — mark a single notification read.

    Fetched from the user-scoped queryset, so a row that does not exist OR belongs to
    another user is an identical 404 (no existence leak). Idempotent: an already-read
    row still returns 200 with the serialized notification.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, id):
        try:
            notification = Notification.objects.get(id=id, recipient=request.user)
        except Notification.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        if not notification.is_read:
            notification.is_read = True
            notification.save(update_fields=['is_read'])
        return Response(
            NotificationSerializer(notification).data, status=status.HTTP_200_OK
        )


class NotificationReadAllView(APIView):
    """POST /api/v1/notifications/read-all/ — bulk-mark the caller's unread; {"updated": N}."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        updated = Notification.objects.filter(
            recipient=request.user, is_read=False,
        ).update(is_read=True)
        return Response({'updated': updated}, status=status.HTTP_200_OK)

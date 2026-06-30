"""Notification URL routes — mounted at /api/v1/notifications/ by config/urls.py."""

from django.urls import path

from notifications.views import (
    NotificationListView,
    NotificationReadAllView,
    NotificationReadView,
    NotificationUnreadCountView,
)


urlpatterns = [
    path('', NotificationListView.as_view(), name='notification-list'),
    path('unread-count/', NotificationUnreadCountView.as_view(), name='notification-unread-count'),
    path('read-all/', NotificationReadAllView.as_view(), name='notification-read-all'),
    path('<uuid:id>/read/', NotificationReadView.as_view(), name='notification-read'),
]

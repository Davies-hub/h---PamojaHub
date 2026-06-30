"""Subscription-payment URL routes — mounted at /api/v1/subscriptions/ by config/urls.py.

Housed in the churches app (NOT a separate app) because the subscription-lifecycle
domain already lives entirely here (Church.subscription_* fields, SubscriptionTier,
services.set_church_tier, tasks.py grace/reminders, the process_subscriptions
command). This mirrors campaigns/group_label_urls.py — a second URL module exposing
a feature of an existing app on its own mount path.

Routes (Slice 3a + 3b):
  * initiate/        — treasurer-only STK push (3a).
  * callback/        — Safaricom-called STK result; confirm → extend period + flip tier,
                       idempotent, keyed on checkout_request_id (3b). PUBLIC.
  * <id>/status/     — treasurer-owned poll; status + tier + expiry + derived stale flag (3b).
"""

from django.conf import settings
from django.urls import path

from churches.views import (
    SubscriptionCallbackView,
    SubscriptionCancelView,
    SubscriptionInitiateView,
    SubscriptionStatusView,
)

# Shared secret path segment (see donations/urls.py). Empty → bare 'callback/'.
_callback_path = (
    f'callback/{settings.MPESA_CALLBACK_SECRET}/'
    if settings.MPESA_CALLBACK_SECRET else 'callback/'
)

urlpatterns = [
    path('initiate/', SubscriptionInitiateView.as_view(), name='subscription-initiate'),
    path('cancel/', SubscriptionCancelView.as_view(), name='subscription-cancel'),
    path(_callback_path, SubscriptionCallbackView.as_view(), name='subscription-callback'),
    path('<uuid:id>/status/', SubscriptionStatusView.as_view(), name='subscription-status'),
]

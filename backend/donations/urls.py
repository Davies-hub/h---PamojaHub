"""Donations URL routes — mounted at /api/v1/donations/ by config/urls.py (Step 2.10b).

All three are PUBLIC (AllowAny):
  * initiate/        — donor starts an STK push (rate-limited 10/h per phone).
  * callback/        — Safaricom-called STK result callback (idempotent).
  * <id>/status/     — donor success-screen poll (GROSS amount, no fee breakdown).
"""

from django.conf import settings
from django.urls import path

from donations.views import (
    DonationCallbackView,
    DonationInitiateView,
    DonationStatusView,
)


# Secret path segment (settings-driven, one source of truth shared by all three
# payment callbacks). Empty → bare 'callback/' (dev convenience); non-empty →
# 'callback/<secret>/' so a forged POST that doesn't know the secret 404s at the
# router. reverse('donation-callback') yields whichever is active, so callers and
# tests never hardcode the segment.
_callback_path = (
    f'callback/{settings.MPESA_CALLBACK_SECRET}/'
    if settings.MPESA_CALLBACK_SECRET else 'callback/'
)


urlpatterns = [
    path('initiate/', DonationInitiateView.as_view(), name='donation-initiate'),
    path(_callback_path, DonationCallbackView.as_view(), name='donation-callback'),
    path('<uuid:id>/status/', DonationStatusView.as_view(), name='donation-status'),
]

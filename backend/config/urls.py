"""Pamoja Hub URL configuration.

All API surface lives under /api/v1/<resource>/.
  * /auth/         — accounts.urls (Step 2.7: register, login, refresh, logout, password-reset)
  * /treasurer/    — treasurer_portal.urls (Step 2.8: phone-portal OTP + scoped endpoints)
  * /churches/     — churches.urls (Step 2.9a: public browse + treasurer's own church)
  * /campaigns/    — campaigns.urls (Step 2.9a: public browse + treasurer's own campaigns)
  * /stats/        — campaigns.stats_urls (PH4-02: public all-time platform totals)
  * /group-labels/ — campaigns.group_label_urls (Step 2.9a: treasurer's group labels)
  * /withdrawals/  — withdrawals.urls (Step 2.9b: list + approve/reject/retry)
  * /super/        — superadmin.urls (Step 2.9c: Super Admin reads + state-changers + billing)
  * /donations/    — donations.urls (Step 2.10b: STK initiate + callback + status poll)
  * /subscriptions/ — churches.subscription_urls (Slice 3a: treasurer subscription STK initiate)
  * /notifications/ — notifications.urls (Slice 1: recipient-scoped read API)
"""

from django.conf import settings
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/v1/auth/', include('accounts.urls')),
    path('api/v1/treasurer/', include('treasurer_portal.urls')),
    path('api/v1/churches/', include('churches.urls')),
    path('api/v1/campaigns/', include('campaigns.urls')),
    path('api/v1/stats/', include('campaigns.stats_urls')),
    path('api/v1/group-labels/', include('campaigns.group_label_urls')),
    path('api/v1/withdrawals/', include('withdrawals.urls')),
    path('api/v1/super/', include('superadmin.urls')),
    path('api/v1/donations/', include('donations.urls')),
    path('api/v1/subscriptions/', include('churches.subscription_urls')),
    path('api/v1/notifications/', include('notifications.urls')),
]

# ── DEBUG-ONLY test helper ────────────────────────────────────────────────────
# django-ratelimit uses the in-process locmem cache in dev (see
# config/settings/development.py). Because locmem is per-process, a management
# command in a separate process CANNOT clear the running server's counters — so
# the e2e harness needs an endpoint the server itself handles. This route is
# ONLY mounted when DEBUG is True; with DEBUG=False (production) the block is
# skipped entirely and no such URL exists. It changes no rate-limit logic.
if settings.DEBUG:
    from django.core.cache import cache
    from django.http import JsonResponse
    from django.views.decorators.csrf import csrf_exempt

    @csrf_exempt
    def _dev_reset_ratelimit(request):
        cache.clear()
        return JsonResponse({'cleared': True})

    urlpatterns += [
        path('api/v1/dev/reset-ratelimit/', _dev_reset_ratelimit),
    ]

"""Public platform-stats route — mounted at /api/v1/stats/ by config/urls.py.

A single AllowAny endpoint that feeds the public landing hero. Kept as its own
top-level module (mirroring campaigns.group_label_urls at /group-labels/) so the
public URL is a clean /stats/ rather than nested under /campaigns/.
"""

from django.urls import path

from campaigns.views import PlatformStatsView

urlpatterns = [
    path('', PlatformStatsView.as_view(), name='platform-stats'),
]

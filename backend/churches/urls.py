"""Churches URL routes — mounted at /api/v1/churches/ by config/urls.py.

`me/` is matched BEFORE `<uuid:id>/` so the literal "me" never falls into the UUID path.
"""

from django.urls import path

from churches.views import (
    ChurchLogoUploadView,
    ChurchMeDonationsView,
    ChurchMeStatsView,
    ChurchMeView,
    PublicChurchDetailView,
    PublicChurchListView,
)

urlpatterns = [
    path('', PublicChurchListView.as_view(), name='church-public-list'),
    path('me/', ChurchMeView.as_view(), name='church-me'),
    path('me/logo/', ChurchLogoUploadView.as_view(), name='church-logo-upload'),
    path('me/stats/', ChurchMeStatsView.as_view(), name='church-me-stats'),
    path('me/donations/', ChurchMeDonationsView.as_view(), name='church-me-donations'),
    path('<uuid:id>/', PublicChurchDetailView.as_view(), name='church-public-detail'),
]

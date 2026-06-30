"""GroupLabel URL routes — mounted at /api/v1/group-labels/ by config/urls.py.

Lives in the campaigns app because GroupLabel is defined in campaigns/models.py;
kept in a separate URL conf so the mount point can be `/group-labels/` rather
than nested under `/campaigns/`.
"""

from django.urls import path

from campaigns.views import (
    GroupLabelArchiveView,
    GroupLabelDetailView,
    GroupLabelListCreateView,
    GroupLabelUnarchiveView,
)


urlpatterns = [
    path('', GroupLabelListCreateView.as_view(), name='group-label-list-create'),
    path('<uuid:id>/', GroupLabelDetailView.as_view(), name='group-label-detail'),
    path('<uuid:id>/archive/', GroupLabelArchiveView.as_view(), name='group-label-archive'),
    path('<uuid:id>/unarchive/', GroupLabelUnarchiveView.as_view(), name='group-label-unarchive'),
]

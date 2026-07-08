"""Campaigns URL routes — mounted at /api/v1/campaigns/ by config/urls.py.

Path ordering: `mine/` literal segments come BEFORE `<slug>/` so the admin
surface never falls into the public-by-slug route. Public detail uses
`<slug>/` — the slug field is unique across all campaigns.
"""

from django.urls import path

from campaigns.views import (
    CampaignBannerUploadView,
    CampaignCloseView,
    CampaignCreateView,
    CampaignPauseView,
    CampaignResumeView,
    CampaignUpdatesView,
    ChurchCampaignsExportView,
    PublicCampaignDetailView,
    PublicCampaignListView,
    TreasurerCampaignDetailView,
    TreasurerCampaignListView,
)


urlpatterns = [
    # Public browse
    path('', PublicCampaignListView.as_view(), name='campaign-public-list'),

    # Treasurer admin surface — under /mine/ to keep separate from public slug
    path('mine/', TreasurerCampaignListView.as_view(), name='campaign-mine-list'),
    path('mine/create/', CampaignCreateView.as_view(), name='campaign-create'),
    # Full un-paginated CSV of the treasurer's campaigns. MUST precede the
    # mine/<slug:slug>/ route below — else the slug view swallows 'export' as a slug.
    path('mine/export/', ChurchCampaignsExportView.as_view(), name='campaign-export'),
    path('mine/<slug:slug>/', TreasurerCampaignDetailView.as_view(), name='campaign-mine-detail'),
    path('mine/<slug:slug>/pause/', CampaignPauseView.as_view(), name='campaign-pause'),
    path('mine/<slug:slug>/resume/', CampaignResumeView.as_view(), name='campaign-resume'),
    path('mine/<slug:slug>/close/', CampaignCloseView.as_view(), name='campaign-close'),
    path('mine/<slug:slug>/banner/', CampaignBannerUploadView.as_view(), name='campaign-banner-upload'),

    # Campaign updates (GET public, POST treasurer)
    path('<slug:slug>/updates/', CampaignUpdatesView.as_view(), name='campaign-updates'),

    # Public detail by slug — LAST so it doesn't shadow mine/
    path('<slug:slug>/', PublicCampaignDetailView.as_view(), name='campaign-public-detail'),
]

"""Campaign Treasurer portal URL routes — mounted at /api/v1/treasurer/ by config/urls.py."""

from django.urls import path

from treasurer_portal.views import (
    PortalCampaignDisbursementsView,
    PortalCampaignListView,
    PortalDonationReportView,
    PortalRequestDisbursementView,
    RequestOTPView,
    VerifyOTPView,
)

urlpatterns = [
    path('request-otp/', RequestOTPView.as_view(), name='portal-request-otp'),
    path('verify-otp/', VerifyOTPView.as_view(), name='portal-verify-otp'),
    path('campaigns/', PortalCampaignListView.as_view(), name='portal-campaigns'),
    path('campaigns/<uuid:id>/report/', PortalDonationReportView.as_view(), name='portal-campaign-report'),
    path('campaigns/<uuid:id>/request-disbursement/', PortalRequestDisbursementView.as_view(), name='portal-request-disbursement'),
    path('campaigns/<uuid:id>/disbursements/', PortalCampaignDisbursementsView.as_view(), name='portal-campaign-disbursements'),
]

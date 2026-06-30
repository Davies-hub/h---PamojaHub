"""Super Admin URL routes — mounted at /api/v1/super/ by config/urls.py.

Path ordering: literal segments BEFORE <uuid:id>/ so /churches/pending/ doesn't
fall into the church-by-id route.

EVERY endpoint here has permission_classes = [IsSuperAdmin] — see views for the
inverted-permission-story discussion. The "lock on every door" audit is in
tests/test_superadmin.py::PermissionInversionTest.
"""

from django.urls import path

from superadmin.views import (
    SuperAnalyticsView,
    SuperAuditLogView,
    SuperBillingView,
    SuperCampaignsListView,
    SuperChurchApproveView,
    SuperChurchesListView,
    SuperChurchesPendingView,
    SuperChurchReactivateView,
    SuperChurchRejectView,
    SuperChurchSetTierView,
    SuperChurchSuspendView,
    SuperDonationsListView,
    SuperWithdrawalForceRetryView,
    SuperWithdrawalResolvePaidView,
    SuperWithdrawalResolveRetryView,
    SuperWithdrawalsListView,
)


urlpatterns = [
    # Reads
    path('churches/', SuperChurchesListView.as_view(), name='super-churches'),
    path('churches/pending/', SuperChurchesPendingView.as_view(), name='super-churches-pending'),
    path('campaigns/', SuperCampaignsListView.as_view(), name='super-campaigns'),
    path('donations/', SuperDonationsListView.as_view(), name='super-donations'),
    path('withdrawals/', SuperWithdrawalsListView.as_view(), name='super-withdrawals'),
    path('analytics/', SuperAnalyticsView.as_view(), name='super-analytics'),
    path('audit-log/', SuperAuditLogView.as_view(), name='super-audit-log'),

    # State-changers — churches
    path('churches/<uuid:id>/approve/', SuperChurchApproveView.as_view(), name='super-church-approve'),
    path('churches/<uuid:id>/reject/', SuperChurchRejectView.as_view(), name='super-church-reject'),
    path('churches/<uuid:id>/suspend/', SuperChurchSuspendView.as_view(), name='super-church-suspend'),
    path('churches/<uuid:id>/reactivate/', SuperChurchReactivateView.as_view(), name='super-church-reactivate'),
    path('churches/<uuid:id>/set-tier/', SuperChurchSetTierView.as_view(), name='super-church-set-tier'),

    # State-changer — withdrawal force-retry (the money-mover)
    path('withdrawals/<uuid:id>/force-retry/', SuperWithdrawalForceRetryView.as_view(), name='super-withdrawal-force-retry'),

    # NEEDS_RECONCILIATION resolution — the only safe human exit (2.10c)
    path('withdrawals/<uuid:id>/resolve-paid/', SuperWithdrawalResolvePaidView.as_view(), name='super-withdrawal-resolve-paid'),
    path('withdrawals/<uuid:id>/resolve-retry/', SuperWithdrawalResolveRetryView.as_view(), name='super-withdrawal-resolve-retry'),

    # Billing — PlatformSettings (the only fee_percent surface)
    path('billing/', SuperBillingView.as_view(), name='super-billing'),
]

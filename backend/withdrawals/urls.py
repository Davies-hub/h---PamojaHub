"""Withdrawals URL routes — mounted at /api/v1/withdrawals/ by config/urls.py."""

from django.conf import settings
from django.urls import path

from withdrawals.views import (
    B2CResultCallbackView,
    WithdrawalApproveView,
    WithdrawalListView,
    WithdrawalRejectView,
    WithdrawalRetryView,
)


# Shared secret path segment (see donations/urls.py). Empty → bare 'b2c-result/'.
_b2c_result_path = (
    f'b2c-result/{settings.MPESA_CALLBACK_SECRET}/'
    if settings.MPESA_CALLBACK_SECRET else 'b2c-result/'
)


urlpatterns = [
    path('', WithdrawalListView.as_view(), name='withdrawal-list'),
    # Public — Safaricom-called B2C ResultURL (async payout outcome).
    path(_b2c_result_path, B2CResultCallbackView.as_view(), name='withdrawal-b2c-result'),
    path('<uuid:id>/approve/', WithdrawalApproveView.as_view(), name='withdrawal-approve'),
    path('<uuid:id>/reject/', WithdrawalRejectView.as_view(), name='withdrawal-reject'),
    path('<uuid:id>/retry/', WithdrawalRetryView.as_view(), name='withdrawal-retry'),
]

"""Shared donation money-mover helpers (STK callback + a future stuck-donation resolver).

The SINGLE place a donation is credited or failed, so the idempotent credit (with its
exactly-once wallet/raised increment), the LIVE-fee read, and the FAILED audit can
never drift between call sites. Mirrors withdrawals/services.py (finalize_withdrawal_paid):
the CALLER holds the SELECT FOR UPDATE lock on the donation row; each helper RE-CHECKS
terminal status under that lock so a second caller — a Safaricom callback retry, or a
future resolver racing the callback — no-ops instead of double-crediting.
"""

import logging
from decimal import Decimal, ROUND_HALF_UP

from django.utils import timezone

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign
from common.masking import mask_phone
from donations.models import DonationStatus
from notifications.models import Notification, NotificationType
from superadmin.models import PlatformSettings


logger = logging.getLogger(__name__)


def _compute_fee(gross, fee_percent):
    """Forward-only fee split. fee_percent is a percentage (e.g. Decimal('2.50')).

    platform_fee rounded to cents (ROUND_HALF_UP); net = gross − fee so the two
    always reconcile exactly to gross.
    """
    # ROUND_HALF_UP is deliberate (owner decision 2026-07-16): half-cent rounds
    # toward the platform fee. Pinned by test.
    platform_fee = (gross * fee_percent / Decimal('100')).quantize(
        Decimal('0.01'), rounding=ROUND_HALF_UP
    )
    net_amount = gross - platform_fee
    return platform_fee, net_amount


def finalize_donation_successful(*, donation, gross, receipt, source, ip_address=None):
    """IDEMPOTENTLY credit a donation as SUCCESSFUL, moving the campaign's raised_amount
    and wallet_balance by NET exactly once.

    Callable from the STK result callback (real success) and a future stuck-donation
    resolver (STK Push Query confirmed paid) — whichever runs second sees a terminal
    status and no-ops, so the campaign is never double-credited.

    CALLER CONTRACT: must already hold a SELECT FOR UPDATE lock on `donation` (so the
    terminal-status guard is race-free). Returns True if it credited, False if the row
    was already settled.

    `source` ('callback' | 'resolver') is recorded in the audit so we can tell which
    path settled the donation. The fee is read LIVE from PlatformSettings here (never a
    settings constant) so both call sites bill at the current rate.
    """
    # Guard: terminal in EITHER direction (SUCCESSFUL or FAILED) — a settled donation is
    # never re-credited. Mirrors the callback's own short-circuit; lives IN the helper so
    # the resolver path is protected by the same guard, not just the callback.
    if donation.status in (DonationStatus.SUCCESSFUL, DonationStatus.FAILED):
        return False

    # Live fee read — NOT the settings decoy constant.
    fee_percent = PlatformSettings.load().fee_percent
    platform_fee, net_amount = _compute_fee(gross, fee_percent)

    donation.status = DonationStatus.SUCCESSFUL
    donation.amount = gross           # confirmed GROSS (matches the SMS)
    donation.platform_fee = platform_fee
    donation.net_amount = net_amount
    donation.mpesa_receipt_number = receipt
    donation.confirmed_at = timezone.now()
    donation.save(update_fields=[
        'status', 'amount', 'platform_fee', 'net_amount',
        'mpesa_receipt_number', 'confirmed_at',
    ])

    # Net-Everywhere: raised_amount & wallet_balance move by NET, under a campaign row
    # lock to serialize against concurrent credits/payouts.
    campaign = Campaign.objects.select_for_update().get(id=donation.campaign_id)
    campaign.raised_amount = campaign.raised_amount + net_amount
    campaign.wallet_balance = campaign.wallet_balance + net_amount
    campaign.save(update_fields=['raised_amount', 'wallet_balance'])

    for treasurer in User.objects.filter(
        church=campaign.church, role=UserRole.CHURCH_TREASURER
    ):
        Notification.objects.create(
            recipient=treasurer,
            notification_type=NotificationType.DONATION_RECEIVED,
            title='Donation received',
            message=(
                f"A donation of KES {net_amount} (net) came in for "
                f"'{campaign.title}'."
            ),
            related_campaign=campaign,
        )

    AuditLog.objects.create(
        actor=None,
        actor_phone=mask_phone(donation.phone_number),
        action='DONATION_CONFIRMED',
        entity_type='Donation',
        entity_id=donation.id,
        details={
            'campaign_id': str(campaign.id),
            'gross': str(gross),
            'platform_fee': str(platform_fee),
            'net_amount': str(net_amount),
            'mpesa_receipt_number': receipt,
            'source': source,
        },
        ip_address=ip_address or None,
    )
    return True


def fail_donation(*, donation, result_code, source, ip_address=None):
    """IDEMPOTENTLY mark a donation FAILED (no money moved). Same caller contract as
    finalize_donation_successful: caller holds the donation lock; this re-checks terminal
    status under it. Returns True if it failed the row, False if already settled. Touches
    ONLY status — never amount/fee/receipt or the campaign balances.
    """
    if donation.status in (DonationStatus.SUCCESSFUL, DonationStatus.FAILED):
        return False

    donation.status = DonationStatus.FAILED
    donation.save(update_fields=['status'])
    AuditLog.objects.create(
        actor=None,
        actor_phone=mask_phone(donation.phone_number),
        action='DONATION_FAILED',
        entity_type='Donation',
        entity_id=donation.id,
        details={
            'campaign_id': str(donation.campaign_id),
            'result_code': str(result_code),
            'source': source,
        },
        ip_address=ip_address or None,
    )
    return True

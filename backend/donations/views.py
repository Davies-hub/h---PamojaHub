"""Donation endpoints (Step 2.10b) — STK push initiate + callback + status poll.

──────────────────────────────────────────────────────────────────────────────
TWO TRAPS, OPPOSITE DIRECTIONS
──────────────────────────────────────────────────────────────────────────────
1. THE CALLBACK IS PUBLIC, UNAUTHENTICATED, AND RETRIED BY SAFARICOM ON ANY
   NON-200. Idempotency is therefore the ONLY thing between a retried callback
   and a double-credit. The check is the FIRST operation inside the handler,
   INSIDE the transaction, BEFORE any balance mutation, keyed on
   `checkout_request_id` which is UNIQUE at the DB level. We SELECT FOR UPDATE
   the donation row (so two concurrent retries serialize), then short-circuit if
   it is already SUCCESSFUL/FAILED. EVERY path returns HTTP 200 — including the
   duplicate and the failure — because a non-200 is exactly what triggers the
   retry storm.

2. THE FEE. The donor enters GROSS. The fee is read from
   PlatformSettings.load().fee_percent LIVE at callback time and BOTH platform_fee
   and net_amount are stored on the row (forward-only fees). PLATFORM_FEE_PERCENT
   in settings/.env is a DECOY — computing from it would make the billing UI's
   rate edit silently cosmetic. Net-Everywhere: raised_amount and wallet_balance
   move by NET; only the donor success screen shows GROSS.

We always credit the SERVER-STORED expected amount (set at initiate), never the
amount in the callback POST body — a forged callback cannot inject an inflated
value, and a callback whose Amount disagrees with the initiate amount is rejected
(not a genuine STK confirmation). Defense-in-depth over the secret callback path.

CHURCH-MUST-BE-ACTIVE: initiate refuses if the campaign's church is not ACTIVE.
This is the money-safety boundary for non-ACTIVE churches that Step 2.9c
explicitly deferred to here — a PENDING/SUSPENDED/REJECTED church must not collect.
"""

import logging
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.utils.decorators import method_decorator
from django_ratelimit.decorators import ratelimit
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from campaigns.models import Campaign, CampaignStatus
from churches.models import ChurchStatus
from common.ratelimit_keys import normalized_phone_key
from donations.models import Donation, DonationStatus
from donations.serializers import (
    DonationInitiateSerializer,
    DonationStatusSerializer,
)
from donations.services import fail_donation, finalize_donation_successful
from integrations.daraja import DarajaClient, STKPushError
from integrations.resend_email import send_donation_receipt


logger = logging.getLogger(__name__)


def _client_ip(request):
    return request.META.get('REMOTE_ADDR') or ''


# ───────────────────── POST /donations/initiate/ ─────────────────────────────


@method_decorator(
    ratelimit(key=normalized_phone_key, rate='10/h', method='POST', block=True),
    name='post',
)
class DonationInitiateView(APIView):
    """POST /api/v1/donations/initiate/ — public, no auth, 10/hour per donor phone.

    Validates input, refuses non-ACTIVE church / non-ACTIVE campaign (money-safety
    boundary), creates a PENDING Donation (amount = GROSS; fee/net stay null until
    the callback), then calls DarajaClient().stk_push(). On STK failure the
    donation stays PENDING with no checkout_request_id — a clear non-confirmed
    state that ages out; it is never marked SUCCESSFUL.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = DonationInitiateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        try:
            campaign = Campaign.objects.select_related('church').get(
                slug=data['campaign_slug']
            )
        except Campaign.DoesNotExist:
            return Response({'detail': 'Campaign not found.'},
                            status=status.HTTP_404_NOT_FOUND)

        # Money-safety boundary (deferred here from 2.9c): a non-ACTIVE church must
        # not collect, and a non-ACTIVE campaign isn't accepting donations.
        if campaign.church.status != ChurchStatus.ACTIVE:
            return Response(
                {'detail': 'This church is not currently able to receive donations.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if campaign.status != CampaignStatus.ACTIVE:
            return Response(
                {'detail': 'This campaign is not currently accepting donations.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # GROSS at initiate; fee/net stay null until the callback confirms.
        donation = Donation.objects.create(
            campaign=campaign,
            phone_number=data['phone_number'],
            donor_name=data.get('donor_name') or None,
            donor_email=data.get('donor_email') or None,
            amount=data['amount'],
            status=DonationStatus.PENDING,
        )

        try:
            result = DarajaClient().stk_push(
                phone=data['phone_number'],
                amount=data['amount'],
                # Byte-identical to the pre-generalization payload: same slug
                # truncation, same 'Donation' desc.
                account_reference=(campaign.slug or 'PamojaHub')[:12],
                transaction_desc='Donation',
            )
        except STKPushError as exc:
            # No money has moved on OUR side. Leave the donation PENDING with NO
            # checkout_request_id — never SUCCESSFUL.
            #
            # DELIBERATE CHOICE for the ambiguous STK ack (Safaricom MAY have
            # queued it but returned no usable CheckoutRequestID): we store no id,
            # so this row is UN-CORRELATABLE — a later success callback carries a
            # real CheckoutRequestID that matches NO donation row, falls into the
            # unknown-id path, and is a 200 no-op. The campaign is therefore NEVER
            # credited for a 502-initiate row, and the donor saw "try again". Row
            # state (PENDING, uncredited) and donor UX (failed) AGREE — there is no
            # silent credit-without-success. The cost is the inverse of B2C's
            # ambiguous case: a possibly-queued STK we can't correlate is left to
            # age out; if Safaricom did charge the donor, reconciling that orphan
            # is an ops / Transaction-Status-query concern (deferred), NOT a
            # double-credit. We never invent a CheckoutRequestID to "rescue" it.
            logger.warning('STK push failed for donation %s: %s', donation.id, exc)
            return Response(
                {'detail': "Couldn't start the M-Pesa payment. Please try again."},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        donation.checkout_request_id = result['checkout_request_id']
        donation.save(update_fields=['checkout_request_id'])

        return Response(
            {
                'donation_id': str(donation.id),
                'checkout_request_id': donation.checkout_request_id,
                'status': donation.status,
            },
            status=status.HTTP_200_OK,
        )


# ───────────────────── POST /donations/callback/ ─────────────────────────────


def _extract_stk_callback(body):
    """Pull (checkout_request_id, result_code, metadata-dict) out of a Daraja STK
    callback body. Defensive — Safaricom shape:
        {"Body": {"stkCallback": {"CheckoutRequestID", "ResultCode",
                                   "CallbackMetadata": {"Item": [{Name, Value}, ...]}}}}
    On failure callbacks there is no CallbackMetadata.
    """
    stk = (body or {}).get('Body', {}).get('stkCallback', {}) or {}
    checkout_id = str(stk.get('CheckoutRequestID') or '').strip()
    result_code = stk.get('ResultCode')
    metadata = {}
    items = (stk.get('CallbackMetadata') or {}).get('Item', []) or []
    for item in items:
        name = item.get('Name')
        if name is not None:
            metadata[name] = item.get('Value')
    return checkout_id, result_code, metadata


class DonationCallbackView(APIView):
    """POST /api/v1/donations/callback/ — Safaricom-called, public, no auth.

    Returns HTTP 200 on EVERY path (success, failure, duplicate, unknown) — a
    non-200 makes Safaricom retry, which against a non-idempotent handler is a
    double-credit. Idempotency is the first in-transaction operation.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        checkout_id, result_code, metadata = _extract_stk_callback(request.data)

        if not checkout_id:
            # Malformed / un-correlatable callback. 200 so Safaricom stops, no-op.
            logger.warning('STK callback with no CheckoutRequestID: %s', request.data)
            return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                            status=status.HTTP_200_OK)

        with transaction.atomic():
            # ── IDEMPOTENCY FIRST (locked, before any mutation) ──────────────
            try:
                donation = (
                    Donation.objects
                    .select_for_update()
                    .select_related('campaign', 'campaign__church')
                    .get(checkout_request_id=checkout_id)
                )
            except Donation.DoesNotExist:
                # Unknown checkout id — nothing to credit. 200, no mutation.
                logger.warning('STK callback for unknown CheckoutRequestID %s', checkout_id)
                return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                                status=status.HTTP_200_OK)

            if donation.status in (DonationStatus.SUCCESSFUL, DonationStatus.FAILED):
                # Already processed (Safaricom retry). Short-circuit, NO mutation.
                return Response({'ResultCode': 0, 'ResultDesc': 'Duplicate ignored'},
                                status=status.HTTP_200_OK)

            # ── First processing of this callback ────────────────────────────
            if str(result_code).strip() != '0':
                # Caller holds the donation lock (select_for_update above); the helper
                # re-checks terminal status under it. Behaviour identical to the old
                # inline FAILED+audit — just shared with the future resolver.
                fail_donation(
                    donation=donation, result_code=result_code,
                    source='callback', ip_address=_client_ip(request),
                )
                return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                                status=status.HTTP_200_OK)

            # SUCCESS. The credited GROSS is the SERVER-STORED expected amount from
            # initiate (donation.amount), NEVER the POST-body Amount — so a forged
            # callback cannot inject an inflated value (the value credited derives
            # only from server state). An STK push charges the EXACT requested
            # amount, so a genuine success callback always echoes that amount; if it
            # carries a DIFFERENT (or unparseable) Amount this is not a real
            # confirmation — refuse to credit, leave the row PENDING for
            # reconciliation, and return 200 (so Safaricom stops retrying).
            expected_gross = donation.amount
            confirmed_amount = metadata.get('Amount')
            if confirmed_amount is not None:
                try:
                    amount_matches = Decimal(str(confirmed_amount)) == expected_gross
                except (InvalidOperation, ValueError, TypeError):
                    amount_matches = False
                if not amount_matches:
                    logger.warning(
                        'STK callback amount %r != expected %s for donation %s — '
                        'refusing credit (possible forgery)',
                        confirmed_amount, expected_gross, donation.id,
                    )
                    return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                                    status=status.HTTP_200_OK)
            gross = expected_gross
            receipt = metadata.get('MpesaReceiptNumber')

            # Caller holds the donation lock (select_for_update above); the shared
            # helper re-checks terminal status under it, reads the fee LIVE, credits NET
            # exactly once, notifies, and audits — identical behaviour to the old inline
            # block, now reusable by a future stuck-donation resolver. Gross/receipt are
            # parsed here because that is callback-shape-specific.
            credited = finalize_donation_successful(
                donation=donation, gross=gross, receipt=receipt,
                source='callback', ip_address=_client_ip(request),
            )

        # Donor receipt — courtesy, OUTSIDE the transaction so the email round-trip
        # holds NO row lock. Only when we actually credited (credited is False on a
        # duplicate callback, so no double receipt) and the donor supplied an email.
        # send_donation_receipt swallows delivery failures; it can never affect the credit.
        if credited and donation.donor_email:
            send_donation_receipt(
                email=donation.donor_email,
                donor_name=donation.donor_name,
                campaign_title=donation.campaign.title,
                amount=gross,
                receipt=receipt,
            )

        return Response({'ResultCode': 0, 'ResultDesc': 'Accepted'},
                        status=status.HTTP_200_OK)


# ───────────────────── GET /donations/{id}/status/ ───────────────────────────


class DonationStatusView(APIView):
    """GET /api/v1/donations/{id}/status/ — public poll target for the donor's
    success screen. DonationStatusSerializer exposes only id/status/receipt/amount
    (GROSS) — NO platform_fee/net_amount/checkout_request_id (Net-Everywhere).
    """

    permission_classes = [AllowAny]

    def get(self, request, id):
        try:
            donation = Donation.objects.get(id=id)
        except Donation.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(DonationStatusSerializer(donation).data,
                        status=status.HTTP_200_OK)

"""Africa's Talking SMS client (Step 2.11) — real send, replacing the stub.

This module owns TWO failure postures, because not every SMS is the same kind of
event (see §14):

  * COURTESY sends — `send_payout_approved`, `send_payout_rejected`. These run
    AFTER a committed money operation (approve/reject). A delivery failure must
    NEVER raise, roll back, or 500 the money op. They are BEST-EFFORT: on failure
    they log with full recipient+event context (a durable, queryable trace for the
    future Celery replay) and return normally. The posture lives HERE, in the seam,
    not at the call site — so no caller can accidentally let an SMS failure break a
    money path.

  * THE OTP send — `send_portal_otp`. This IS the operation: if it fails, the user
    must NOT be told "code sent". It RAISES `SMSDeliveryError` so the calling view
    can surface the failure and tell the user to retry.

Single network seam: `_send_sms()` — the ONLY place this module touches Africa's
Talking. Tests patch exactly this one boundary (mirrors the Daraja `_http_request`
pattern). The real send fires in non-DEBUG too — there is NO no-op guard anymore.
"""

import logging

from django.conf import settings

import africastalking

from common.validators import validate_safaricom_phone

logger = logging.getLogger(__name__)


class SMSDeliveryError(Exception):
    """SMS could not be delivered (transport error or AT did not accept it).

    ONLY the OTP path raises this to its caller. Courtesy sends catch it, log it,
    and swallow it — a courtesy SMS failure must never break the money op it
    follows.
    """


# ── The single network seam ───────────────────────────────────────────────────
def _send_sms(phone: str, message: str) -> None:
    """Send one SMS via Africa's Talking. The ONLY network boundary in this module
    (tests patch exactly this). Normalizes the recipient to the AT-required
    `254XXXXXXXXX` form at the boundary (normalization standing decision), then
    sends and raises `SMSDeliveryError` unless AT accepts the message. Callers
    decide whether to surface or swallow the failure.
    """
    recipient = validate_safaricom_phone(phone)  # → 254XXXXXXXXX at the boundary

    # The Africa's Talking SDK validates recipients as E.164 with a LEADING '+'
    # ('+254XXXXXXXXX') and rejects the bare 254… form with "Invalid phone number"
    # before any network call (proven live: a 502 on the real OTP path). Add the '+'
    # SOLELY for the SDK call — storage, lookup, rate-limit keys and Daraja all keep
    # the bare 254… normalization. strip-then-re-add guarantees exactly one '+' (never
    # '++') even if a caller's value already carried one.
    sdk_recipient = '+' + recipient.lstrip('+')

    africastalking.initialize(settings.AT_USERNAME, settings.AT_API_KEY)
    try:
        resp = africastalking.SMS.send(message, [sdk_recipient])
    except Exception as exc:  # SDK/transport failure — never reached AT, or no ack
        raise SMSDeliveryError(
            f"Africa's Talking send failed for {recipient}: {exc}"
        ) from exc

    # AT shape: {'SMSMessageData': {'Recipients': [{'status': 'Success', 'statusCode': 101, ...}]}}
    recipients = (resp or {}).get('SMSMessageData', {}).get('Recipients', [])
    if not recipients:
        raise SMSDeliveryError(
            f"Africa's Talking returned no recipients for {recipient}: {resp!r}"
        )
    status_text = str(recipients[0].get('status', '')).strip().lower()
    if status_text != 'success':
        raise SMSDeliveryError(
            f"Africa's Talking did not accept SMS for {recipient}: "
            f"status={recipients[0].get('status')!r} code={recipients[0].get('statusCode')!r}"
        )


# ── OTP — THE OPERATION (surfaces failure) ─────────────────────────────────────
def send_portal_otp(phone: str, otp: str) -> None:
    """Send the plaintext 6-digit OTP to the Campaign Treasurer.

    On failure RAISES `SMSDeliveryError` — a failed OTP is a failed operation, not
    a courtesy; the calling view must NOT report "code sent" when it wasn't.

    SECURITY: the OTP is plaintext here — once. The caller MUST persist only the
    SHA-256 hash (`CampaignTreasurerOTP.otp_code`) and MUST NOT return the OTP in
    any API response.
    """
    _send_sms(
        phone,
        f"Your Pamoja Hub verification code is {otp}. It expires in 10 minutes.",
    )


# ── COURTESY sends (best-effort; never raise) ──────────────────────────────────
def send_payout_approved(phone: str, amount, campaign_title: str) -> None:
    """Notify the Campaign Treasurer (no account) that the payout was approved.

    BEST-EFFORT: runs after a committed approve. On failure, log with full
    context and return — NEVER raise. The money op is authoritative.
    """
    message = (
        f"Your Pamoja Hub payout of KES {amount} for '{campaign_title}' has been "
        f"approved and is being processed."
    )
    try:
        _send_sms(phone, message)
    except Exception:
        # logger.exception → stack + the structured fields below identify the
        # recipient + event for a future Celery replay (durable failure trace).
        logger.exception(
            "[sms-failed][payout-approved] recipient=%s amount=%s campaign=%s "
            "— money op already committed; SMS NOT delivered, needs replay",
            phone, amount, campaign_title,
        )


def send_payout_rejected(phone: str, campaign_title: str, reason: str) -> None:
    """Notify the Campaign Treasurer that the payout was rejected, with reason.

    BEST-EFFORT: runs after a committed reject. On failure, log with full
    context and return — NEVER raise.
    """
    message = (
        f"Your Pamoja Hub payout for '{campaign_title}' was rejected: {reason}"
    )
    try:
        _send_sms(phone, message)
    except Exception:
        logger.exception(
            "[sms-failed][payout-rejected] recipient=%s campaign=%s reason=%s "
            "— money op already committed; SMS NOT delivered, needs replay",
            phone, campaign_title, reason,
        )

"""Resend transactional email client (Step 2.12) — real send, replacing the stub.

Structurally identical to the 2.11 Africa's Talking client: ONE network seam,
two failure postures encoded IN the seam functions (not at call sites, so no
caller can let an email failure break a committed operation).

  * COURTESY sends — `send_password_changed`, `send_registration_approved`,
    `send_registration_rejected` — run AFTER a committed operation. They wrap the
    seam in a TYPED `except EmailDeliveryError` (NOT bare except — programming
    errors still propagate), log with the recipient MASKED (PRD §12.10), and
    return. Never raise, never roll back, never 500 the caller.

  * THE OTP/operation send — `send_password_reset_otp` — IS the operation. On
    failure it RAISES `EmailDeliveryError`; the calling view surfaces it (502) so
    the user is never told "reset email sent" when it wasn't.

EMAIL WRINKLE (see §14): `send_registration_rejected` is the SOLE human-readable
channel carrying the rejection reason to the rejected treasurer (login returns
`church_status='REJECTED'` but NOT the reason; the reason otherwise lives only in
Super-Admin-only AuditLog.details). So it stays non-raising (the reject op is
committed and must not roll back), but its failure is logged at ERROR with an
explicit "reason NOT delivered" trace — elevated above ordinary courtesy noise —
flagging that the treasurer never learned why. A robust fix (persist the reason so
login carries it) is proposed separately, not assumed here.

Single network seam: `_send_email()`. Tests patch exactly this one boundary; the
real send fires in non-DEBUG too — there is NO no-op guard anymore.
"""

import html
import logging

from django.conf import settings

import resend

from common.masking import mask_email

logger = logging.getLogger(__name__)


class EmailDeliveryError(Exception):
    """Email could not be delivered (transport error or Resend did not accept it).

    ONLY the OTP path raises this to its caller. Courtesy sends catch THIS type
    specifically (typed except, not bare), log it (masked), and swallow it.
    """


# ── The single network seam ───────────────────────────────────────────────────
def _send_email(to: str, subject: str, html: str) -> None:
    """Send one email via Resend. The ONLY network boundary in this module (tests
    patch exactly this). Raises `EmailDeliveryError` on transport failure or if
    Resend does not return a message id. Callers decide surface-vs-swallow.
    """
    resend.api_key = settings.RESEND_API_KEY
    try:
        resp = resend.Emails.send({
            'from': settings.RESEND_FROM_EMAIL,
            'to': [to],
            'subject': subject,
            'html': html,
        })
    except Exception as exc:  # SDK/transport failure — never accepted by Resend
        raise EmailDeliveryError(
            f'Resend send failed for {mask_email(to)}: {exc}'
        ) from exc

    # Resend returns {'id': '<uuid>'} on success.
    if not resp or not resp.get('id'):
        raise EmailDeliveryError(
            f'Resend returned no message id for {mask_email(to)}: {resp!r}'
        )


# ── OTP / operation — surfaces failure ─────────────────────────────────────────
def send_password_reset_otp(email: str, otp: str) -> None:
    """Deliver the plaintext password-reset OTP to the user.

    On failure RAISES `EmailDeliveryError` — a failed reset email is a failed
    operation; the calling view must NOT report "reset email sent" when it wasn't.

    SECURITY: the OTP is plaintext here — once. The caller must NEVER return it in
    an API response or persist it (only the hash goes in PasswordResetOTP.otp_hash).
    """
    _send_email(
        email,
        'Your Pamoja Hub password reset code',
        f'<p>Your Pamoja Hub password reset code is <strong>{otp}</strong>. '
        f'It expires in 15 minutes.</p>'
        f'<p>If you did not request this, you can ignore this email.</p>',
    )


# ── COURTESY sends (typed except; masked log; never raise) ─────────────────────
def send_password_changed(email: str) -> None:
    """Post-reset confirmation — 'your password was changed'. BEST-EFFORT: runs
    after the committed password change; on failure log (masked) and return."""
    try:
        _send_email(
            email,
            'Your Pamoja Hub password was changed',
            '<p>Your Pamoja Hub password was just changed. If this was not you, '
            'contact support immediately.</p>',
        )
    except EmailDeliveryError:
        logger.exception(
            '[email-failed][password-changed] recipient=%s '
            '— password already changed; confirmation email NOT delivered, needs replay',
            mask_email(email),
        )


def send_registration_approved(email: str, church_name: str) -> None:
    """Notify a Church Treasurer their registration was approved. BEST-EFFORT:
    runs after the committed approve; on failure log (masked) and return."""
    try:
        _send_email(
            email,
            'Your Pamoja Hub church registration was approved',
            f'<p>Good news — <strong>{html.escape(church_name)}</strong> has been approved on '
            f'Pamoja Hub. You can now sign in and start creating campaigns.</p>',
        )
    except EmailDeliveryError:
        logger.exception(
            '[email-failed][registration-approved] recipient=%s church=%s '
            '— church already approved; email NOT delivered, needs replay',
            mask_email(email), church_name,
        )


def send_registration_rejected(email: str, church_name: str, reason: str) -> None:
    """Notify a Church Treasurer their registration was rejected, WITH the reason.

    BEST-EFFORT: runs after the committed reject; on failure log (masked) and
    return. As of Step 2.12b the reason is ALSO persisted on
    `Church.rejection_reason` and surfaced in the rejected treasurer's login
    response, so this email is NO LONGER the sole channel — a delivery failure is
    genuinely cosmetic (ordinary courtesy logging, not the former elevated
    SOLE-REASON-CHANNEL flare). The free-text reason is not written to the log.
    """
    try:
        _send_email(
            email,
            'Update on your Pamoja Hub church registration',
            f'<p>Your registration for <strong>{html.escape(church_name)}</strong> on Pamoja Hub '
            f'was not approved.</p><p>Reason: {html.escape(reason)}</p>'
            f'<p>You can correct the issue and re-register, or reply for help.</p>',
        )
    except EmailDeliveryError:
        logger.exception(
            '[email-failed][registration-rejected] recipient=%s church=%s '
            '— church already rejected; email NOT delivered, needs replay '
            '(reason also available via login, so not the sole channel)',
            mask_email(email), church_name,
        )


def send_registration_received(email: str, church_name: str) -> None:
    """Acknowledge a just-submitted church registration ("we got your application").

    BEST-EFFORT: runs after the committed register (church is PENDING); on failure
    log (masked) and return — a missed acknowledgement must never roll back or 500
    the registration. This is the onboarding email; approval/rejection come later.
    """
    try:
        _send_email(
            email,
            'We received your Pamoja Hub registration',
            f'<p>Thanks for registering <strong>{html.escape(church_name)}</strong> on Pamoja Hub.</p>'
            f'<p>Your application is now under review. We will email you as soon as a '
            f'Super Admin approves it, and then you can sign in and create campaigns.</p>',
        )
    except EmailDeliveryError:
        logger.exception(
            '[email-failed][registration-received] recipient=%s church=%s '
            '— church already registered (PENDING); acknowledgement NOT delivered, '
            'needs replay', mask_email(email), church_name,
        )


def send_donation_receipt(email: str, donor_name, campaign_title: str,
                          amount, receipt) -> None:
    """Send a donor a receipt for a confirmed donation. BEST-EFFORT: runs after the
    donation is credited (M-Pesa callback) and OUTSIDE the credit transaction, so a
    failure never affects the money path. Only called when the donor supplied an email.

    `amount` is the GROSS the donor paid (matches the M-Pesa SMS); `receipt` is the
    M-Pesa receipt number. donor_name is optional.
    """
    greeting = f'Hello {html.escape(donor_name)},' if donor_name else 'Hello,'
    try:
        _send_email(
            email,
            'Your Pamoja Hub donation receipt',
            f'<p>{greeting}</p>'
            f'<p>Thank you for your donation of <strong>KES {amount}</strong> to '
            f"'{html.escape(campaign_title)}'.</p>"
            f'<p>M-Pesa receipt: <strong>{html.escape(str(receipt))}</strong></p>'
            f'<p>Every shilling is on record. God bless you.</p>',
        )
    except EmailDeliveryError:
        logger.exception(
            '[email-failed][donation-receipt] recipient=%s campaign=%s receipt=%s '
            '— donation already credited; receipt email NOT delivered, needs replay',
            mask_email(email), campaign_title, receipt,
        )


def send_payout_approved_email(email: str, amount, campaign_title: str) -> None:
    """Email the Church Treasurer's account that a payout was approved. BEST-EFFORT:
    runs after the committed approve (alongside the Campaign-Treasurer SMS); on
    failure log (masked) and return."""
    try:
        _send_email(
            email,
            'Your Pamoja Hub payout was approved',
            f'<p>A payout of <strong>KES {amount}</strong> for '
            f"'{html.escape(campaign_title)}' has been approved and is being processed.</p>",
        )
    except EmailDeliveryError:
        logger.exception(
            '[email-failed][payout-approved] recipient=%s campaign=%s '
            '— payout already approved; email NOT delivered, needs replay',
            mask_email(email), campaign_title,
        )


def send_payout_rejected_email(email: str, campaign_title: str, reason: str) -> None:
    """Email the Church Treasurer's account that a payout was rejected, WITH the
    reason. BEST-EFFORT: runs after the committed reject; on failure log (masked)
    and return. The free-text reason is not written to the log."""
    try:
        _send_email(
            email,
            'Your Pamoja Hub payout was rejected',
            f"<p>Your payout for '{html.escape(campaign_title)}' was not approved.</p>"
            f'<p>Reason: {html.escape(reason)}</p>'
            f'<p>You can submit a new payout request, or reply for help.</p>',
        )
    except EmailDeliveryError:
        logger.exception(
            '[email-failed][payout-rejected] recipient=%s campaign=%s '
            '— payout already rejected; email NOT delivered, needs replay',
            mask_email(email), campaign_title,
        )

"""Phone masking for forensic surfaces (PRD §12.10).

AuditLog.details is forensic — entries are reviewed by Super Admin and may be
exported. Storing raw phone numbers there leaks PII unnecessarily; the full
phone is already on the related row (Withdrawal.destination_phone, etc.) and
can be looked up by entity_id when needed. The audit log itself should carry
masked forms only.

PRD §12.10 reconciliation: an earlier draft kept the first 6 digits + last 3,
masking only the middle 3 of a 12-digit number — that exposes the country code,
the full operator prefix, AND most of the subscriber identifier (e.g.
'254712345678' → '254712***678' leaks 9 of 12 digits). That is NOT redaction.
The PRD shape protects the SUBSCRIBER IDENTITY: only a short tail is shown so a
reviewer can spot-check "is this the same account I expect?" without the number
being reconstructable or harvestable. We therefore mask EVERYTHING except the
last 3 digits.

NOTE: this mask is for STORAGE in AuditLog.details. The Withdrawal model still
stores the FULL phone (destination_phone, requested_by_phone) because the B2C
dispatch needs the exact number. The frontend masking pattern in
DisbursementApprovalDialog is a UX concern, separate from this.
"""


def mask_phone(phone) -> str:
    """Mask a phone for AuditLog.details storage — hides ALL but the last 3 digits.

    Examples:
      ''                  → ''
      '0712345678'        → '*******678'   (hides 7 of 10)
      '254712345678'      → '*********678'  (hides 9 of 12)
      '+254712345678'     → '**********678' (hides 10 of 13, '+' masked too)

    For strings of length <= 3 the whole value is masked. Never raises —
    receives any value, returns a string. None / non-string inputs return ''.

    Why last-3-only is sufficient (PRD §12.10): a 254-normalised Kenyan number
    is country-code(3) + operator-prefix(3) + subscriber(6). Showing only the
    trailing 3 reveals none of the country code, none of the operator prefix,
    and only the final 3 of the 6 subscriber digits — 1-in-1000 collision space
    for a spot-check, but useless for reconstruction or bulk harvesting. The
    full number remains on the entity row (reachable via entity_id) for the
    rare case a reviewer needs it.
    """
    if not phone:
        return ''
    s = str(phone).strip()
    if len(s) <= 3:
        return '*' * len(s)
    return '*' * (len(s) - 3) + s[-3:]


def mask_email(email) -> str:
    """Mask an email for log/forensic storage — same PRD §12.10 discipline as
    mask_phone: protect subscriber identity, keep just enough for a reviewer to
    spot-check. Shows the FIRST char of the local part + the full domain, masks
    the rest of the local part.

    Examples:
      ''                     → ''
      'john.doe@example.org' → 'j*******@example.org'
      'a@example.org'        → '*@example.org'
      'notanemail'           → '*******ail'   (no '@' → last-3 like a generic secret)

    Never raises — any value in, string out. None / non-string → ''.
    """
    if not email:
        return ''
    s = str(email).strip()
    if '@' not in s:
        if len(s) <= 3:
            return '*' * len(s)
        return '*' * (len(s) - 3) + s[-3:]
    local, _, domain = s.partition('@')
    masked_local = (local[0] + '*' * (len(local) - 1)) if len(local) > 1 else '*' * len(local)
    return f'{masked_local}@{domain}'

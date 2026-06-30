"""Shared input validators: Safaricom phone normalization, positive amount."""

import re

from rest_framework.exceptions import ValidationError


# Accepts Safaricom 07xx and the 01xx range. Normalizes to 254XXXXXXXXX.
# NOTE: 01xx-range numbers are largely NON-Safaricom (Airtel/Telkom). They pass
# validation for frontend/backend consistency, but M-Pesa STK push and B2C may
# REJECT them at the Daraja layer. The decision to hard-reject non-Safaricom
# prefixes is deferred to Phase 4, when Daraja is live and we can test what
# actually works. Do not hard-reject 01xx here.
SAFARICOM_PATTERN = re.compile(
    r'^(?:254|\+254|0)'
    r'(?:7(?:[0-2][0-9]|[4][0-3]|[4][5]|[4][8]|[5][7-9]|[6][8-9]|[9][0-9])'
    r'|1(?:[0][0-9]|[1][0-9]))\d{6}$'
)


def validate_safaricom_phone(value: str) -> str:
    """Validates and normalizes a Kenyan mobile number to 254XXXXXXXXX format."""
    if value is None:
        raise ValidationError("Phone number is required.")
    clean = value.strip().replace(' ', '').replace('-', '')
    if not SAFARICOM_PATTERN.match(clean):
        raise ValidationError("Enter a valid Kenyan mobile number (07xx or 01xx format).")
    if clean.startswith('0'):
        clean = '254' + clean[1:]
    elif clean.startswith('+'):
        clean = clean[1:]
    return clean


def validate_positive_amount(value):
    if value <= 0:
        raise ValidationError("Amount must be greater than zero.")
    if value < 5:
        raise ValidationError("Minimum donation amount is KES 5.")
    return value

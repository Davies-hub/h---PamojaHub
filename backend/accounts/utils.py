"""Shared hashing + OTP helpers. Used by auth views (refresh tokens, password-reset
OTPs) and will be reused by the Step 2.8 portal-token flow.

Tokens and OTPs are NEVER stored in plaintext. The caller hashes via hash_token() and
persists the hash; the plaintext is returned to the client (refresh token) or sent via
email (reset OTP) once and never again.
"""

import hashlib
import secrets


def hash_token(raw: str) -> str:
    """SHA-256 hex digest of `raw`. Length is 64 chars (matches the CharField widths
    on RefreshToken.token_hash, PasswordResetOTP.otp_hash, PortalToken.token_hash,
    CampaignTreasurerOTP.otp_code).
    """
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def generate_otp() -> str:
    """Cryptographically secure 6-digit numeric OTP. Returns plaintext; the caller
    must hash_token(...) it for storage and send the plaintext via email exactly once.

    Uses secrets.randbelow (CSPRNG), not random — random is seeded from system time
    and can be predicted. The leading zeros are preserved by zfill.
    """
    return str(secrets.randbelow(1_000_000)).zfill(6)

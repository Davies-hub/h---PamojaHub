"""Custom django-ratelimit key callables.

Why this exists: `@ratelimit(key='post:phone_number', ...)` keys on the RAW post
field. `0712345678`, `254712345678`, `+254712345678`, and `' 0712345678 '` are
four distinct raw strings that normalize to the same number — without
normalization at the key layer, an attacker multiplies their OTP / verify budget
by submitting format variants of the same real phone. The phone-keyed rate limit
is the highest-value rate-limit target in the system (SMS cost + brute-force
ceiling on the portal); the bypass closes that hole.
"""

import json


def normalized_phone_key(group, request):
    """Rate-limit key that normalizes the phone before keying.

    All format variants of one real phone (0712..., 254712..., +254712..., padded
    or punctuated) map to ONE bucket. Falls back to a cleaned raw form if the
    phone is invalid — so malformed inputs still get rate-limited (by their
    cleaned raw value), they just don't all collide into one mega-bucket. We
    deliberately do NOT collapse all invalid inputs to a single key, because
    that would let an attacker flood the limiter at the cost of *other*
    attackers' invalid-input requests rather than their own; keying on the
    cleaned raw form keeps each invalid-format request type independently
    limited.

    Reads phone_number from THREE sources in priority order:
      1. request.data       — works for DRF views once the request has been
                              wrapped (it has been by the time @method_decorator
                              -applied ratelimit fires on a DRF dispatch path).
      2. request.POST       — form-encoded fallback.
      3. JSON-parsed body   — last-resort body parse for the (uncommon) case
                              where request.data isn't populated yet.
    """
    raw = ''
    if hasattr(request, 'data'):
        try:
            raw = request.data.get('phone_number', '') or ''
        except Exception:
            raw = ''
    if not raw:
        try:
            raw = request.POST.get('phone_number', '') or ''
        except Exception:
            raw = ''
    if not raw:
        try:
            body = json.loads(request.body or b'{}')
            if isinstance(body, dict):
                raw = body.get('phone_number', '') or ''
        except Exception:
            raw = ''

    try:
        from common.validators import validate_safaricom_phone
        return validate_safaricom_phone(raw)
    except Exception:
        # Invalid phone — key on a cleaned raw form. Strip whitespace/dashes so
        # `' 0712 '` and `0712` (both invalid) don't get separate budgets.
        return (raw or '').strip().replace(' ', '').replace('-', '')

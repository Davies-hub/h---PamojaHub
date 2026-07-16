"""DEBUG-only Daraja callback SIMULATOR — demo/dev trigger, never mounted in prod.

Shapes synthesized from §14.1 prose + extractor docstrings; the 2026-07-09 live
capture is unrecoverable. This proves handler behavior against our best shape
model, NOT the live wire.

Shape sources (all prose, no verbatim capture survives):
  * STK: the `_extract_stk_callback` docstring (donations/views.py) +
    PamojaHub_Compressed_v2.md §14.1 live facts — numeric `Amount`,
    numeric `TransactionDate`/`PhoneNumber`, and a `{"Name": "Balance"}`
    metadata item with NO `Value` key (the live signature); failure
    callbacks carry NO `CallbackMetadata` at all.
  * B2C: the `_extract_b2c_result` docstring (withdrawals/views.py) +
    the real 2040 ResultDesc recorded in §14.1.

Delivery is FRONT-DOOR ONLY: bodies are POSTed through the full URL router
via django.test.Client to the reverse()'d real callback routes — the secret
path segment included — never by calling a view/handler directly. So the
simulator exercises routing (incl. the PH2-01 secret 404 wall), middleware,
parsing, idempotency, and the amount cross-check exactly as Safaricom would.

This module is imported ONLY from the `if settings.DEBUG:` block in
config/urls.py; with DEBUG=False it is never imported and the trigger route
does not exist (same pattern as /api/v1/dev/reset-ratelimit/).
"""

import json
import random
import string
from datetime import datetime
from decimal import Decimal

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

SIM_RECEIPT_PREFIX = 'SIM-'

# Real ResultDescs recorded on the live wire (§14.1 / AuditLog result codes).
_STK_FAILURE_DESCS = {
    1032: 'Request cancelled by user',
    1037: 'DS timeout user cannot be reached',
}
_B2C_FAILURE_DESCS = {
    2040: "Credit Party customer type (Unregistered or Registered Customer) "
          "can't be supported by the service",
}


def sim_receipt():
    """'SIM-' + 8 upper-alnum — unmistakably synthetic, unique enough per demo."""
    return SIM_RECEIPT_PREFIX + ''.join(
        random.choices(string.ascii_uppercase + string.digits, k=8))


def _numeric(value):
    """Daraja emits money/date/phone values as JSON NUMBERS (live: Amount=5,
    not "5"). Whole values become int (matching the live capture), else float."""
    d = Decimal(str(value))
    return int(d) if d == d.to_integral_value() else float(d)


# ═════════════════════════════════════════════════════════════════════════════
# Payload builders — pure functions, unit-tested by tests/test_dev_simulator.py
# ═════════════════════════════════════════════════════════════════════════════


def build_stk_success(checkout_id, amount, msisdn, receipt=None):
    """Synthesized Safaricom STK SUCCESS callback body (ResultCode 0)."""
    return {'Body': {'stkCallback': {
        'MerchantRequestID': 'sim-mr-1',
        'CheckoutRequestID': checkout_id,
        'ResultCode': 0,
        'ResultDesc': 'The service request is processed successfully.',
        'CallbackMetadata': {'Item': [
            {'Name': 'Amount', 'Value': _numeric(amount)},
            {'Name': 'MpesaReceiptNumber', 'Value': receipt or sim_receipt()},
            # Live signature: the Balance item arrives with NO 'Value' key.
            {'Name': 'Balance'},
            {'Name': 'TransactionDate',
             'Value': int(datetime.now().strftime('%Y%m%d%H%M%S'))},
            {'Name': 'PhoneNumber', 'Value': int(msisdn)},
        ]},
    }}}


def build_stk_failure(checkout_id, result_code=1032):
    """Synthesized STK FAILURE callback — no CallbackMetadata (live fact)."""
    code = int(result_code)
    return {'Body': {'stkCallback': {
        'MerchantRequestID': 'sim-mr-1',
        'CheckoutRequestID': checkout_id,
        'ResultCode': code,
        'ResultDesc': _STK_FAILURE_DESCS.get(code, 'The service request failed.'),
    }}}


def build_b2c_result_success(conversation_id, originator_id, amount,
                             transaction_id=None):
    """Synthesized B2C Result SUCCESS body (ResultCode 0)."""
    tx = transaction_id or sim_receipt()
    return {'Result': {
        'ResultType': 0,
        'ResultCode': 0,
        'ResultDesc': 'The service request is processed successfully.',
        'OriginatorConversationID': originator_id,
        'ConversationID': conversation_id,
        'TransactionID': tx,
        'ResultParameters': {'ResultParameter': [
            {'Key': 'TransactionAmount', 'Value': _numeric(amount)},
            {'Key': 'TransactionReceipt', 'Value': tx},
        ]},
    }}


def build_b2c_result_failure(conversation_id, originator_id, result_code=2040):
    """Synthesized B2C Result FAILURE body (default: the real sandbox 2040)."""
    code = int(result_code)
    return {'Result': {
        'ResultType': 0,
        'ResultCode': code,
        'ResultDesc': _B2C_FAILURE_DESCS.get(code, 'The service request failed.'),
        'OriginatorConversationID': originator_id,
        'ConversationID': conversation_id,
    }}


# ═════════════════════════════════════════════════════════════════════════════
# Front-door dispatch
# ═════════════════════════════════════════════════════════════════════════════


def deliver_callback(body, route_name):
    """POST a built body through the FULL URL router (secret path included) via
    an in-process django.test.Client — never the view directly. SERVER_NAME is
    pinned to 127.0.0.1 because dev ALLOWED_HOSTS has no 'testserver'."""
    from django.test import Client
    from django.urls import reverse

    client = Client(SERVER_NAME='127.0.0.1')
    return client.post(reverse(route_name), data=json.dumps(body),
                       content_type='application/json')


# ═════════════════════════════════════════════════════════════════════════════
# Trigger view — POST /api/v1/dev/simulate-callback/ (mounted only when DEBUG)
# ═════════════════════════════════════════════════════════════════════════════

_KINDS = ('stk_success', 'stk_failure', 'b2c_success', 'b2c_failure')


def _pick(qs, row_id, order_field):
    """Latest candidate row, or the explicit pk. None on bad/absent id."""
    from django.core.exceptions import ValidationError
    try:
        if row_id:
            return qs.filter(pk=row_id).first()
        return qs.order_by(f'-{order_field}').first()
    except (ValidationError, ValueError):
        return None


@csrf_exempt
def simulate_callback(request):
    if request.method != 'POST':
        return JsonResponse({'detail': 'POST only.'}, status=405)
    try:
        params = json.loads(request.body or b'{}')
    except json.JSONDecodeError:
        return JsonResponse({'detail': 'Body must be JSON.'}, status=400)

    kind = params.get('kind')
    if kind not in _KINDS:
        return JsonResponse(
            {'detail': f"kind must be one of {'|'.join(_KINDS)}."}, status=400)

    row_id = params.get('id')

    if kind.startswith('stk_'):
        from donations.models import Donation, DonationStatus

        qs = Donation.objects.exclude(checkout_request_id=None)
        if not row_id:
            qs = qs.filter(status=DonationStatus.PENDING)
        target = _pick(qs, row_id, 'created_at')
        if target is None or not target.checkout_request_id:
            return JsonResponse(
                {'detail': 'No candidate donation — need a PENDING row with a '
                           'stored checkout_request_id.'}, status=404)

        status_before = target.status
        receipt = None
        if kind == 'stk_success':
            receipt = sim_receipt()
            # amount_override exists ONLY to demo the handler's forgery
            # refusal (amount-mismatch -> refuse credit, row stays PENDING).
            # Never use it to make a demo "pass".
            amount = params.get('amount_override', target.amount)
            body = build_stk_success(target.checkout_request_id, amount,
                                     target.phone_number, receipt=receipt)
        else:
            body = build_stk_failure(target.checkout_request_id,
                                     params.get('result_code', 1032))
        resp = deliver_callback(body, 'donation-callback')
        target.refresh_from_db()
    else:
        from withdrawals.models import Withdrawal, WithdrawalStatus

        qs = (Withdrawal.objects
              .exclude(b2c_conversation_id=None).exclude(b2c_conversation_id=''))
        if not row_id:
            # PROCESSING is the dispatched-awaiting-result status (trace 1c).
            qs = qs.filter(status=WithdrawalStatus.PROCESSING)
        target = _pick(qs, row_id, 'updated_at')
        if target is None or not target.b2c_conversation_id:
            return JsonResponse(
                {'detail': 'No candidate withdrawal — need a PROCESSING row '
                           'with a stored b2c_conversation_id.'}, status=404)

        status_before = target.status
        receipt = None
        if kind == 'b2c_success':
            receipt = sim_receipt()
            body = build_b2c_result_success(
                target.b2c_conversation_id,
                target.originator_conversation_id or '',
                target.amount, transaction_id=receipt)
        else:
            body = build_b2c_result_failure(
                target.b2c_conversation_id,
                target.originator_conversation_id or '',
                params.get('result_code', 2040))
        resp = deliver_callback(body, 'withdrawal-b2c-result')
        target.refresh_from_db()

    return JsonResponse({
        'kind': kind,
        'target_id': str(target.id),
        'handler_status': resp.status_code,
        'status_before': status_before,
        'status_after': target.status,
        'simulated_receipt': receipt,
    })

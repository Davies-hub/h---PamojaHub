"""Step 2.10a — DarajaClient seam tests.

These exercise the REAL b2c_payout / get_access_token code paths and mock ONLY
the HTTP boundary (DarajaClient._http_request). They pin the synchronous-ack vs
asynchronous-result contract — and, critically, the CLEAN vs AMBIGUOUS split
that 2.10c's double-pay defense depends on:

  CLEAN (provably never queued → safe to re-dispatch) — B2CDispatchCleanError:
    * connection error / timeout (request never landed)
    * non-200 HTTP status
    * OAuth / token acquisition failure

  AMBIGUOUS (may be queued → must verify before retry) — B2CDispatchAmbiguousError:
    * 200 + non-zero ResponseCode
    * 200 + ResponseCode '0' but missing/empty ConversationID
    * 200 + unparseable body

  SUCCESS — 200 + ResponseCode '0' + ConversationID → {'conversation_id': ...}.

No DB needed — b2c_payout reads only attributes off the passed object, so a
SimpleNamespace stands in for a Withdrawal. SimpleTestCase keeps these fast.
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
import uuid

import requests
from django.test import SimpleTestCase

from integrations import daraja
from integrations.daraja import (
    B2CDispatchAmbiguousError,
    B2CDispatchCleanError,
    B2CDispatchError,
    DarajaClient,
    STKQueryOutcome,
)


class _FakeResponse:
    def __init__(self, status_code=200, json_body=None, json_raises=False):
        self.status_code = status_code
        self._json_body = json_body if json_body is not None else {}
        self._json_raises = json_raises

    def json(self):
        if self._json_raises:
            raise ValueError('No JSON object could be decoded')
        return self._json_body


_OAUTH_OK = {'access_token': 'TEST-TOKEN', 'expires_in': '3599'}
_B2C_ACK_OK = {
    'ConversationID': 'AG_20260601_SEAM',
    'OriginatorConversationID': 'OC_SEAM',
    'ResponseCode': '0',
    'ResponseDescription': 'Accept the service request successfully.',
}


def _seam(*, b2c_response=None, b2c_exc=None, oauth_response=None):
    def _fake(method, url, **kwargs):
        if 'oauth' in url:
            return oauth_response if oauth_response is not None else _FakeResponse(200, _OAUTH_OK)
        if b2c_exc is not None:
            raise b2c_exc
        return b2c_response if b2c_response is not None else _FakeResponse(200, _B2C_ACK_OK)
    return _fake


def _fake_withdrawal():
    return SimpleNamespace(
        id=uuid.uuid4(),
        amount=Decimal('1000.00'),
        destination_phone='254712345678',
        reason='Builders payment',
        originator_conversation_id='pmj-test-originator',
        payout_reference=None,
    )


class B2CPayoutSeamTests(SimpleTestCase):
    def setUp(self):
        daraja._clear_token_cache()

    def test_valid_ack_returns_conversation_id(self):
        with patch.object(DarajaClient, '_http_request', side_effect=_seam()):
            result = DarajaClient().b2c_payout(_fake_withdrawal())
        self.assertEqual(result, {'conversation_id': 'AG_20260601_SEAM'})

    # ── CLEAN (provably never queued) ──────────────────────────────────────────

    def test_connection_error_is_clean(self):
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=_seam(b2c_exc=requests.ConnectionError('boom')),
        ):
            with self.assertRaises(B2CDispatchCleanError):
                DarajaClient().b2c_payout(_fake_withdrawal())

    def test_timeout_is_clean(self):
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=_seam(b2c_exc=requests.Timeout('slow')),
        ):
            with self.assertRaises(B2CDispatchCleanError):
                DarajaClient().b2c_payout(_fake_withdrawal())

    def test_non_200_is_clean(self):
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=_seam(b2c_response=_FakeResponse(500, {'error': 'x'})),
        ):
            with self.assertRaises(B2CDispatchCleanError):
                DarajaClient().b2c_payout(_fake_withdrawal())

    # ── AMBIGUOUS (may be queued) ──────────────────────────────────────────────

    def test_non_zero_response_code_is_ambiguous(self):
        """200 but ResponseCode != '0' → Daraja received it; may be queued."""
        body = {'ConversationID': 'AG_X', 'ResponseCode': '1', 'ResponseDescription': 'rejected'}
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=_seam(b2c_response=_FakeResponse(200, body)),
        ):
            with self.assertRaises(B2CDispatchAmbiguousError):
                DarajaClient().b2c_payout(_fake_withdrawal())

    def test_missing_conversation_id_is_ambiguous(self):
        """200 + ResponseCode '0' but no ConversationID → may be queued, no id
        to correlate. We must NOT invent or guess a conversation_id.
        """
        body = {'ResponseCode': '0', 'ResponseDescription': 'ok but no id'}
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=_seam(b2c_response=_FakeResponse(200, body)),
        ):
            with self.assertRaises(B2CDispatchAmbiguousError):
                DarajaClient().b2c_payout(_fake_withdrawal())

    def test_empty_conversation_id_is_ambiguous(self):
        body = {'ConversationID': '   ', 'ResponseCode': '0'}
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=_seam(b2c_response=_FakeResponse(200, body)),
        ):
            with self.assertRaises(B2CDispatchAmbiguousError):
                DarajaClient().b2c_payout(_fake_withdrawal())

    def test_unparseable_body_is_ambiguous(self):
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=_seam(b2c_response=_FakeResponse(200, json_raises=True)),
        ):
            with self.assertRaises(B2CDispatchAmbiguousError):
                DarajaClient().b2c_payout(_fake_withdrawal())

    def test_subclasses_are_caught_by_base(self):
        """A broad `except B2CDispatchError` still catches both classes."""
        self.assertTrue(issubclass(B2CDispatchCleanError, B2CDispatchError))
        self.assertTrue(issubclass(B2CDispatchAmbiguousError, B2CDispatchError))


class AccessTokenTests(SimpleTestCase):
    def setUp(self):
        daraja._clear_token_cache()

    def test_token_is_cached_after_first_fetch(self):
        """Second call within lifetime must NOT hit the OAuth endpoint again."""
        oauth_calls = {'n': 0}

        def _fake(method, url, **kwargs):
            if 'oauth' in url:
                oauth_calls['n'] += 1
                return _FakeResponse(200, _OAUTH_OK)
            return _FakeResponse(200, _B2C_ACK_OK)

        with patch.object(DarajaClient, '_http_request', side_effect=_fake):
            t1 = DarajaClient().get_access_token()
            t2 = DarajaClient().get_access_token()   # fresh instance — cache is module-level
        self.assertEqual(t1, 'TEST-TOKEN')
        self.assertEqual(t2, 'TEST-TOKEN')
        self.assertEqual(oauth_calls['n'], 1, 'token was not cached across instances')

    def test_oauth_network_error_is_clean(self):
        # OAuth failure ⟹ the B2C request was never sent ⟹ CLEAN.
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=requests.ConnectionError('no route'),
        ):
            with self.assertRaises(B2CDispatchCleanError):
                DarajaClient().get_access_token()

    def test_oauth_non_200_is_clean(self):
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=lambda *a, **k: _FakeResponse(401, {'error': 'bad creds'}),
        ):
            with self.assertRaises(B2CDispatchCleanError):
                DarajaClient().get_access_token()

    def test_oauth_failure_propagates_as_clean_through_b2c_payout(self):
        # b2c_payout calls get_access_token first; a token failure must surface
        # as CLEAN (no B2C request was ever sent).
        with patch.object(
            DarajaClient, '_http_request',
            side_effect=requests.ConnectionError('no route'),
        ):
            with self.assertRaises(B2CDispatchCleanError):
                DarajaClient().b2c_payout(_fake_withdrawal())


# NOTE (2026-06-07, A2): CheckTransactionStatusMappingTests was REMOVED with
# check_transaction_status — the Transaction Status query was wire-disproven for
# unconfirmed rows and deleted (see §14.1 "DISPROVEN 2026-06-07").


class StkPushQueryMappingTests(SimpleTestCase):
    """STK Push Query ResultCode → STKQueryOutcome (the future donation Strand-B
    resolver gate). Unlike B2C Transaction Status, STK Query LOCATES by
    CheckoutRequestID and returns an authoritative ResultCode (§14.1 live capture):
    PAID requires EXPLICIT '0'; '4999' is PENDING (re-poll, NOT a verdict); known
    terminal codes are NOT_PAID; everything else is the safe INCONCLUSIVE default.
    Mocks ONLY the HTTP boundary; no DB, no donation mutation.
    """

    def setUp(self):
        daraja._clear_token_cache()

    def _query(self, body, *, status_code=200, json_raises=False, transport_exc=None):
        def _fake(method, url, **kwargs):
            if 'oauth' in url:
                return _FakeResponse(200, _OAUTH_OK)
            if transport_exc is not None:
                raise transport_exc
            return _FakeResponse(status_code, body, json_raises=json_raises)
        with patch.object(DarajaClient, '_http_request', side_effect=_fake):
            return DarajaClient().stk_push_query('ws_CO_TEST')

    def test_result_code_0_is_paid(self):
        out = self._query({'ResponseCode': '0', 'ResultCode': '0',
                           'ResultDesc': 'The service request is processed successfully.'})
        self.assertEqual(out, STKQueryOutcome.PAID)

    def test_result_code_4999_is_pending(self):
        # SEEN-FAILING-FIRST gate: '4999' MUST map to PENDING (re-poll), never to a
        # verdict — captured live as "The transaction is still under processing".
        out = self._query({'ResponseCode': '0', 'ResultCode': '4999',
                           'ResultDesc': 'The transaction is still under processing'})
        self.assertEqual(out, STKQueryOutcome.PENDING)

    def test_result_code_1037_is_not_paid(self):
        # LIVE-CONFIRMED terminal (§14.1): "No response from user."
        out = self._query({'ResponseCode': '0', 'ResultCode': '1037',
                           'ResultDesc': 'No response from user.'})
        self.assertEqual(out, STKQueryOutcome.NOT_PAID)

    def test_result_code_1032_cancelled_is_not_paid(self):
        out = self._query({'ResponseCode': '0', 'ResultCode': '1032'})
        self.assertEqual(out, STKQueryOutcome.NOT_PAID)

    def test_result_code_1_is_inconclusive_after_trim(self):
        # '1' (insufficient balance) was TRIMMED from _STK_NOT_PAID_RESULT_CODES —
        # documented but never live-confirmed, so it now falls through to the safe
        # default. This pins the trim: re-adding '1' to the allowlist is a conscious
        # change that must flip this test.
        out = self._query({'ResponseCode': '0', 'ResultCode': '1'})
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

    def test_result_code_2001_is_inconclusive_after_trim(self):
        # '2001' (wrong PIN / invalid initiator) was TRIMMED — same rationale as '1'.
        out = self._query({'ResponseCode': '0', 'ResultCode': '2001'})
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

    def test_unknown_result_code_is_inconclusive(self):
        # Not in any allowlist → safe default (resolver re-polls/escalates).
        out = self._query({'ResponseCode': '0', 'ResultCode': '9999'})
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

    def test_query_not_accepted_is_inconclusive(self):
        # Sync ResponseCode != '0' (throttled / not accepted) — learned nothing.
        out = self._query({'ResponseCode': '1', 'ResultCode': '0'})
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

    def test_non_200_is_inconclusive(self):
        # The 429 spike-arrest and the 500 "being processed" both land here.
        out = self._query({}, status_code=500)
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

    def test_unparseable_body_is_inconclusive(self):
        out = self._query(None, json_raises=True)
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

    def test_transport_error_is_inconclusive(self):
        out = self._query({}, transport_exc=requests.ConnectionError('down'))
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

    def test_token_failure_is_inconclusive(self):
        # OAuth non-200 → get_access_token raises → wrapped as INCONCLUSIVE, NOT a raise.
        def _fake(method, url, **kwargs):
            if 'oauth' in url:
                return _FakeResponse(500, {})
            return _FakeResponse(200, {'ResponseCode': '0', 'ResultCode': '0'})
        with patch.object(DarajaClient, '_http_request', side_effect=_fake):
            out = DarajaClient().stk_push_query('ws_CO_TEST')
        self.assertEqual(out, STKQueryOutcome.INCONCLUSIVE)

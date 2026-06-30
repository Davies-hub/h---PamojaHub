"""Safaricom Daraja API client — Step 2.10a: real B2C payout (replaces the stub).

This module owns the OUTBOUND dispatch side of B2C. The inbound result callback
(the asynchronous payout success/failure) is Step 2.10c and lives elsewhere.

──────────────────────────────────────────────────────────────────────────────
THE CONTRACT SEAM — synchronous ACK vs asynchronous result (read before editing)
──────────────────────────────────────────────────────────────────────────────
Daraja's B2C paymentrequest is a TWO-PHASE protocol:

  1. SYNCHRONOUS ACK (this module): the POST returns almost immediately with
     "request accepted, here is a ConversationID" — ResponseCode == '0'. This
     does NOT mean the money moved. It means Daraja QUEUED the request.
  2. ASYNCHRONOUS RESULT (Step 2.10c): the actual payout success/failure arrives
     later as an HTTP callback to MPESA_B2C_RESULT_URL. THAT is where PAID /
     FAILED is decided.

`b2c_payout()` reports ONLY on phase 1. Its job is "could I hand this request to
Daraja or not?" — nothing about how the payout eventually resolves. On success
it RETURNS {'conversation_id': <str>}. On failure it raises — but the FAILURE
HAS TWO CLASSES, and they are NOT interchangeable:

  B2CDispatchCleanError  — the request PROVABLY never reached Daraja's queue:
       * requests.RequestException (connection refused, timeout, DNS failure)
       * non-200 HTTP status on the sync response
       * OAuth / token acquisition failed (we never even sent the B2C request)
     CLEAN ⟹ no payout is in flight ⟹ SAFE to re-dispatch later.

  B2CDispatchAmbiguousError — Daraja RECEIVED the request and MAY HAVE QUEUED it,
     but we hold no usable ConversationID to correlate the eventual result:
       * HTTP 200 but body is not parseable JSON
       * HTTP 200 with a non-zero ResponseCode
       * HTTP 200 with ResponseCode '0' but missing/empty ConversationID
     AMBIGUOUS ⟹ a payout MAY be in flight ⟹ NOT safe to blind-re-dispatch.

Both subclass B2CDispatchError, so a broad `except B2CDispatchError` still
catches both — but the money-mover views catch them in SEPARATE arms and stamp
a machine-readable marker (Withdrawal.dispatch_outcome) so Step 2.10c can branch.

──────────────────────────────────────────────────────────────────────────────
THE INVARIANT (corrected — the earlier "no conversation_id ⟺ safe to re-dispatch"
was WRONG and would have armed a double-pay in 2.10c)
──────────────────────────────────────────────────────────────────────────────
A missing conversation_id means NO CONFIRMED QUEUE — it does NOT mean the payout
was never queued. An ambiguous dispatch may have queued the payout while leaving
us no ConversationID. Re-dispatch safety is therefore determined by the
dispatch-outcome MARKER, never by conversation_id absence alone:

    CLEAN_FAILURE      → request never landed → 2.10c MAY re-dispatch.
    AMBIGUOUS_FAILURE  → request may be queued → 2.10c MUST first query Daraja
                         Transaction Status, or correlate via the
                         Occasion=withdrawal.id echo, BEFORE any retry. NEVER
                         blind-re-dispatch an ambiguous row.

The `Occasion` field below carries withdrawal.id out and is echoed back on the
result callback, giving 2.10c a correlation handle for ambiguous rows even when
no conversation_id was ever stored.

We NEVER invent or guess a conversation_id, and we NEVER raise because of how the
payout eventually RESOLVES (that is the result callback's job, not ours).

Defines:
  * B2CDispatchError          — base; catches both classes.
  * B2CDispatchCleanError     — provably-never-queued (safe to re-dispatch).
  * B2CDispatchAmbiguousError — may-be-queued (must verify before retry).
  * DarajaClient              — get_access_token() + b2c_payout(). The ONLY
                                outbound HTTP flows through _http_request(), so a
                                test can patch exactly that boundary and exercise
                                the real client logic with no network.
"""

import base64
import logging
import threading
import time
import uuid
from datetime import datetime

import requests
from django.conf import settings


logger = logging.getLogger(__name__)


def new_originator_conversation_id():
    """Generate a unique OriginatorConversationID for a B2C dispatch.

    This is the id WE generate and send (distinct from the ConversationID Daraja
    returns). It is the M-Pesa back-office / Transaction Status lookup handle. The
    money-movers store it on the withdrawal in the Phase-1 (locked) block — BEFORE
    the Phase-2 HTTP call — so even a clean strand (crash mid-dispatch) carries it.
    """
    return f'pmj-{uuid.uuid4().hex}'


# NOTE (2026-06-07, A2): TransactionStatusOutcome and check_transaction_status were
# REMOVED here. The B2C Transaction Status Query was proven on the live sandbox wire
# to be unable to LOCATE an unconfirmed payout — the only working lookup key is the
# M-Pesa receipt (TransactionID), which an un-PAID row does not have (see §14.1
# "DISPROVEN 2026-06-07"). The stranded-row sweep is now escalate-only and never
# queries Daraja, so this machinery had no live mechanism and was deleted.


class B2CDispatchError(Exception):
    """Base: could not complete a B2C DISPATCH to Daraja. NOT "payout failed on
    M-Pesa's side" — that outcome is reported asynchronously to the result URL
    (Step 2.10c). Always one of the two subclasses below is raised in practice;
    the base exists so a broad `except B2CDispatchError` still catches both.
    """


class B2CDispatchCleanError(B2CDispatchError):
    """The request PROVABLY never reached Daraja's queue (transport error,
    non-200 sync status, or OAuth/token failure). No payout is in flight — SAFE
    to re-dispatch. Stamped CLEAN_FAILURE on the withdrawal row.
    """


class B2CDispatchAmbiguousError(B2CDispatchError):
    """Daraja RECEIVED the request and MAY HAVE QUEUED the payout, but we hold no
    usable ConversationID (unparseable 200 body, non-zero ResponseCode, or
    ResponseCode '0' with missing/empty ConversationID). A payout MAY be in
    flight — NOT safe to blind-re-dispatch. Stamped AMBIGUOUS_FAILURE on the
    withdrawal row; 2.10c must verify (status query / Occasion correlation)
    before any retry.
    """


class STKPushError(Exception):
    """STK Push (donation initiate) could not be ACCEPTED by Daraja.

    Unlike B2C, STK push needs NO clean/ambiguous split: at initiate NO money has
    moved. A donation that never gets a CheckoutRequestID stays PENDING, is never
    credited, and ages out harmlessly — so every failure mode (transport error,
    non-200, unparseable body, non-zero ResponseCode, missing CheckoutRequestID,
    or token failure) collapses to one outcome: "couldn't start payment, the
    donor retries." We NEVER invent a CheckoutRequestID on an ambiguous ack —
    without it the frontend can't poll and the callback can't correlate, so an
    ambiguous STK ack IS an initiate failure.
    """


class STKQueryOutcome:
    """The four explicit outcomes stk_push_query() can return, for a future stuck-
    donation resolver. PAID is the ONLY credit trigger and requires an EXPLICIT
    ResultCode '0'. INCONCLUSIVE is the safe default — "could not determine" — and is
    NEVER collapsed into a verdict (the resolver re-polls / escalates instead).
    """

    PAID = 'PAID'              # STK Query ResultCode 0 — payment completed.
    NOT_PAID = 'NOT_PAID'      # explicit terminal non-success (cancelled / timeout / …).
    PENDING = 'PENDING'        # ResultCode 4999 — still under processing; re-poll.
    INCONCLUSIVE = 'INCONCLUSIVE'  # query not accepted / transport-or-token error / unknown.


# ── Access-token cache ────────────────────────────────────────────────────────
# Daraja OAuth tokens live ~1h. Cache in-process, keyed by environment, with a
# safety margin so we never present a token that expires mid-flight. No Redis
# dependency this step — a module-level dict + lock is sufficient for a single
# process. (Multi-worker deployments simply each hold their own token; Daraja
# permits concurrent valid tokens.)
#
# DELIBERATE NON-FIX — in-process concurrent-miss race: two threads can both miss
# the cache, both fetch a token, and the second write overwrites the first. This
# is harmless and intentionally not locked on the read/fetch path: Daraja issues
# multiple concurrently-valid tokens, so both threads hold working tokens and the
# only cost is one redundant OAuth round-trip. The lock below guards only the
# dict write (so the cache never sees a torn entry), NOT the check-then-fetch.
_TOKEN_CACHE = {}
_TOKEN_LOCK = threading.Lock()
_TOKEN_SAFETY_MARGIN_SECONDS = 60


def _clear_token_cache():
    """Test/maintenance hook — drop all cached tokens."""
    with _TOKEN_LOCK:
        _TOKEN_CACHE.clear()


class DarajaClient:
    """Talks to Safaricom Daraja. Step 2.10a implements only get_access_token()
    and b2c_payout(); STK push / transaction status / balance are 2.10b+.
    """

    _BASE_URLS = {
        'sandbox': 'https://sandbox.safaricom.co.ke',
        'production': 'https://api.safaricom.co.ke',
    }

    DEFAULT_TIMEOUT = 30  # seconds — generous; the sync ack is fast, but Daraja
    #                       latency varies. This is dispatch timeout, not payout.

    # STK Push Query ResultCode → outcome. ResultCode is AUTHORITATIVE once the
    # transaction is LOCATED by CheckoutRequestID — unlike B2C Transaction Status
    # (which could not locate an unconfirmed payout at all, §14.1 DISPROVEN), STK
    # Query cleanly returns the txn's own state. Live-captured (§14.1 STK-Query
    # capture): '0'→success, '4999'→still processing, '1037'→no-response/timeout.
    # PAID is the only credit trigger, so its set is EXACT ('0'). The not-paid set is
    # NARROW (explicit terminal-failure codes); anything not matched is INCONCLUSIVE
    # (the safe default — the resolver re-polls / escalates, never settles on a guess).
    # Widen _STK_NOT_PAID_RESULT_CODES only with codes confirmed against live Daraja.
    _STK_PAID_RESULT_CODES = ('0',)
    _STK_PENDING_RESULT_CODES = ('4999',)
    # Candidate NOT_PAID codes (documented, NOT live-confirmed) — add only after
    # confirming against live Daraja: 1, 2001, 1019, 1025. Until then they fall
    # through to INCONCLUSIVE (safe — the resolver re-polls, never a wrong FAILED).
    _STK_NOT_PAID_RESULT_CODES = (
        '1037',  # "No response from user." (timeout) — LIVE-CONFIRMED (§14.1)
        '1032',  # request cancelled by user (donor cancelled) — documented Daraja STK code
    )

    def __init__(self):
        self.environment = (settings.MPESA_ENVIRONMENT or 'sandbox').strip().lower()
        self.base_url = self._BASE_URLS.get(self.environment, self._BASE_URLS['sandbox'])
        self.consumer_key = settings.MPESA_CONSUMER_KEY
        self.consumer_secret = settings.MPESA_CONSUMER_SECRET
        self.shortcode = settings.MPESA_SHORTCODE          # STK / Lipa-na-M-Pesa
        self.b2c_shortcode = settings.MPESA_B2C_SHORTCODE  # B2C org (distinct from STK)
        self.passkey = settings.MPESA_PASSKEY
        self.stk_callback_url = settings.MPESA_CALLBACK_URL
        self.initiator_name = settings.MPESA_B2C_INITIATOR_NAME
        self.security_credential = settings.MPESA_B2C_SECURITY_CREDENTIAL
        self.queue_url = settings.MPESA_B2C_QUEUE_URL
        self.result_url = settings.MPESA_B2C_RESULT_URL
        self.timeout = self.DEFAULT_TIMEOUT

    # ── THE HTTP BOUNDARY ──────────────────────────────────────────────────────
    def _http_request(self, method, url, **kwargs):
        """The ONLY place this module touches the network. Both get_access_token
        and b2c_payout route every outbound call through here, so a test can
        patch exactly this method (`integrations.daraja.DarajaClient._http_request`)
        and exercise the full client logic with zero real HTTP. Returns a
        requests.Response; raises requests.RequestException on transport failure.
        """
        return requests.request(method, url, **kwargs)

    # ── OAuth ───────────────────────────────────────────────────────────────────
    def get_access_token(self):
        """Return a valid Daraja OAuth bearer token, cached for its lifetime.

        Raises B2CDispatchCleanError if a token cannot be obtained — a token
        failure means the B2C request was never sent, so the dispatch PROVABLY
        never landed (CLEAN, safe to re-dispatch).
        """
        now = time.monotonic()
        cached = _TOKEN_CACHE.get(self.environment)
        if cached and cached['expires_at'] > now:
            return cached['token']

        url = f'{self.base_url}/oauth/v1/generate?grant_type=client_credentials'
        try:
            resp = self._http_request(
                'GET', url,
                auth=(self.consumer_key, self.consumer_secret),
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise B2CDispatchCleanError(f'Daraja OAuth network error: {exc}') from exc

        if resp.status_code != 200:
            raise B2CDispatchCleanError(
                f'Daraja OAuth returned HTTP {resp.status_code}'
            )
        try:
            data = resp.json()
            token = data['access_token']
            expires_in = int(data.get('expires_in', 3599))
        except (ValueError, KeyError, TypeError) as exc:
            raise B2CDispatchCleanError(
                f'Daraja OAuth response unparseable: {exc}'
            ) from exc

        with _TOKEN_LOCK:
            _TOKEN_CACHE[self.environment] = {
                'token': token,
                'expires_at': now + max(0, expires_in - _TOKEN_SAFETY_MARGIN_SECONDS),
            }
        return token

    # ── B2C payout dispatch ──────────────────────────────────────────────────────
    def b2c_payout(self, withdrawal):
        """Dispatch a B2C payout to Daraja. Returns {'conversation_id': str} on a
        clean synchronous ACK; otherwise raises B2CDispatchCleanError (never
        landed) or B2CDispatchAmbiguousError (may be queued). See the module
        docstring for the full contract — this is the seam 2.10c depends on.
        Does NOT decide payout success/failure (that's the callback).
        """
        # Token failure is CLEAN (no B2C request sent) — propagates as
        # B2CDispatchCleanError from get_access_token().
        token = self.get_access_token()

        url = f'{self.base_url}/mpesa/b2c/v1/paymentrequest'
        payload = {
            'InitiatorName': self.initiator_name,
            'SecurityCredential': self.security_credential,
            # BusinessPayment: a normal B2C disbursement (not salary/promotion).
            'CommandID': 'BusinessPayment',
            # Daraja B2C Amount is an integer number of shillings.
            'Amount': int(withdrawal.amount),
            'PartyA': self.b2c_shortcode,
            'PartyB': str(withdrawal.destination_phone),
            'Remarks': (withdrawal.reason or 'Pamoja Hub payout')[:100],
            'QueueTimeOutURL': self.queue_url,
            'ResultURL': self.result_url,
            # OriginatorConversationID — OUR generated id, the M-Pesa lookup handle.
            # Set by the caller in Phase-1 (stored before this HTTP call). Fall back
            # to an ephemeral one so we never send null, but the persisted value is
            # the caller's responsibility (so a clean strand keeps the handle).
            'OriginatorConversationID': (
                withdrawal.originator_conversation_id or new_originator_conversation_id()
            ),
            # Occasion echoes back on the result callback — tie it to our row so
            # 2.10c can correlate an AMBIGUOUS row even with no stored
            # ConversationID.
            'Occasion': str(withdrawal.id)[:100],
        }
        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        }

        try:
            resp = self._http_request(
                'POST', url, json=payload, headers=headers, timeout=self.timeout,
            )
        except requests.RequestException as exc:
            # Transport error: the request provably never landed. CLEAN.
            raise B2CDispatchCleanError(f'B2C dispatch network error: {exc}') from exc

        if resp.status_code != 200:
            # Daraja's front door rejected it before queueing. CLEAN.
            raise B2CDispatchCleanError(
                f'B2C dispatch returned HTTP {resp.status_code}'
            )

        # From here we have a 200 — Daraja RECEIVED the request. Any failure to
        # extract a usable ConversationID is AMBIGUOUS: it may already be queued.
        try:
            data = resp.json()
        except ValueError as exc:
            raise B2CDispatchAmbiguousError(
                f'B2C 200 but body not JSON (may be queued): {exc}'
            ) from exc

        response_code = str(data.get('ResponseCode', '')).strip()
        conversation_id = str(data.get('ConversationID') or '').strip()

        if response_code != '0':
            raise B2CDispatchAmbiguousError(
                f'B2C 200 with non-zero ResponseCode={response_code!r} '
                f'(may be queued): {data.get("ResponseDescription", "")}'
            )
        if not conversation_id:
            raise B2CDispatchAmbiguousError(
                'B2C 200 + ResponseCode 0 but missing ConversationID (may be queued)'
            )

        logger.info(
            'B2C dispatched for withdrawal %s — ConversationID=%s',
            withdrawal.id, conversation_id,
        )
        return {'conversation_id': conversation_id}

    # ── STK Push (donation initiate + status query) ─────────────────────────────
    def _stk_password_and_timestamp(self):
        """Daraja STK auth pair: Timestamp (yyyymmddHHMMSS) and Password =
        base64(BusinessShortCode + Passkey + Timestamp). Shared by stk_push (initiate)
        and stk_push_query (status) so the derivation can NEVER drift between them.
        """
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        password = base64.b64encode(
            f'{self.shortcode}{self.passkey}{timestamp}'.encode()
        ).decode()
        return password, timestamp

    def stk_push(self, phone, amount, account_reference, transaction_desc,
                 callback_url=None):
        """Initiate an M-Pesa STK push (Lipa na M-Pesa Online).

        `account_reference` (≤12 chars — shows on the payer's M-Pesa statement),
        `transaction_desc`, and `callback_url` are the payload fields that vary by
        caller: the donation flow passes the campaign slug + 'Donation' and lets
        `callback_url` default to the donation STK callback (self.stk_callback_url =
        MPESA_CALLBACK_URL); a subscription charge passes its own handle +
        'Subscription' + the subscription callback URL so its result lands on the
        subscription handler, NOT the donation one. The caller owns the ≤12-char
        truncation (this method sends `account_reference` verbatim). Everything else
        (shortcode, password, accepted-ack contract, raise paths) is generic.

        Returns {'checkout_request_id': str, 'merchant_request_id': str} on a clean
        ack (ResponseCode '0' AND a CheckoutRequestID present — same accepted-ack
        contract as B2C). Raises STKPushError on ANY failure: transport error,
        non-200, unparseable body, non-zero ResponseCode, missing CheckoutRequestID,
        or token failure. No clean/ambiguous split — see STKPushError. We never
        invent a CheckoutRequestID.

        Like B2C, all outbound HTTP flows through the single _http_request seam.
        """
        try:
            token = self.get_access_token()
        except B2CDispatchError as exc:
            # Token failure ⟹ STK never sent ⟹ initiate failure.
            raise STKPushError(f'Could not authenticate STK push: {exc}') from exc

        password, timestamp = self._stk_password_and_timestamp()

        url = f'{self.base_url}/mpesa/stkpush/v1/processrequest'
        payload = {
            'BusinessShortCode': self.shortcode,
            'Password': password,
            'Timestamp': timestamp,
            'TransactionType': 'CustomerPayBillOnline',
            'Amount': int(amount),
            'PartyA': str(phone),
            'PartyB': self.shortcode,
            'PhoneNumber': str(phone),
            # callback_url is None for donations → the donation STK callback default.
            'CallBackURL': callback_url or self.stk_callback_url,
            # AccountReference shows on the payer's statement; max 12 chars (caller truncates).
            'AccountReference': account_reference,
            'TransactionDesc': transaction_desc,
        }
        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        }

        try:
            resp = self._http_request(
                'POST', url, json=payload, headers=headers, timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise STKPushError(f'STK push network error: {exc}') from exc

        if resp.status_code != 200:
            raise STKPushError(f'STK push returned HTTP {resp.status_code}')

        try:
            data = resp.json()
        except ValueError as exc:
            raise STKPushError(f'STK push response not JSON: {exc}') from exc

        response_code = str(data.get('ResponseCode', '')).strip()
        checkout_request_id = str(data.get('CheckoutRequestID') or '').strip()
        merchant_request_id = str(data.get('MerchantRequestID') or '').strip()

        if response_code != '0':
            raise STKPushError(
                f'STK push non-zero ResponseCode={response_code!r}: '
                f'{data.get("ResponseDescription", "")}'
            )
        if not checkout_request_id:
            # Ambiguous ack: without a CheckoutRequestID the donor can't poll and
            # the callback can't correlate — treat as an initiate failure.
            raise STKPushError('STK push ack missing CheckoutRequestID')

        logger.info(
            'STK push initiated — AccountReference=%s CheckoutRequestID=%s',
            account_reference, checkout_request_id,
        )
        return {
            'checkout_request_id': checkout_request_id,
            'merchant_request_id': merchant_request_id,
        }

    # ── STK Push status query (stuck-donation reconciliation) ────────────────────
    def stk_push_query(self, checkout_request_id):
        """Query Daraja STK Push status for a CheckoutRequestID; return ONE of
        STKQueryOutcome.{PAID, NOT_PAID, PENDING, INCONCLUSIVE}.

        For a FUTURE stuck-donation resolver (NOT built here): unlike B2C Transaction
        Status — which cannot locate an unconfirmed payout (§14.1 DISPROVEN) — STK Push
        Query locates by CheckoutRequestID, the key a Strand B donation already stores,
        and returns a synchronous, authoritative ResultCode (live-captured, §14.1):
          ResultCode '0'    → PAID    (the ONLY credit trigger; must be EXPLICIT '0')
          ResultCode '4999' → PENDING (still under processing — re-poll, do NOT settle)
          ResultCode in _STK_NOT_PAID_RESULT_CODES → NOT_PAID (terminal non-success)
          anything else / cannot determine → INCONCLUSIVE (safe default: re-poll/escalate)

        A token failure, transport error, non-200 (incl. the 429 spike-arrest and the
        500 "being processed"), unparseable body, or sync ResponseCode != '0' (the query
        itself not accepted) is INCONCLUSIVE — "could not determine," NEVER a verdict.
        This method NEVER mutates a donation; it only classifies. Operational note
        (§14.1): STK Query is rate-limited (~5/min spike-arrest), so a resolver must
        throttle. All outbound HTTP flows through the single _http_request seam.
        """
        # Token failure ⟹ we never asked Daraja ⟹ could not determine (re-poll later).
        try:
            token = self.get_access_token()
        except B2CDispatchError:
            return STKQueryOutcome.INCONCLUSIVE

        password, timestamp = self._stk_password_and_timestamp()
        url = f'{self.base_url}/mpesa/stkpushquery/v1/query'
        payload = {
            'BusinessShortCode': self.shortcode,
            'Password': password,
            'Timestamp': timestamp,
            'CheckoutRequestID': checkout_request_id,
        }
        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        }

        try:
            resp = self._http_request(
                'POST', url, json=payload, headers=headers, timeout=self.timeout,
            )
        except requests.RequestException:
            return STKQueryOutcome.INCONCLUSIVE

        if resp.status_code != 200:
            return STKQueryOutcome.INCONCLUSIVE

        try:
            data = resp.json()
        except ValueError:
            return STKQueryOutcome.INCONCLUSIVE

        # The QUERY itself must have been accepted (ResponseCode '0'); otherwise we
        # learned nothing about the payment (throttled / still initializing).
        if str(data.get('ResponseCode', '')).strip() != '0':
            return STKQueryOutcome.INCONCLUSIVE

        result_code = str(data.get('ResultCode', '')).strip()
        if result_code in self._STK_PAID_RESULT_CODES:
            return STKQueryOutcome.PAID
        if result_code in self._STK_PENDING_RESULT_CODES:
            return STKQueryOutcome.PENDING
        if result_code in self._STK_NOT_PAID_RESULT_CODES:
            return STKQueryOutcome.NOT_PAID
        return STKQueryOutcome.INCONCLUSIVE

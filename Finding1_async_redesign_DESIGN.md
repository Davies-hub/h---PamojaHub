# Finding #1 — B2C status-resolution async redesign (DESIGN ONLY)

**Status:** Design draft. NO code written. One section is explicitly BLOCKED on the
8006 sandbox-credential unlock (success-vocabulary capture) and is fenced as such.
**Date:** 2026-06-04
**Scope:** B2C / Withdrawal status resolution only. Establishes the async-query
architecture that the Strand B orphan-STK sweep will reuse (see §7).

---

## 1. The defect being fixed (restated for the record)

`check_transaction_status` was built assuming Daraja's Transaction Status Query
returns a definitive `TransactionStatus` string synchronously. Live capture proved
it does not: the synchronous HTTP response is an accept-ack only (`ResponseCode "0"`,
"Accept the service request successfully", no status field). The real result arrives
asynchronously on the ResultURL callback.

Consequence today: the sweep's synchronous 3-outcome mapping
(`_PAID_STATUSES`/`_NOT_SENT_STATUSES`) can never match a live sync response, so
every query returns INCONCLUSIVE → every stranded withdrawal routes to
NEEDS_RECONCILIATION. SAFE (no double-pay) but the auto-resolution capability —
the whole point of the sweep — is non-functional against live Daraja.

## 2. Chosen architecture: DUAL PATH

Two resolvers, one idempotent finalizer.

- **Primary — the B2C result callback** (`/withdrawals/b2c-result/`). Normal path:
  Daraja POSTs the async result, the handler resolves the row.
- **Secondary — the sweep's active re-query.** For rows that go stale in PROCESSING
  (the primary callback was lost — network, Daraja drop, or ingress rejection; the
  ALLOWED_HOSTS incident this session is proof callbacks DO get dropped), the sweep
  initiates a Transaction Status Query. That query is ALSO async: its result returns
  on the ResultURL callback, not synchronously.

Rejected alternative (single-path): callback-only, sweep just escalates stale rows
to NEEDS_RECONCILIATION. Rejected because a lost callback would then ALWAYS mean
manual reconciliation — and lost callbacks are demonstrated, not hypothetical. Also,
the Strand B orphan-STK sweep needs an active query regardless (§7), so single-path
would force designing the active-query pattern separately later. Dual-path designs
it once.

## 3. The async flow (both resolvers funnel here)

```
dispatch ──> PROCESSING ──┬─> [primary] result callback arrives ─┐
                          │                                       ├─> idempotent
                          └─> [secondary] sweep finds stale row,  │   FINALIZER
                              fires Transaction Status Query,     │   (§4)
                              its result arrives on ResultURL ────┘
```

Key point: BOTH the original payout result AND the status-query result arrive as
async callbacks on the SAME ResultURL. The callback handler must distinguish
"result of the original payout" from "result of a status query" (they have
different ResultType/result shapes — TO BE CONFIRMED against live wire, §6) and
route both into the finalizer.

## 4. The idempotent finalizer (the double-pay / double-resolve guard) — CRITICAL

This is the load-bearing correctness property. Two resolvers means two things can
try to resolve the same row; they must converge to exactly-once.

Both paths MUST:
1. `select_for_update()` the Withdrawal row (lock).
2. Re-check status INSIDE the lock: if already PAID / FAILED_FINAL / a terminal
   state → no-op, release. (Mirror of the donation-callback dedup pattern the
   correlation trace confirmed is already correct.)
3. Only if still in a resolvable state (PROCESSING / FAILED), apply the outcome.
4. Credit/finalize under the campaign `select_for_update()` (Net-Everywhere),
   exactly as the existing money-movers.

Whichever of {callback, sweep-query-result} takes the row lock first resolves; the
other sees the terminal state and no-ops. This is the existing pattern, extended to
cover the second resolver. NO new locking model — reuse what's proven.

## 5. Correlation (SETTLED — from the correlation trace, not assumed)

- Primary correlation key: `b2c_conversation_id` == callback `ConversationID`
  (Daraja's own ID, stored at dispatch, echoed in the callback). VERIFIED live.
- Our `OriginatorConversationID` (`pmj-…`) is NOT echoed by Daraja — it is an
  INTERNAL re-entrancy version token only (the `redispatch_withdrawal` CAS guard),
  never a correlation key. (This corrected the earlier misdiagnosis.)
- The status-query result callback must correlate on the same `b2c_conversation_id`.
  CONFIRM the status-query result echoes the original ConversationID (likely) vs a
  fresh one (§6).

## 6. >>> BLOCKED BOUNDARY — success-vocabulary, gated on 8006 unlock <<<

Everything above is designable now. The following CANNOT be finalized until a real
SUCCESSFUL B2C transaction is captured (needs 8006 credential unlock):

- **The success-side parsing.** What `ResultCode` / `ResultDesc` (and for the
  status-query path, what `ResultType` / status fields) does a *successful* B2C
  result actually carry? We have the FAILURE vocabulary (`ResultCode 8006`,
  "The security credential is locked.", integer code + human string, NO
  TransactionStatus field) but NOT the success vocabulary.
- **Status-query-result vs payout-result discrimination.** Whether the two async
  callbacks are distinguishable by `ResultType` or shape (needed for §3 routing).
- **Status-query result correlation id** (§5): does it echo the original
  `ConversationID` or assign a new one?

Until captured, these three are MARKED HOLES. The design around them is fixed; the
field-parsing is fill-in-the-blank on unlock. DO NOT build the success parsing
against a guess — that would re-commit the exact sin Finding #1 is an instance of.

## 7. Reuse for Strand B orphan-STK (why this design serves two threads)

The Strand B orphan-STK sweep (donation whose callback never arrived, but
`checkout_request_id` is populated) needs the SAME active-async-query pattern:
find stale row → fire query → result arrives async on a ResultURL → idempotent
finalize under lock. The query differs (STK Push Query, keyed on CheckoutRequestID,
vs B2C Transaction Status) but the ARCHITECTURE is identical. Design once here,
reuse there. The STK query must NOT replicate the sync-assumption defect (it's the
same trap).

NOTE: Strand A orphan-STK (502-initiate, `checkout_request_id=None`) is NOT served
by this — it has no correlation handle, is unrecoverable by automation (confirmed:
MerchantRequestID is not an STK-Query key), and is a separate accepted-risk /
manual-queue product decision. Out of scope for this redesign.

## 8. NEEDS_RECONCILIATION boundary (unchanged, reconfirmed)

A row escalates to NEEDS_RECONCILIATION only when BOTH resolvers fail to reach a
definitive outcome: no callback arrived AND the active status-query result is
itself inconclusive (after the transient-retry backoff). It stays in the
block-on-FAILED blocking set, offers no one-click re-dispatch, and exposes the
resolve-paid / resolve-retry human endpoints (already built in 2.10c). This part
of 2.10c was sound and survives the redesign.

## 9. Build sequencing (after unlock)

1. 8006 unlock (portal — user task, parallel).
2. Capture one real SUCCESSFUL B2C transaction → fill §6 holes.
3. Build the async result-callback handler (primary resolver) against captured
   real vocabulary.
4. Build the sweep's active re-query (secondary resolver) feeding the same finalizer.
5. Verify the double-resolve guard (§4) with a callback-races-sweep test.
6. Reuse the pattern for Strand B orphan-STK as a separate step.

## 10. What this design does NOT close

- The success-vocabulary holes (§6) — blocked on 8006.
- Strand A orphan-STK — accepted-risk product decision, separate.
- The password-reset TIMING enumeration channel — unrelated, separately tracked.
- Live verification (STK happy path, AT, Resend) — access-gated, separate batch.

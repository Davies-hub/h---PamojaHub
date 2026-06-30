import { SUBSCRIPTION_EXPIRING_SOON_DAYS, SUBSCRIPTION_GRACE_DAYS } from '../constants/subscription';
import { SubscriptionTier } from '../types';

// CANCELLED is a CARD overlay state, not a lifecycle state — deriveSubscriptionState
// never returns it; the card layers it on when auto-renew is cancelled on a paid plan.
export type SubscriptionState = 'ACTIVE' | 'EXPIRING_SOON' | 'IN_GRACE' | 'FREE' | 'CANCELLED';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The window inside which a PARISH church may NOT down-switch to GROWTH. Mirrors the
// backend guard LITERALLY (SubscriptionInitiateView: expires_at > now + timedelta(days=7)).
// Kept as its own constant — NOT reusing SUBSCRIPTION_EXPIRING_SOON_DAYS — so the picker
// rule cannot drift if the card's "expiring soon" threshold is ever retuned separately.
export const SUBSCRIPTION_PARISH_DOWNGRADE_BLOCK_DAYS = 7;

/**
 * Derive the treasurer-facing subscription card state from a church's tier + expiry.
 *
 * PURE — it never reads the clock; `now` is injected (tests pass a fixed Date, the
 * card passes `new Date()`). Mirrors the backend lifecycle: renewal reminders fire in
 * the last SUBSCRIPTION_EXPIRING_SOON_DAYS before expiry, and a paid church past expiry
 * sits in a SUBSCRIPTION_GRACE_DAYS window before the lapse job flips it to FREE.
 * Thresholds come from constants/subscription.ts (kept in sync with the backend).
 *
 * Rules (exact):
 *   - FREE tier / no tier / paid-but-no-expiry            → FREE
 *   - paid, (expiry − now) > SOON_DAYS                    → ACTIVE
 *   - paid, 0 < (expiry − now) ≤ SOON_DAYS                → EXPIRING_SOON
 *   - paid, expiry in the past, now < expiry + GRACE_DAYS → IN_GRACE
 *   - paid, now ≥ expiry + GRACE_DAYS                     → FREE (lapse job will/has flipped it;
 *                                                           never claim a tier the backend is revoking)
 */
export function deriveSubscriptionState(
  tier: SubscriptionTier | undefined | null,
  expiresAt: string | undefined | null,
  now: Date,
): SubscriptionState {
  if (!tier || tier === 'FREE') return 'FREE';
  if (!expiresAt) return 'FREE';

  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return 'FREE';   // unparseable expiry → safe neutral

  const nowMs = now.getTime();
  const soonMs = SUBSCRIPTION_EXPIRING_SOON_DAYS * MS_PER_DAY;
  const graceMs = SUBSCRIPTION_GRACE_DAYS * MS_PER_DAY;

  if (expiryMs > nowMs) {
    // Future expiry: more than SOON_DAYS out is healthy; otherwise it's expiring soon.
    return expiryMs - nowMs > soonMs ? 'ACTIVE' : 'EXPIRING_SOON';
  }
  // Expiry has passed (or is exactly now): in grace until expiry + GRACE_DAYS, then FREE.
  return nowMs < expiryMs + graceMs ? 'IN_GRACE' : 'FREE';
}

/**
 * The tiers a church may pick in the renew/upgrade picker — MUST mirror the backend
 * exactly (the picker can only ever offer what /subscriptions/initiate/ will accept).
 *
 * Locked rule:
 *   - FREE                                   → GROWTH, PARISH
 *   - GROWTH                                 → GROWTH, PARISH
 *   - PARISH & expires_at > now + 7d         → PARISH only   (mid-period downgrade blocked)
 *   - PARISH & within 7 days OR in grace     → GROWTH, PARISH (the deliberate goodwill leak)
 *
 * PURE — `now` is injected. `state` is accepted (the card already has it) and used only
 * as the lapsed-to-FREE short-circuit: a PARISH church whose card state has already
 * collapsed to FREE (past grace) is treated as non-restricted, matching the backend (a
 * past-due / lapsed church may pay for any tier). The PARISH boundary itself is computed
 * straight from expiresAt vs now + 7d so it tracks the backend guard literally.
 */
export function getValidTiers(
  state: SubscriptionState,
  tier: SubscriptionTier | undefined | null,
  expiresAt: string | undefined | null,
  now: Date,
): SubscriptionTier[] {
  const BOTH: SubscriptionTier[] = ['GROWTH', 'PARISH'];

  // Only a live PARISH plan can be restricted. FREE/GROWTH always see both paid tiers;
  // a PARISH plan already shown as FREE (lapsed past grace) is past-due → not restricted.
  if (tier !== 'PARISH' || state === 'FREE') return BOTH;
  if (!expiresAt) return BOTH;

  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return BOTH;   // unparseable → safe (offer both)

  // Block the GROWTH down-switch ONLY while MORE than 7 days of paid Parish remain.
  const blockUntilMs = now.getTime() + SUBSCRIPTION_PARISH_DOWNGRADE_BLOCK_DAYS * MS_PER_DAY;
  return expiryMs > blockUntilMs ? ['PARISH'] : BOTH;
}

// ─── Renew pay-and-watch poll reducer (PURE) ──────────────────────────────────
//
// The /subscriptions/{id}/status/ verdict the card polls after initiate. `null` models a
// network blip / transient 404 (non-terminal — keep polling). Mirrors the donation poll.
export interface SubscriptionPollVerdict {
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  tier: SubscriptionTier;
  subscriptionExpiresAt: string | null;
  stale: boolean;            // backend-derived: PENDING row older than the STK timeout
}

// 'confirming'  = still polling (spinner, "check your phone")
// 'success'     = a SUCCESSFUL verdict — the ONLY trigger for a success claim
// 'failed'      = a FAILED verdict
// 'unconfirmed' = bound exhausted OR stale-while-PENDING — honest unknown (no claim)
export type SubscriptionPollState = 'confirming' | 'success' | 'failed' | 'unconfirmed';

const TERMINAL_POLL_STATES: SubscriptionPollState[] = ['success', 'failed', 'unconfirmed'];

export interface SubscriptionPollOutcome {
  state: SubscriptionPollState;
  // Present ONLY on a success transition (the card shows "on {tier} until {expiry}").
  success?: { tier: SubscriptionTier; expiresAt: string | null };
}

/**
 * Decide the next poll state from the current state + one poll tick. PURE — no clock,
 * no timers. Encodes the donation-clone terminal rules AND the "late poll can't override
 * a shown terminal" guard in one place so it can be unit-tested:
 *
 *   - already terminal           → unchanged (a late SUCCESSFUL after unconfirmed is ignored)
 *   - SUCCESSFUL                 → success (carries tier + new expiry)
 *   - FAILED                     → failed
 *   - PENDING & stale            → unconfirmed (don't wait out the bound)
 *   - bound exhausted            → unconfirmed
 *   - PENDING / blip (verdict null) within the bound → confirming (keep polling)
 */
export function pollReducer(
  state: SubscriptionPollState,
  ev: { verdict: SubscriptionPollVerdict | null; attempts: number; maxAttempts: number },
): SubscriptionPollOutcome {
  if (TERMINAL_POLL_STATES.includes(state)) return { state };   // late verdict ignored

  const { verdict, attempts, maxAttempts } = ev;
  if (verdict && verdict.status === 'SUCCESSFUL') {
    return { state: 'success', success: { tier: verdict.tier, expiresAt: verdict.subscriptionExpiresAt } };
  }
  if (verdict && verdict.status === 'FAILED') return { state: 'failed' };
  if (verdict && verdict.status === 'PENDING' && verdict.stale) return { state: 'unconfirmed' };
  if (attempts >= maxAttempts) return { state: 'unconfirmed' };
  return { state: 'confirming' };   // PENDING or transient blip — keep polling
}

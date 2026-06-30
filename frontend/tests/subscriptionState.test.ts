import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_EXPIRING_SOON_DAYS, SUBSCRIPTION_GRACE_DAYS } from '../constants/subscription';
import { SubscriptionTier } from '../types';
import { deriveSubscriptionState, getValidTiers } from '../utils/subscription';

// Fixed clock so every case is deterministic regardless of when the suite runs.
const NOW = new Date('2026-06-20T12:00:00Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// expiry = NOW + offsetDays (negative = in the past). Nudge boundary cases a few
// seconds inward so floating "exactly N days" sits unambiguously on the intended side.
function expiryAt(offsetDays: number, nudgeSeconds = 0): string {
  return new Date(NOW.getTime() + offsetDays * MS_PER_DAY + nudgeSeconds * 1000).toISOString();
}

describe('deriveSubscriptionState', () => {
  it('sanity: the thresholds this suite assumes are both 7', () => {
    expect(SUBSCRIPTION_EXPIRING_SOON_DAYS).toBe(7);
    expect(SUBSCRIPTION_GRACE_DAYS).toBe(7);
  });

  it('8 days out → ACTIVE', () => {
    expect(deriveSubscriptionState('GROWTH', expiryAt(8), NOW)).toBe('ACTIVE');
  });

  it('exactly 7 days out → EXPIRING_SOON (boundary is inclusive of "soon")', () => {
    // (expiry − now) === SOON_DAYS is NOT "more than", so it is EXPIRING_SOON.
    expect(deriveSubscriptionState('GROWTH', expiryAt(7, -1), NOW)).toBe('EXPIRING_SOON');
  });

  it('1 day out → EXPIRING_SOON', () => {
    expect(deriveSubscriptionState('PARISH', expiryAt(1), NOW)).toBe('EXPIRING_SOON');
  });

  it('1 day past expiry → IN_GRACE', () => {
    expect(deriveSubscriptionState('GROWTH', expiryAt(-1), NOW)).toBe('IN_GRACE');
  });

  it('6 days past expiry → IN_GRACE (still inside the grace window)', () => {
    expect(deriveSubscriptionState('GROWTH', expiryAt(-6), NOW)).toBe('IN_GRACE');
  });

  it('8 days past expiry → FREE (beyond grace; backend lapse owns it)', () => {
    expect(deriveSubscriptionState('PARISH', expiryAt(-8), NOW)).toBe('FREE');
  });

  it('FREE tier → FREE regardless of expiry', () => {
    expect(deriveSubscriptionState('FREE', expiryAt(20), NOW)).toBe('FREE');
  });

  it('no tier → FREE', () => {
    expect(deriveSubscriptionState(undefined, expiryAt(20), NOW)).toBe('FREE');
  });

  it('paid tier with no expiry → FREE (defensive; never happens once confirmed)', () => {
    expect(deriveSubscriptionState('GROWTH', undefined, NOW)).toBe('FREE');
  });
});

// ── getValidTiers: the picker rule MUST match the backend's Parish→Growth guard ──────
describe('getValidTiers', () => {
  const BOTH: SubscriptionTier[] = ['GROWTH', 'PARISH'];

  // Mirror real card usage: derive state from tier+expiry, then ask for the valid tiers.
  function validFor(tier: SubscriptionTier, expiresAt: string | undefined): SubscriptionTier[] {
    const state = deriveSubscriptionState(tier, expiresAt, NOW);
    return getValidTiers(state, tier, expiresAt, NOW);
  }

  it('FREE → both paid tiers', () => {
    expect(validFor('FREE', undefined)).toEqual(BOTH);
  });

  it('GROWTH (healthy) → both paid tiers (upgrade always allowed)', () => {
    expect(validFor('GROWTH', expiryAt(30))).toEqual(BOTH);
  });

  it('GROWTH expiring soon → both paid tiers', () => {
    expect(validFor('GROWTH', expiryAt(3))).toEqual(BOTH);
  });

  // The leak boundary — PARISH at exactly the 7-day line and on either side.
  it('PARISH +8d → PARISH only (mid-period downgrade blocked)', () => {
    expect(validFor('PARISH', expiryAt(8))).toEqual(['PARISH']);
  });

  it('PARISH +20d → PARISH only', () => {
    expect(validFor('PARISH', expiryAt(20))).toEqual(['PARISH']);
  });

  it('PARISH at exactly +7d → both (boundary is "> 7d", so 7d is NOT blocked)', () => {
    expect(validFor('PARISH', expiryAt(7, -1))).toEqual(BOTH);
  });

  it('PARISH +6d → both (the goodwill leak: last 7 paid days)', () => {
    expect(validFor('PARISH', expiryAt(6))).toEqual(BOTH);
  });

  it('PARISH in grace (−2d) → both', () => {
    expect(validFor('PARISH', expiryAt(-2))).toEqual(BOTH);
  });

  it('PARISH beyond grace (−10d, card shows FREE) → both (past-due, not restricted)', () => {
    expect(validFor('PARISH', expiryAt(-10))).toEqual(BOTH);
  });

  it('PARISH with no expiry → both (defensive)', () => {
    expect(validFor('PARISH', undefined)).toEqual(BOTH);
  });

  it('no tier → both', () => {
    expect(getValidTiers('FREE', undefined, undefined, NOW)).toEqual(BOTH);
  });
});

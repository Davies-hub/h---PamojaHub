import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_POLL_MAX_ATTEMPTS } from '../constants/subscription';
import { SubscriptionPollVerdict, pollReducer } from '../utils/subscription';

// Build a poll verdict (the mapped /subscriptions/{id}/status/ shape). Defaults to a
// fresh PENDING (not stale) — the common in-flight tick.
function verdict(over: Partial<SubscriptionPollVerdict> = {}): SubscriptionPollVerdict {
  return {
    status: 'PENDING',
    tier: 'GROWTH',
    subscriptionExpiresAt: null,
    stale: false,
    ...over,
  };
}

const MAX = SUBSCRIPTION_POLL_MAX_ATTEMPTS;

describe('pollReducer — renew pay-and-watch terminals (clone of the donation poll)', () => {
  it('SUCCESSFUL verdict → success, carrying tier + new expiry', () => {
    const out = pollReducer('confirming', {
      verdict: verdict({ status: 'SUCCESSFUL', tier: 'PARISH', subscriptionExpiresAt: '2026-07-21T00:00:00Z' }),
      attempts: 1,
      maxAttempts: MAX,
    });
    expect(out.state).toBe('success');
    expect(out.success).toEqual({ tier: 'PARISH', expiresAt: '2026-07-21T00:00:00Z' });
  });

  it('FAILED verdict → failed', () => {
    const out = pollReducer('confirming', { verdict: verdict({ status: 'FAILED' }), attempts: 1, maxAttempts: MAX });
    expect(out.state).toBe('failed');
    expect(out.success).toBeUndefined();
  });

  it('PENDING & stale → unconfirmed (does not wait out the bound)', () => {
    const out = pollReducer('confirming', {
      verdict: verdict({ status: 'PENDING', stale: true }),
      attempts: 1,            // well below the bound
      maxAttempts: MAX,
    });
    expect(out.state).toBe('unconfirmed');
  });

  it('bound exhausted while PENDING → unconfirmed (never failed)', () => {
    const out = pollReducer('confirming', {
      verdict: verdict({ status: 'PENDING', stale: false }),
      attempts: MAX,          // last allowed attempt
      maxAttempts: MAX,
    });
    expect(out.state).toBe('unconfirmed');
  });

  it('PENDING within the bound (not stale) → keep confirming', () => {
    const out = pollReducer('confirming', { verdict: verdict(), attempts: 1, maxAttempts: MAX });
    expect(out.state).toBe('confirming');
  });

  it('network blip (verdict null) within the bound → keep confirming (non-terminal)', () => {
    const out = pollReducer('confirming', { verdict: null, attempts: 1, maxAttempts: MAX });
    expect(out.state).toBe('confirming');
  });

  it('blip on the LAST attempt → unconfirmed (bound wins, no failure claim)', () => {
    const out = pollReducer('confirming', { verdict: null, attempts: MAX, maxAttempts: MAX });
    expect(out.state).toBe('unconfirmed');
  });

  it('late SUCCESSFUL after a shown terminal is IGNORED (terminal cannot be overridden)', () => {
    // Already unconfirmed; a straggler SUCCESSFUL must not flip the shown state.
    const out = pollReducer('unconfirmed', {
      verdict: verdict({ status: 'SUCCESSFUL', subscriptionExpiresAt: '2026-07-21T00:00:00Z' }),
      attempts: 2,
      maxAttempts: MAX,
    });
    expect(out.state).toBe('unconfirmed');
    expect(out.success).toBeUndefined();
  });

  it('late verdicts cannot override success OR failed either', () => {
    expect(pollReducer('success', { verdict: verdict({ status: 'FAILED' }), attempts: 3, maxAttempts: MAX }).state)
      .toBe('success');
    expect(pollReducer('failed', { verdict: verdict({ status: 'SUCCESSFUL' }), attempts: 3, maxAttempts: MAX }).state)
      .toBe('failed');
  });
});

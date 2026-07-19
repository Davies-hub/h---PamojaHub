import { useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

export interface PolledFocusRefetchOptions {
  /** Tick cadence in ms. Callers keep their OWN named constant — this hook exports no
   *  default on purpose: the payouts screen runs TWO polls (a 3s verdict poll and this
   *  45s list poll) and its two-names-because-two-mechanisms split must survive. */
  intervalMs: number;
  /**
   * All guards AND the refetch call(s) go HERE — the hook never inspects it. Whole-tick
   * skips are early-returns at the top of this fn; per-refetch guards (e.g. an asymmetric
   * has-data check) wrap the individual call.
   *
   * Do NOT add a separate `shouldSkip` param. A two-place guard API silently breaks
   * asymmetric per-call gating: a whole-tick skip cannot express "refetch A but not B",
   * which is exactly what the Overview dashboard needs (stats loaded, campaigns not →
   * refresh stats ONLY). Expressed as a whole-tick skip that becomes both-or-neither —
   * it compiles, type-checks, reads fine in review, and changes behaviour.
   */
  onTick: () => void;
  /**
   * __DEV__ log discriminator, e.g. 'overview-poll'. REQUIRED and load-bearing: the live
   * XHR-stub gate harness keys its start/stop assertions off these exact strings. Do NOT
   * remove as "unused" — it is used by the gate, not by the app.
   */
  label: string;
}

/**
 * Focused polling scaffolding, extracted verbatim from the three inline copies it now
 * replaces (treasurer Overview, treasurer Campaigns, treasurer Payouts) — those three
 * were byte-identical apart from the log label, the tick body, the interval constant
 * and the deps array, so only the scaffolding lives here.
 *
 * The interval is armed only while the screen is FOCUSED **and** the app is FOREGROUNDED
 * — both conditions, because a blurred tab or a backgrounded app would otherwise keep
 * burning battery, data, and backend requests for a screen nobody is looking at. It is
 * cleared on blur (useFocusEffect cleanup) and on background (AppState listener).
 *
 * This hook owns ONLY the scaffolding: useFocusEffect + AppState + timer + start/stop +
 * cleanup. Guards, refetch calls, and error handling all belong to the caller's `onTick`.
 */
export function usePolledFocusRefetch({
  intervalMs,
  onTick,
  label,
}: PolledFocusRefetchOptions): void {
  // Latest onTick, held in a ref so it is NOT an effect dep (it's a fresh closure each
  // render; depending on it would re-subscribe the focus effect every render — tearing
  // down and rebuilding the interval continuously, which silently kills the poll).
  // Same idiom as useFocusRefetch.ts:41-44's fetcherRef.
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const start = () => {
        if (timer) return;
        if (__DEV__) console.log(`[${label}] started`);
        timer = setInterval(() => onTickRef.current(), intervalMs);
      };
      const stop = () => {
        if (!timer) return;
        if (__DEV__) console.log(`[${label}] stopped`);
        clearInterval(timer);
        timer = null;
      };
      if (AppState.currentState === 'active') start();
      const sub = AppState.addEventListener('change', s => {
        if (s === 'active') start();
        else stop();
      });
      return () => { stop(); sub.remove(); };
    }, [intervalMs, label]),
  );
}

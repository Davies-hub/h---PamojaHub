import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

export type FetchStatus = 'loading' | 'error' | 'ok';

export interface FocusRefetchResult<T> {
  data: T | null;
  status: FetchStatus;
  /** True after a BACKGROUND refetch fails — data is still last-good and stays on screen. */
  refetchError: boolean;
  /** Re-run the fetch; from the error state this returns to 'loading'. */
  retry: () => void;
}

/**
 * Fetch on every screen FOCUS, but show the full-screen spinner ONLY the first time
 * (no data yet). On every subsequent focus the fetch runs in the BACKGROUND: the
 * last-good data stays on screen, and a background-refresh FAILURE never blanks the
 * screen (status stays 'ok', `refetchError` flips true).
 *
 *   - First focus / no data : status='loading' → fetch → 'ok'+data, or 'error'.
 *   - Subsequent focus      : NO 'loading', NO clearing data; fetch in background.
 *                             success swaps data (status stays 'ok'); failure keeps
 *                             data + 'ok' (soft refetchError).
 *   - retry()               : re-runs; from 'error' it returns to 'loading'.
 *
 * Re-entrancy: each run takes a monotonically increasing sequence number, and the
 * useFocusEffect cleanup flips `active` false on blur/unmount. A resolved promise is
 * applied only if it is BOTH the latest run AND its focus is still active — so a slow
 * response (or a blur→refocus race) can never overwrite newer data.
 */
export function useFocusRefetch<T>(fetcher: () => Promise<T>): FocusRefetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<FetchStatus>('loading');
  const [refetchError, setRefetchError] = useState(false);

  // Latest fetcher, held in a ref so it is NOT an effect dep (it's a fresh closure
  // each render; depending on it would re-subscribe the focus effect every render).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Whether we currently hold data — read inside async callbacks without being a dep.
  const hasDataRef = useRef(false);
  hasDataRef.current = data !== null;

  // Monotonic run id: only the newest run may commit its result.
  const seqRef = useRef(0);

  const run = useCallback((isActive: () => boolean) => {
    const foreground = !hasDataRef.current;   // first load → spinner; otherwise background
    if (foreground) setStatus('loading');
    setRefetchError(false);
    const mySeq = ++seqRef.current;
    fetcherRef.current()
      .then((result) => {
        if (!isActive() || mySeq !== seqRef.current) return;   // stale / blurred → drop
        setData(result);
        setStatus('ok');
      })
      .catch(() => {
        if (!isActive() || mySeq !== seqRef.current) return;
        if (hasDataRef.current) {
          // Background refresh failed: keep last-good data, do NOT blank the screen.
          setRefetchError(true);
          setStatus('ok');
        } else {
          setStatus('error');
        }
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      run(() => active);
      return () => { active = false; };
    }, [run]),
  );

  const retry = useCallback(() => {
    // Invoked from the focused error state; run as foreground (returns to 'loading').
    run(() => true);
  }, [run]);

  return { data, status, refetchError, retry };
}

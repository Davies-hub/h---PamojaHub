import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthUser } from '../types';
import { authService } from '../services/auth.service';
import {
  setAccessTokenCache,
  clearAccessTokenCache,
  setForcedLogoutHandler,
  isDefinitiveAuthFailure,
} from '../services/api';
import { getToken, clearTokens } from '../services/storage';

// Session-restore retry backoff. A NETWORK blip on launch must NOT log the user out:
// the token is KEPT, the OFFLINE screen shows, and restore retries with capped backoff
// (2s, 4s, 8s … 30s) until the network returns (success → hydrate) or a real 401/403
// occurs (→ clean logout). 2s floor, 30s cap.
const RESTORE_BACKOFF_FLOOR_MS = 2000;
const RESTORE_BACKOFF_CAP_MS = 30000;

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isLoading: boolean;       // true while hydrating the session on launch (incl. /auth/me)
  restoreFailed: boolean;   // a stored token existed but /auth/me returned a real 401/403 → guard routes to login
  restoreOffline: boolean;  // a stored token exists but restore hit a NETWORK/transient error → guard shows the OFFLINE screen; tokens KEPT, auto-retrying
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  retryRestore: () => void; // manual "Retry" from the offline screen (resets backoff, attempts now)
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreOffline, setRestoreOffline] = useState(false);

  // Retry-loop bookkeeping (mirrors the proven poller discipline used elsewhere, e.g.
  // the withdrawals force-retry poll): mountedRef guards setState-after-unmount;
  // retryTimerRef holds the single in-flight backoff timer; retryAttemptRef drives the
  // exponential delay; settledRef LATCHES once restore reaches a TERMINAL outcome
  // (success or clean-logout) so a late/scheduled retry can never override settled state.
  const mountedRef = useRef(true);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const settledRef = useRef(false);
  // Stable indirection so a scheduled retry always invokes the LATEST attemptRestore
  // without attemptRestore having to depend on itself.
  const attemptRestoreRef = useRef<() => void>(() => {});

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const attemptRestore = useCallback(async () => {
    // TOKEN-PRESENCE PRECHECK (every attempt). No access token → finalize logged-out
    // and STOP. This covers two cases with ONE check: (a) never-logged-in (no token at
    // start → stay on public/login, no offline screen, no retry); (b) the token was
    // wiped mid-retry by something authoritative (the axios interceptor's forceLogout on
    // a dead refresh) → go to login, do NOT loop against a missing token.
    const access = await getToken('accessToken');
    if (!access) {
      if (!mountedRef.current) return;
      settledRef.current = true;
      clearRetryTimer();
      setRestoreOffline(false);
      setIsLoading(false);
      return;
    }
    const refresh = await getToken('refreshToken');
    setAccessTokenCache(access);
    try {
      const restored = await authService.getCurrentUser();   // GET /auth/me
      if (!mountedRef.current) return;
      // SUCCESS → full hydration (user incl. role/churchName/churchStatus via mapUser).
      settledRef.current = true;
      clearRetryTimer();
      setUser(restored);
      setAccessToken(access);
      setRefreshToken(refresh);
      setRestoreFailed(false);
      setRestoreOffline(false);
      setIsLoading(false);
    } catch (error) {
      if (!mountedRef.current) return;
      if (isDefinitiveAuthFailure(error)) {
        // REAL 401/403 → the token is dead. CLEAN LOGOUT (the previously-correct
        // behavior, now gated on a real auth failure instead of ANY error).
        settledRef.current = true;
        clearRetryTimer();
        clearAccessTokenCache();
        await clearTokens();
        if (!mountedRef.current) return;
        setUser(null);
        setAccessToken(null);
        setRefreshToken(null);
        setRestoreFailed(true);
        setRestoreOffline(false);
        setIsLoading(false);
      } else {
        // TRANSIENT / NETWORK error → KEEP the tokens, show the OFFLINE screen, and
        // schedule a capped-backoff retry. The session may still be valid; clearing the
        // token here is exactly what used to make a momentary blip a permanent logout.
        setRestoreOffline(true);
        setIsLoading(false);
        if (settledRef.current) return;
        const delay = Math.min(
          RESTORE_BACKOFF_FLOOR_MS * 2 ** retryAttemptRef.current,
          RESTORE_BACKOFF_CAP_MS,
        );
        retryAttemptRef.current += 1;
        clearRetryTimer();
        retryTimerRef.current = setTimeout(() => {
          if (!mountedRef.current || settledRef.current) return;
          attemptRestoreRef.current();
        }, delay);
      }
    }
  }, [clearRetryTimer]);

  // Keep the ref pointed at the latest attemptRestore (closes the retry loop without a
  // self-referential useCallback dependency).
  useEffect(() => {
    attemptRestoreRef.current = attemptRestore;
  }, [attemptRestore]);

  // Run restore ONCE on mount; tear down the timer + mounted flag on unmount so a
  // pending retry can't fire (or setState) after the provider unmounts.
  useEffect(() => {
    mountedRef.current = true;
    attemptRestore();
    return () => {
      mountedRef.current = false;
      clearRetryTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual "Retry" from the offline screen: reset backoff to the floor and attempt NOW
  // (no-op once restore has settled — success or clean logout).
  const retryRestore = useCallback(() => {
    if (settledRef.current) return;
    retryAttemptRef.current = 0;
    clearRetryTimer();
    attemptRestoreRef.current();
  }, [clearRetryTimer]);

  useEffect(() => {
    // Bridge the axios interceptor's forced-logout (a failed token refresh) into React
    // state. api.ts has already cleared the in-memory cache + persisted tokens; here we
    // clear the React session and flag restoreFailed so RootNavigator routes to /login —
    // the SAME path a dead-token reload uses. Also LATCH settled + stop any restore retry
    // loop so a pending offline retry can't resurrect the session. (setters are stable.)
    setForcedLogoutHandler(() => {
      settledRef.current = true;
      clearRetryTimer();
      setUser(null);
      setAccessToken(null);
      setRefreshToken(null);
      setRestoreOffline(false);
      setRestoreFailed(true);
    });
    return () => setForcedLogoutHandler(null);
  }, [clearRetryTimer]);

  const login = async (email: string, password: string): Promise<AuthUser> => {
    const { user: loggedInUser, accessToken: at, refreshToken: rt } =
      await authService.login(email, password);
    // A successful login is a terminal restore outcome too — stop any retry loop.
    settledRef.current = true;
    clearRetryTimer();
    setRestoreFailed(false);
    setRestoreOffline(false);
    setUser(loggedInUser);
    setAccessToken(at);
    setRefreshToken(rt);
    return loggedInUser;
  };

  const logout = async () => {
    // Clear React state FIRST (synchronously) so RootNavigator sees user=null before
    // the sign-out handler's router.replace runs — otherwise the auth guard would
    // bounce a still-"logged-in" user back to their dashboard. The service call reads
    // the refresh token from STORAGE + the access token from the in-memory cache (not
    // React state), so clearing React state first is safe: it then does the best-effort
    // server revoke (POST /auth/logout/) and the unconditional local token clear.
    setUser(null);
    setAccessToken(null);
    setRefreshToken(null);
    setRestoreFailed(false);
    setRestoreOffline(false);
    await authService.logout();
  };

  return React.createElement(
    AuthContext.Provider,
    {
      value: {
        user,
        accessToken,
        refreshToken,
        isLoading,
        restoreFailed,
        restoreOffline,
        login,
        logout,
        retryRestore,
      },
    },
    children
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}

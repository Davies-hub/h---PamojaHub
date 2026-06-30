import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

import { clearTokens, getToken, setToken } from './storage';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000/api/v1';

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ── In-memory access-token cache ────────────────────────────────────────────────
// The request interceptor runs SYNCHRONOUSLY, but persistent storage reads are
// async. So the interceptor reads this in-memory cache (the source of truth for
// outgoing requests); services/storage.ts is the source of truth across launches
// and hydrates this cache on app start (see stores/auth.store.ts).
let accessTokenCache: string | null = null;

export function setAccessTokenCache(token: string | null): void {
  accessTokenCache = token;
}

export function clearAccessTokenCache(): void {
  accessTokenCache = null;
}

export function getStoredAccessToken(): string | null {
  return accessTokenCache;
}

// ── Token persistence (shared by login AND refresh so they can't drift) ──────────
// login() in auth.service.ts and performRefresh() below BOTH call this, so the
// access+refresh pair is always written the same way: persisted via storage.ts AND
// primed into the in-memory cache, in one place.
export async function persistTokens(access: string, refresh: string): Promise<void> {
  await setToken('accessToken', access);
  await setToken('refreshToken', refresh);
  setAccessTokenCache(access);
}

// ── Forced-logout bridge ──────────────────────────────────────────────────────
// The response interceptor runs OUTSIDE React, so it can't clear the auth store or
// route. The store registers this handler on mount (stores/auth.store.ts); a failed
// refresh calls it, funnelling into the SAME forced-logout path as a dead-token
// reload (store clears the user + sets restoreFailed → RootNavigator routes to
// /login). One mechanism, not two.
let forcedLogoutHandler: (() => void) | null = null;

export function setForcedLogoutHandler(fn: (() => void) | null): void {
  forcedLogoutHandler = fn;
}

// ── Request interceptor: attach the cached access token ──────────────────────────
api.interceptors.request.use((config) => {
  const token = accessTokenCache;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Serialized single-flight refresh ─────────────────────────────────────────────
// The backend ROTATES on every refresh: it revokes the old RefreshToken row and
// issues a brand-new pair (accounts/views.py TokenRefreshView). So the old refresh
// token is dead the instant the first refresh succeeds — two concurrent refreshes
// would race and the second would send an already-revoked token (→ 401). We keep
// ONE in-flight refresh promise; concurrent 401s all await the same one.
let refreshPromise: Promise<string> | null = null;

// Discriminable tag for the "no refresh token stored" case. This is a DEFINITIVE end of
// session (nothing to refresh with), NOT a network failure — the refresh-failure handler
// below keys on this CODE (never the message string, which is fragile) to force a logout.
const NO_REFRESH_TOKEN = 'NO_REFRESH_TOKEN';

async function performRefresh(): Promise<string> {
  const refresh = await getToken('refreshToken');
  if (!refresh) {
    throw Object.assign(new Error('No refresh token to refresh with.'), {
      code: NO_REFRESH_TOKEN,
    });
  }
  // Bare axios (NOT the `api` instance): carries no Authorization header and does
  // NOT re-enter THIS response interceptor — that is the loop guard for the refresh
  // call itself (a 401 from the refresh endpoint must never trigger another refresh).
  const { data } = await axios.post<{ access: string; refresh: string }>(
    `${API_BASE_URL}/auth/token/refresh/`,
    { refresh },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
  );
  // Persist the ROTATED pair (new access AND new refresh) exactly as login does.
  await persistTokens(data.access, data.refresh);
  return data.access;
}

function refreshOnce(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function forceLogout(): Promise<void> {
  clearAccessTokenCache();
  await clearTokens();
  forcedLogoutHandler?.();
}

// ── Response interceptor: refresh-and-retry on 401 ───────────────────────────────
interface RetriableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as RetriableConfig | undefined;
    const status = error.response?.status;

    if (status !== 401 || !original) {
      return Promise.reject(error);
    }

    // Loop guard: this request already went through refresh + retry and STILL 401'd
    // → the new access token is no good either → give up → forced logout. (Prevents
    // refresh → 401 → refresh → … forever.)
    if (original._retried) {
      await forceLogout();
      return Promise.reject(error);
    }

    original._retried = true;
    try {
      const newAccess = await refreshOnce();
      // Re-running `api(original)` re-fires the request interceptor, which attaches
      // the now-refreshed cached token; we also set it explicitly for clarity.
      original.headers = original.headers ?? {};
      original.headers.Authorization = `Bearer ${newAccess}`;
      return api(original); // retry ONCE with the new token
    } catch (refreshError) {
      // The refresh itself failed. Log out ONLY on positive evidence the session is over:
      // a real 401/403 from the refresh endpoint (token expired/revoked/unknown) OR no
      // refresh token to begin with. A no-RESPONSE network failure (the refresh request
      // never reached the server) is a transient blip, NOT a dead session — we KEEP the
      // tokens so the next call (or a relaunch) can recover. (Inverse of the D-restore
      // conflation: a network blip must never nuke the session.) Concurrent requests
      // awaiting the same failed refreshPromise all land here with the same refreshError,
      // so they all reach the same verdict.
      const noRefreshToken =
        (refreshError as { code?: string } | undefined)?.code === NO_REFRESH_TOKEN;
      if (isDefinitiveAuthFailure(refreshError) || noRefreshToken) {
        await forceLogout();
      }
      // Either way the ORIGINAL request failed → reject it (the caller sees a failed call).
      // We reject the original 401 `error`, not `refreshError`; on the network-blip path
      // the session stays intact and only this in-flight request is lost.
      return Promise.reject(error);
    }
  }
);

// ── Restore-time error discrimination (used by the session-restore loop) ──────────
// A DEFINITIVE auth failure is ONLY a real 401/403 RESPONSE: the server answered and
// rejected the token. Everything else is transient/retriable and must NOT clear the
// session — returning false here keeps the tokens and lets the restore loop retry:
//   • no response at all  → network down / DNS / connection refused (error.response undefined)
//   • ECONNABORTED / ERR_NETWORK / timeout
//   • any non-auth HTTP status (5xx, etc.)
// NOTE: a non-401/403 reaching the restore catch AFTER the response interceptor above
// means a network failure — either the original request's, or a refresh that itself failed
// on the network. The interceptor now KEEPS the tokens on a refresh network blip (it only
// wipes on a definitive auth failure / missing refresh token), so restore finds the tokens
// still present and retries. The token-presence re-check in attemptRestore (stores/auth.store.ts)
// still covers the case where forceLogout DID clear them (a real dead session) — we never
// loop against a token the interceptor already cleared — not by the error shape alone.
export function isDefinitiveAuthFailure(error: unknown): boolean {
  const status = (error as AxiosError | undefined)?.response?.status;
  return status === 401 || status === 403;
}

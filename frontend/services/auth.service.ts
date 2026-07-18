import { Platform } from 'react-native';
import { AuthUser, ChurchStatus } from '../types';
import { api, clearAccessTokenCache, persistTokens } from './api';
import { BackendUser, mapUser, mapRegisterPayload, RegisterForm } from './mappers';
import { clearTokens, getToken } from './storage';

// An optional church logo picked at registration (expo-image-picker asset subset).
export interface RegisterLogo {
  uri: string;
  fileName?: string;
  mimeType?: string;
}

// Shared authenticated-user payload (login AND /auth/me return this same shape —
// see backend _auth_user_payload). buildUser() is the single place it becomes an
// AuthUser, so the two endpoints can't drift.
interface AuthUserPayload {
  user: BackendUser;
  church_status: ChurchStatus | null;
  church_rejection_reason?: string;   // present only when church_status === 'REJECTED'
}
interface LoginResponse extends AuthUserPayload {
  access: string;
  refresh: string;
}

function buildUser(data: AuthUserPayload): AuthUser {
  const user = mapUser(data.user, data.church_status);
  if (data.church_rejection_reason) {
    user.churchRejectionReason = data.church_rejection_reason;
  }
  return user;
}

export const authService = {
  async login(
    email: string,
    password: string,
  ): Promise<{ user: AuthUser; accessToken: string; refreshToken: string }> {
    // Errors propagate (axios throws on non-2xx). The screen reads
    // error.response.data.detail — 401 'Invalid email or password.', 429 rate-limit
    // detail, or field errors. We do NOT swallow them into a generic string here.
    const { data } = await api.post<LoginResponse>('/auth/login/', { email, password });

    // Same persistence path the refresh interceptor uses (api.ts persistTokens) —
    // storage + in-memory cache, written identically so login and refresh can't drift.
    await persistTokens(data.access, data.refresh);

    return { user: buildUser(data), accessToken: data.access, refreshToken: data.refresh };
  },

  // Session restore (GET /auth/me). The request interceptor attaches the cached
  // access token; the response is the same payload shape as login, so buildUser/
  // mapUser applies identically. A 401 here (no/invalid/expired token) propagates
  // so the store can clear the dead session.
  async getCurrentUser(): Promise<AuthUser> {
    const { data } = await api.get<AuthUserPayload>('/auth/me/');
    return buildUser(data);
  },

  async register(data: RegisterForm, logo?: RegisterLogo): Promise<{ logoFailed: boolean }> {
    // Register does NOT auto-login: the backend returns 201 {user, church_status}
    // with NO token (church is PENDING, awaiting Super-Admin approval). So we do
    // NOT store a token / setAccessTokenCache / route to a dashboard. Errors
    // PROPAGATE (axios throws on non-2xx) so the form surfaces the real backend
    // messages: duplicate email → field error {official_email:[...]} or 400
    // {detail:'An account with this email already exists.'}; weak password →
    // {password:[...]}; missing address → {address:[...]}.
    //
    // NO logo → the ORIGINAL JSON path, byte-identical (no behaviour change).
    if (!logo) {
      await api.post('/auth/register/', mapRegisterPayload(data));
      return { logoFailed: false };
    }

    // WITH logo → ONE multipart POST carrying the text fields + the image under the
    // wire field name 'logo' (backend request.FILES.get('logo')). The logo is handled
    // POST-COMMIT server-side: the church commits first, so a logo failure does NOT
    // fail registration — it comes back as body.logo_failed=true, which the caller
    // surfaces as a non-blocking "add it later" notice. Cross-platform FormData +
    // Content-Type split mirror churchesService.uploadLogo exactly (web needs a real
    // Blob and an unset Content-Type so the browser writes the boundary; native
    // uploads the {uri,name,type} triple and MUST set multipart/form-data itself).
    const body = mapRegisterPayload(data);
    const form = new FormData();
    Object.entries(body).forEach(([k, v]) => {
      if (v !== undefined && v !== null) form.append(k, String(v));
    });
    const name = logo.fileName || 'logo.jpg';
    const type = logo.mimeType || 'image/jpeg';
    if (Platform.OS === 'web') {
      const blob = await (await fetch(logo.uri)).blob();
      form.append('logo', blob, name);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append('logo', { uri: logo.uri, name, type } as any);
    }
    const { data: resp } = await api.post('/auth/register/', form, {
      headers: { 'Content-Type': Platform.OS === 'web' ? undefined : 'multipart/form-data' },
      transformRequest: (d) => d,               // don't let axios JSON-stringify the FormData
    });
    return { logoFailed: !!(resp as { logo_failed?: boolean })?.logo_failed };
  },

  async logout(): Promise<void> {
    // Best-effort server-side revoke, then UNCONDITIONAL local clear.
    // Read the refresh token from storage BEFORE clearing so we can ask the server
    // to revoke it. The api request interceptor attaches the Bearer access token
    // automatically; LogoutView (IsAuthenticated) revokes the row whose token_hash
    // matches, scoped to request.user, and always returns 200. We send { refresh }
    // only when we actually have one. ANY failure (network down, 401, timeout) is
    // SWALLOWED — a failed server call must never block local logout.
    const refresh = await getToken('refreshToken');
    try {
      await api.post('/auth/logout/', refresh ? { refresh } : {});
    } catch {
      // best-effort only — ignore and continue to the local clear below
    }
    clearAccessTokenCache();
    await clearTokens();
  },

  async requestPasswordReset(email: string): Promise<void> {
    // Enumeration-opaque: the backend ALWAYS returns 200 for a valid email input,
    // whether or not it maps to a user (an OTP email is sent only on a match). So a
    // resolved promise means "request accepted", NOT "account exists". Errors
    // PROPAGATE (axios throws on non-2xx) so the screen can map 429 (3/h throttle,
    // mapped from django-ratelimit by common.exceptions) and network failures. We
    // never branch on the response body here.
    await api.post('/auth/password-reset/request/', { email });
  },

  async confirmPasswordReset(email: string, otpCode: string, newPassword: string): Promise<void> {
    // Wire field name is `otp_code` (NOT `otp`) — matches the backend serializer.
    // Success is 200 with an EMPTY body (nothing to read). Errors PROPAGATE so the
    // screen maps the two 400 shapes: {detail:'Invalid or expired code.'} (collapses
    // wrong/expired/used/exhausted — do NOT distinguish) and {new_password:[...]}
    // (server password policy, beyond the client length≥8 check).
    await api.post('/auth/password-reset/confirm/', {
      email,
      otp_code: otpCode,
      new_password: newPassword,
    });
  },
};

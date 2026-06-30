// Bare axios client for Campaign-Treasurer PORTAL-TOKEN calls (X-Portal-Token).
//
// WHY a SEPARATE instance from services/api.ts: the shared `api` instance has a
// RESPONSE interceptor that treats ANY 401 as a JWT problem — it tries to refresh the
// JWT and, on failure, force-logs-out and routes to /login (api.ts). But a portal-token
// failure (expired / revoked / wrong-IP / unknown token) ALSO returns 401 (curl-confirmed;
// DRF NotAuthenticated, because the project default JWTAuthentication is the wired
// authenticator and a portal call carries no Bearer). If portal calls went through `api`,
// that 401 would be hijacked by the JWT refresh-retry and a public phone-OTP visitor (who
// has NO JWT) would be bounced to the JWT login screen.
//
// So this client has NO request interceptor (no JWT Bearer — portal auth is the
// X-Portal-Token header, threaded explicitly per call) and NO response interceptor (no
// refresh-retry). A portal 401/403 reaches the caller UNTOUCHED, where the screen's
// auth-loss chokepoint (handlePortalAuthLost) routes it back to phone re-entry.
import axios from 'axios';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000/api/v1';

export const portalClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

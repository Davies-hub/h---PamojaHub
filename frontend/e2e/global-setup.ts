import type { FullConfig } from '@playwright/test';

// Clears the dev backend's in-process locmem rate-limit cache before the suite
// runs, so repeated local runs don't accumulate against the per-IP 3/h cap on
// the password-reset request endpoint (localhost is always the same IP). The
// endpoint is DEBUG-only (config/urls.py) — it does not exist in production and
// changes no rate-limit logic. Non-fatal if unreachable: the suite still runs.
async function globalSetup(_config: FullConfig) {
  const url = 'http://localhost:8000/api/v1/dev/reset-ratelimit/';
  try {
    const res = await fetch(url, { method: 'POST' });
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.log('[global-setup] dev rate-limit cache cleared');
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[global-setup] rate-limit reset returned ${res.status} (continuing)`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[global-setup] rate-limit reset unreachable (continuing):', err);
  }
}

export default globalSetup;

import { test, expect, Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// Back-button regression suite.
//
// Guards the two bugs found in the A6 live pass:
//   1. REGRESSION — register/reset back button rendered off-screen (y=-142) and
//      unreachable when the screen overflowed the viewport. The `inViewport`
//      assertion below is the one that catches it.
//   2. Pre-existing deep-link no-ops on bare router.back() — now guarded with a
//      canGoBack()?back():replace(parent) fallback, asserted via the resulting route.
//
// Every back button is checked in BOTH scenarios (navigated + deep-linked) at
// BOTH widths (project matrix: desktop-1400 / phone-375).
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:8081';

// Gated-screen creds come from the environment so no secrets live in the repo.
// Set these to the seeded dev accounts to exercise the treasurer/super cases;
// unset, those describe-blocks skip and the public+auth regression still runs.
const TREASURER_EMAIL = process.env.E2E_TREASURER_EMAIL || '';
const TREASURER_PW = process.env.E2E_TREASURER_PW || '';
const SUPER_EMAIL = process.env.E2E_SUPER_EMAIL || '';
const SUPER_PW = process.env.E2E_SUPER_PW || '';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function clearAuth(page: Page) {
  await page.goto(BASE + '/');
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
}

function pathOf(page: Page) {
  return page.evaluate(() => location.pathname);
}

async function expectPath(page: Page, expected: string) {
  await expect.poll(() => pathOf(page), { timeout: 8000 }).toBe(expected);
}

/** Measure a back button by aria-label: presence, position, in-viewport, and
 *  whether a real tap at its centre lands on it (elementFromPoint hit-test). */
async function backHealth(page: Page, label: string) {
  return page.evaluate((label) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const btns = Array.from(document.querySelectorAll('[role="button"]'))
      .filter(b => b.getAttribute('aria-label') === label);
    // A stack keeps parent screens mounted, so several same-labelled back buttons
    // can coexist. Measure every laid-out one, then prefer the genuinely usable
    // one (in-viewport AND hit-testable) — the active screen's. If none is usable,
    // fall back to the first so the failing measurement (e.g. y=-142) is reported.
    const cands = [] as Array<{ found: boolean; x: number; y: number; w: number; h: number; cx: number; cy: number; inViewport: boolean; hitTestable: boolean }>;
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const onScreen = cx >= 0 && cy >= 0 && cx < vw && cy < vh;
      const top = onScreen ? document.elementFromPoint(cx, cy) : null;
      cands.push({
        found: true,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height), cx, cy,
        inViewport: r.top >= 0 && r.left >= 0 && r.top < vh && r.left < vw,
        hitTestable: !!top && (top === b || b.contains(top)),
      });
    }
    if (!cands.length) return { found: false, x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0, inViewport: false, hitTestable: false };
    return cands.find(c => c.inViewport && c.hitTestable) || cands.find(c => c.hitTestable) || cands[0];
  }, label);
}

/** The core regression assertion. `inViewport` (y >= 0) is what would have caught
 *  the y=-142 clip; `hitTestable` catches an overlay swallowing the tap. */
async function assertBackHealthy(page: Page, label: string) {
  // Wait for the target screen to render a back button that is laid out, in the
  // viewport, AND hit-testable — so a slow bundle/hydration or a not-yet-composited
  // fixed overlay isn't mistaken for a real failure. (A genuine bug — clipped or
  // overlaid — never satisfies this, so the timeout still yields a clear failure.)
  await page.waitForFunction(
    (label) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const btns = Array.from(document.querySelectorAll('[role="button"]'))
        .filter(b => b.getAttribute('aria-label') === label);
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.top < 0 || r.left < 0 || r.top >= vh) continue;
        const t = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        if (t && (t === b || b.contains(t))) return true;
      }
      return false;
    },
    label, { timeout: 15000 },
  ).catch(() => { /* fall through to a clear assertion below */ });
  const h = await backHealth(page, label);
  // Core reachability — this is what catches the y=-142 clip (inViewport) and an
  // overlay swallowing the tap (hitTestable). Asserted for EVERY back button.
  expect(h.found, `back button "${label}" present in DOM`).toBe(true);
  expect(h.inViewport, `back button "${label}" within the viewport (measured y=${h.y})`).toBe(true);
  expect(h.hitTestable, `back button "${label}" hit-testable at its centre`).toBe(true);
  return h;
}

// PART 2 standing rule — the window-edge floating/bar back buttons (auth + public).
// Not applied to the gated content-header back links, which sit at the content-column
// top-left by design (documented in the A7 report).
async function assertEdgeAnchored(page: Page, label: string) {
  const h = await assertBackHealthy(page, label);
  expect(h.y, `back button "${label}" near the top edge (y=${h.y})`).toBeLessThan(140);
  expect(h.x, `back button "${label}" at the left window edge (x=${h.x})`).toBeLessThan(160);
  return h;
}

async function clickBack(page: Page, label: string, opts: { edge?: boolean } = {}) {
  const h = opts.edge ? await assertEdgeAnchored(page, label) : await assertBackHealthy(page, label);
  await page.mouse.click(h.cx, h.cy);
  await page.waitForTimeout(500);
}

/** Click the first visible clickable whose aria-label/text contains `substr`. */
async function clickText(page: Page, substr: string) {
  // Wait for the target to render (Expo web hydration under load can lag).
  await page.waitForFunction(
    (substr) => Array.from(document.querySelectorAll('[role="button"],a')).some(e =>
      ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).toLowerCase().includes(substr.toLowerCase())),
    substr, { timeout: 15000 },
  ).catch(() => { /* fall through to a clear not-null assertion */ });
  const pt = await page.evaluate((substr) => {
    const els = Array.from(document.querySelectorAll('[role="button"],a'));
    const el = els.find(e =>
      ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).toLowerCase().includes(substr.toLowerCase()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  }, substr);
  expect(pt, `clickable containing "${substr}"`).not.toBeNull();
  await page.mouse.click(pt!.cx, pt!.cy);
  await page.waitForTimeout(800);
}

/** Wait for + click a role=button whose aria-label starts with `prefix` (backend-
 *  driven cards render async — never touch an undefined element). */
async function clickCard(page: Page, prefix: string) {
  await page.waitForFunction(
    (p) => Array.from(document.querySelectorAll('[role="button"],a')).some(e =>
      (e.getAttribute('aria-label') || '').startsWith(p) && e.getBoundingClientRect().width > 0),
    prefix, { timeout: 15000 },
  ).catch(() => { /* fall through to a clear not-null assertion */ });
  const pt = await page.evaluate((p) => {
    const el = Array.from(document.querySelectorAll('[role="button"],a'))
      .find(e => (e.getAttribute('aria-label') || '').startsWith(p) && e.getBoundingClientRect().width > 0);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  }, prefix);
  expect(pt, `card with aria starting "${prefix}"`).not.toBeNull();
  await page.mouse.click(pt!.cx, pt!.cy);
  await page.waitForTimeout(1000);
}

async function login(page: Page, email: string, pw: string) {
  await clearAuth(page);
  await page.goto(BASE + '/login');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('[role="button"]'))
      .some(e => (e.getAttribute('aria-label') || '').trim() === 'Sign in'),
    undefined, { timeout: 15000 },
  ).catch(() => {});
  await page.fill('input[type="email"], input[placeholder*="email" i]', email);
  await page.fill('input[type="password"], input[placeholder*="password" i]', pw);
  const pt = await page.evaluate(() => {
    const m = Array.from(document.querySelectorAll('[role="button"]'))
      .find(e => (e.getAttribute('aria-label') || '').trim() === 'Sign in');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  });
  expect(pt, 'Sign in button').not.toBeNull();
  await page.mouse.click(pt!.cx, pt!.cy);
  // Wait for the authed shell (tab bar). Auth is a real backend round-trip, so retry
  // the submit once if the tab bar hasn't mounted (covers a dropped first click).
  const tabUp = () => page.waitForFunction(() => document.querySelector('a[role="tab"]') !== null, undefined, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!(await tabUp())) {
    const again = await page.evaluate(() => {
      const m = Array.from(document.querySelectorAll('[role="button"]')).find(e => (e.getAttribute('aria-label') || '').trim() === 'Sign in');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
    });
    if (again) { await page.mouse.click(again.cx, again.cy); await tabUp(); }
  }
  await page.waitForTimeout(800);
}

async function clickTab(page: Page, href: string) {
  await page.waitForFunction(
    (href) => Array.from(document.querySelectorAll('a[role="tab"]')).some(x => x.getAttribute('href') === href),
    href, { timeout: 15000 },
  ).catch(() => {});
  const pt = await page.evaluate((href) => {
    const a = Array.from(document.querySelectorAll('a[role="tab"]')).find(x => x.getAttribute('href') === href);
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  }, href);
  expect(pt, `tab ${href}`).not.toBeNull();
  await page.mouse.click(pt!.cx, pt!.cy);
  await page.waitForTimeout(1200);
}

// ── Public screens ────────────────────────────────────────────────────────────

test.describe('public — campaigns list', () => {
  test('navigated', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/'); await page.waitForTimeout(600);
    await clickText(page, 'Browse Campaigns');
    await expectPath(page, '/campaigns');
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/');
  });
  test('deep-linked', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/campaigns'); await page.waitForTimeout(700);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/'); // guarded fallback (was a no-op on bare router.back())
  });
});

test.describe('public — churches list', () => {
  test('navigated', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/'); await page.waitForTimeout(600);
    await clickText(page, 'Browse Churches');
    await expectPath(page, '/churches');
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/');
  });
  test('deep-linked', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/churches'); await page.waitForTimeout(700);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/');
  });
});

test.describe('public — campaign detail', () => {
  test('navigated', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/campaigns'); await page.waitForTimeout(700);
    // open the first campaign card
    await clickCard(page, 'Donate via M-Pesa to');
    await expect.poll(() => pathOf(page)).toMatch(/^\/campaigns\/.+/);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/campaigns');
  });
  test('deep-linked', async ({ page }) => {
    await clearAuth(page);
    // discover a real slug from the list, then hard-load it
    await page.goto(BASE + '/campaigns'); await page.waitForTimeout(700);
    await clickCard(page, 'Donate via M-Pesa to');
    const slug = await pathOf(page);
    await page.goto(BASE + slug); await page.waitForTimeout(900);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/campaigns'); // guarded fallback
  });
});

test.describe('public — church detail', () => {
  test('navigated', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/churches'); await page.waitForTimeout(700);
    await clickCard(page, 'View ');
    await expect.poll(() => pathOf(page)).toMatch(/^\/churches\/.+/);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/churches');
  });
  test('deep-linked', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/churches'); await page.waitForTimeout(700);
    await clickCard(page, 'View ');
    const id = await pathOf(page);
    await page.goto(BASE + id); await page.waitForTimeout(900);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/churches'); // guarded fallback
  });
});

// ── Auth screens (the regression) ──────────────────────────────────────────────

test.describe('auth — login', () => {
  test('navigated', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/'); await page.waitForTimeout(600);
    await clickText(page, 'Sign In');
    await expectPath(page, '/login');
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/');
  });
  test('deep-linked', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/login'); await page.waitForTimeout(700);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/');
  });
});

test.describe('auth — register', () => {
  test('navigated from login', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/login'); await page.waitForTimeout(700);
    await clickText(page, 'Register your church');
    await expectPath(page, '/register');
    await clickBack(page, 'Go back', { edge: true }); // RED here pre-fix: back button at y=-142, off-screen
    await expectPath(page, '/login');
  });
  test('deep-linked', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/register'); await page.waitForTimeout(900);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/');
  });
});

test.describe('auth — reset-password', () => {
  test('navigated from login (email state)', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/login'); await page.waitForTimeout(700);
    await clickText(page, 'Forgot password');
    await expectPath(page, '/reset-password');
    await clickBack(page, 'Go back', { edge: true }); // RED here pre-fix at 375
    await expectPath(page, '/login');
  });
  test('deep-linked (email state)', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/reset-password'); await page.waitForTimeout(900);
    await clickBack(page, 'Go back', { edge: true });
    await expectPath(page, '/');
  });
  test('otp state back returns to email state', async ({ page }) => {
    await clearAuth(page);
    await page.goto(BASE + '/reset-password'); await page.waitForTimeout(900);
    // advance to OTP state (backend returns 200 for any email — enumeration-opaque).
    // Use a UNIQUE email per run so the per-email 3/h reset-request cap
    // (accounts/views.py) can never accumulate across repeated local runs.
    const otpEmail = `e2e-otp-${Date.now()}@example.com`;
    await page.fill('input[placeholder*="church.org" i], input[type="email"]', otpEmail);
    await clickText(page, 'Send OTP');
    // OTP state shows the 6-digit code inputs
    await expect.poll(async () =>
      page.evaluate(() => !!document.querySelector('[aria-label="Digit 1 of 6"]')),
      { timeout: 8000 }).toBe(true);
    await clickBack(page, 'Go back', { edge: true }); // must be healthy + return to the email state
    await expect.poll(async () =>
      page.evaluate(() => Array.from(document.querySelectorAll('[role="button"]'))
        .some(b => (b.getAttribute('aria-label') || '') === 'Send OTP')),
      { timeout: 8000 }).toBe(true);
    await expectPath(page, '/reset-password'); // state back, route unchanged
  });
});

// ── Gated screens (skipped unless dev creds are provided) ───────────────────────

// One login per role (repeated logins can trip backend throttling) — each test
// then exercises every back button for that role sequentially.
test.describe('treasurer', () => {
  test.skip(!TREASURER_EMAIL || !TREASURER_PW, 'set E2E_TREASURER_EMAIL / E2E_TREASURER_PW');

  test('campaign detail, new, and groups back buttons', async ({ page }) => {
    await login(page, TREASURER_EMAIL, TREASURER_PW);

    // Campaign detail → back to Campaigns
    await clickTab(page, '/campaigns');
    await clickCard(page, 'View details for');
    await page.waitForTimeout(500);
    await clickBack(page, 'Back to Campaigns');
    await expectPath(page, '/campaigns');

    // New campaign → back to Campaigns
    await clickTab(page, '/campaigns');
    await clickText(page, 'Create new campaign');
    await expectPath(page, '/campaigns/new');
    await clickBack(page, 'Back to Campaigns');
    await expectPath(page, '/campaigns');

    // Groups via the Campaigns "Group Labels" button → back to Campaigns
    // (router.navigate, history-independent — groups is a sibling hidden tab,
    // so router.back() would land on the FIRST tab, Overview, not the opener)
    await clickTab(page, '/campaigns');
    await clickText(page, 'Manage group labels');
    await expectPath(page, '/groups');
    await clickBack(page, 'Go back to Campaigns');
    await expectPath(page, '/campaigns');

    // Groups (deep-link) → same Campaigns target, history-independent
    await page.goto(BASE + '/groups'); await page.waitForTimeout(1500);
    await clickBack(page, 'Go back to Campaigns');
    await expectPath(page, '/campaigns');
  });
});

test.describe('super', () => {
  test.skip(!SUPER_EMAIL || !SUPER_PW, 'set E2E_SUPER_EMAIL / E2E_SUPER_PW');

  test('hidden-tab back buttons all return to More', async ({ page }) => {
    await login(page, SUPER_EMAIL, SUPER_PW);
    for (const item of ['Audit Log', 'Campaigns', 'Donations']) {
      await clickTab(page, '/more');
      await clickText(page, item);
      await clickBack(page, 'Go back to More', { edge: true });
      await expectPath(page, '/more');
    }
  });
});

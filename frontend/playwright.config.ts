import { defineConfig } from '@playwright/test';

// Back-button regression suite (added with the A7 back-button fix).
// Requires the dev stack running: Expo web on :8081 AND the Django API on
// :8000 with the seeded dev DB (public lists + auth need real data).
//   frontend:  npx expo start --web --port 8081
//   backend:   backend/venv/Scripts/python.exe backend/manage.py runserver 8000 --noreload
// Run:  npx playwright test          (both widths)
//       npx playwright test -g register   (just the register cases)
export default defineConfig({
  testDir: './e2e',
  // Clears the dev backend's locmem rate-limit cache once before the suite so
  // repeated local runs don't trip the per-IP 3/h password-reset cap.
  globalSetup: './e2e/global-setup.ts',
  // 90s per test: the cold Metro bundle pushed genuinely-passing tests to 41-56s,
  // so 60s left too little margin under load. The flake root cause (rate-limit
  // 429 on the OTP test) is fixed test-side, so this is pure bundle headroom.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // retries:0 — the flake cause (per-IP/per-email 3/h throttle on the reset-OTP
  // test) is removed at the harness level (unique email + globalSetup cache
  // reset), so retries must not be allowed to mask any real regression.
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8081',
    actionTimeout: 10_000,
  },
  // Each test runs at BOTH the desktop and phone widths — the y=-142 clip only
  // reproduced at specific viewport heights, so both are load-bearing.
  projects: [
    { name: 'desktop-1400', use: { viewport: { width: 1400, height: 900 } } },
    { name: 'phone-375', use: { viewport: { width: 375, height: 780 } } },
  ],
});

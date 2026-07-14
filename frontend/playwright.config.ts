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
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // One retry absorbs the occasional readiness/timeout flake when the whole suite
  // runs against a single local dev server under load (see the A7 notes).
  retries: 1,
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

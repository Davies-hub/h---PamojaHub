import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // e2e/ is Playwright's, driven by playwright.config.ts — vitest must never
    // collect it (its default include pattern would otherwise sweep *.spec.ts).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});

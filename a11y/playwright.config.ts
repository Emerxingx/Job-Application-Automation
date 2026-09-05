import { defineConfig, devices } from '@playwright/test';

/**
 * Stage 23 (ADR-0037) - the accessibility suite's runner.
 *
 * Runs axe-core (WCAG 2.0/2.1/2.2 A and AA rules) over the rendered pages of
 * a RUNNING application - `npm run a11y` against `A11Y_BASE_URL` (default
 * http://127.0.0.1:3000) - with the seeded demo account for the
 * authenticated surfaces. It is not part of `npm test`: it needs a built,
 * started app and a browser, so CI runs it as its own job (ci.yml
 * `accessibility`) and locally it is a separate command.
 *
 * The `setup` project signs in once and stores the session; the `chromium`
 * project depends on it and the authenticated groups load that state.
 *
 * `A11Y_CHROMIUM` points at a Chromium binary when the environment carries
 * one that Playwright's own download would duplicate (the Claude build
 * environment ships /opt/pw-browsers/chromium); unset, Playwright uses the
 * browser `npx playwright install chromium` fetched.
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'report/a11y-results.json' }]],
  outputDir: 'report/artifacts',
  use: {
    baseURL: process.env.A11Y_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    ...(process.env.A11Y_CHROMIUM ? { launchOptions: { executablePath: process.env.A11Y_CHROMIUM } } : {}),
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', testMatch: /.*\.spec\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'] } },
  ],
});

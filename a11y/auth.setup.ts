import { expect, test as setup } from '@playwright/test';

/**
 * Stage 23 (ADR-0037) - sign in ONCE for the whole accessibility run and hand
 * the session to every authenticated test through Playwright's storage
 * state. Signing in per page would trip the account rate limit (thirty
 * attempts per fifteen minutes, Stage 14) after the fifteenth page - which
 * is a correct refusal, not something the suite should work around.
 */
import { STORAGE_STATE } from './state';

const DEMO = { email: process.env.A11Y_EMAIL ?? 'demo@jobpilot.ai', password: process.env.A11Y_PASSWORD ?? 'demo1234' };

setup('sign in as the seeded demo account', async ({ page }) => {
  const res = await page.request.post('/api/auth/login', { data: DEMO });
  expect(res.ok(), `sign-in as the demo account failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.context().storageState({ path: STORAGE_STATE });
});

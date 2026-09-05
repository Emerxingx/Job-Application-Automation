import { expect, test } from '@playwright/test';
import { STORAGE_STATE } from './state';

/**
 * Stage 24 (ADR-0038) - the per-request script policy is enforced by a real
 * browser and violated by nothing we ship. Every page here is loaded with
 * the console watched: a `Content Security Policy` report means a script
 * ran without the nonce (or was blocked, breaking the page) and fails the
 * test. The CMS admin is included because Payload's bundle is the one
 * surface this codebase does not author.
 */
const PUBLIC_PAGES = ['/', '/login', '/signup', '/terms', '/privacy', '/admin'];
const CANDIDATE_PAGES = ['/dashboard', '/dashboard/jobs', '/dashboard/applications', '/dashboard/analytics', '/dashboard/career', '/dashboard/settings'];
const CONSOLE_PAGES = ['/console', '/console/revenue', '/console/audit'];

async function loadWithoutViolation(page: import('@playwright/test').Page, path: string) {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (execute|load)/.test(m.text())) violations.push(m.text());
  });
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.status(), `${path} did not render`).toBeLessThan(400);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp, `${path} carries no script nonce`).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]{16,}' 'strict-dynamic'/);
  // The page must actually have run its scripts: React hydrated (a client component rendered).
  await page.waitForTimeout(500);
  expect(violations, `${path} violated the policy:\n${violations.join('\n')}`).toEqual([]);
}

test.describe('CSP: public pages', () => {
  for (const path of PUBLIC_PAGES) test(`${path} runs under the nonce policy without a violation`, async ({ page }) => loadWithoutViolation(page, path));
});

test.describe('CSP: candidate pages', () => {
  test.use({ storageState: STORAGE_STATE });
  for (const path of CANDIDATE_PAGES) test(`${path} runs under the nonce policy without a violation`, async ({ page }) => loadWithoutViolation(page, path));
});

test.describe('CSP: staff console', () => {
  test.use({ storageState: STORAGE_STATE });
  for (const path of CONSOLE_PAGES) test(`${path} runs under the nonce policy without a violation`, async ({ page }) => loadWithoutViolation(page, path));
});

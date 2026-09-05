import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STORAGE_STATE } from './state';

/**
 * Stage 23 (ADR-0037) - WCAG 2.2 AA over the rendered pages.
 *
 * Every page a candidate, an organisation member or a staff member reaches
 * is loaded in a real browser and audited with axe-core against the WCAG
 * 2.0/2.1/2.2 A and AA rule sets. A violation fails the page's test with the
 * rule, the impact, the help text and the offending nodes, so the fix is
 * unambiguous. What axe cannot judge - reading order, meaningful link text
 * in context, keyboard traps that need interaction - is NOT claimed here;
 * the evidence document says so.
 *
 * The public pages need no session. The authenticated pages use the session
 * the `setup` project stored (the seeded demo account, `npm run db:seed`),
 * which is also on the staff allow-list when the server is started with
 * STAFF_EMAILS=demo@jobpilot.ai, so the console is covered too.
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const PUBLIC_PAGES = ['/', '/login', '/signup', '/terms', '/privacy'];

const CANDIDATE_PAGES = [
  '/dashboard',
  '/dashboard/jobs',
  '/dashboard/jobs/excluded',
  '/dashboard/applications',
  '/dashboard/analytics',
  '/dashboard/documents',
  '/dashboard/evidence',
  '/dashboard/career',
  '/dashboard/resume',
  '/dashboard/agents',
  '/dashboard/agents/new',
  '/dashboard/interview-prep',
  '/dashboard/integrations',
  '/dashboard/billing',
  '/dashboard/invoices',
  '/dashboard/settings',
  '/dashboard/settings/self-identification',
  '/dashboard/cases',
  '/dashboard/employer',
  '/dashboard/staffing',
];

const CONSOLE_PAGES = ['/console', '/console/customers', '/console/revenue', '/console/organizations', '/console/users', '/console/audit', '/console/flags', '/console/tickets', '/console/invoices', '/console/sources', '/console/entitlements', '/console/staffing', '/console/taxonomy', '/console/prompts', '/console/match-weights', '/console/field-mappings', '/console/ats-rulesets'];

function describeViolations(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string {
  return violations
    .map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.help} (${v.helpUrl})\n${v.nodes.map((n) => `    - ${n.target.join(' ')}: ${n.failureSummary?.split('\n').join(' ') ?? ''}`).join('\n')}`)
    .join('\n');
}

async function audit(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.status(), `${path} did not render`).toBeLessThan(400);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, `${path} has WCAG A/AA violations:\n${describeViolations(results.violations)}`).toEqual([]);
  // A page must have a title and exactly one main landmark: the two structural
  // facts a screen-reader user orients by, and the ones axe reports as best
  // practice rather than WCAG.
  await expect(page).toHaveTitle(/.+/);
  expect(await page.locator('main').count(), `${path} must have exactly one <main>`).toBe(1);
}

test.describe('public pages', () => {
  for (const path of PUBLIC_PAGES) test(`${path} meets WCAG 2.2 AA (axe)`, async ({ page }) => audit(page, path));
});

test.describe('candidate pages', () => {
  test.use({ storageState: STORAGE_STATE });
  for (const path of CANDIDATE_PAGES) test(`${path} meets WCAG 2.2 AA (axe)`, async ({ page }) => audit(page, path));
});

test.describe('staff console', () => {
  test.use({ storageState: STORAGE_STATE });
  for (const path of CONSOLE_PAGES) test(`${path} meets WCAG 2.2 AA (axe)`, async ({ page }) => audit(page, path));
});

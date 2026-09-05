/**
 * Stage 15 (ADR-0010 §Enforcement): "No feature check reads Subscription.status."
 *
 * Feature code - request handlers, dashboard pages, the services that
 * prepare and submit, documents, matching, mailbox - must decide access
 * through src/lib/entitlements, never from a subscription's status or a
 * plan's columns. Payment-state readers are allowed only where payment
 * state is the subject: billing pages, the console, the CRM, revenue
 * analytics, exports, the subscription module itself and the webhook.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.join(__dirname, '..', 'src');

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Where payment state is the subject and may be read. */
const PAYMENT_STATE_READERS = [
  'src/lib/subscription.ts',
  'src/lib/billing/',
  'src/lib/crm/',
  'src/lib/analytics/revenue.ts',
  'src/lib/exports/',
  'src/lib/integrations/public-api.ts', // the analytics summary reports quota.status for display
  'src/app/(app)/api/webhooks/',
  'src/app/(app)/api/billing/',
  'src/app/(app)/console/',
  'src/app/(app)/api/console/',
  'src/app/(app)/dashboard/billing/',
  'src/app/(app)/dashboard/invoices/',
  'src/lib/providers/payments/',
];

const FEATURE_DIRS = ['src/app/(app)/api', 'src/app/(app)/dashboard', 'src/lib/services', 'src/lib/apply', 'src/lib/documents', 'src/lib/matching', 'src/lib/mailbox', 'src/lib/eligibility', 'src/lib/ai', 'src/lib/candidate', 'src/lib/evidence', 'src/lib/integrations'];

const FORBIDDEN: [RegExp, string][] = [
  [/subscription\??\.status\s*(===|!==|==|!=)/, 'branches on Subscription.status'],
  [/\.plan\??\.maxAgents/, 'reads the plan agent ceiling instead of the `agents` entitlement'],
  [/\.plan\??\.applicationsPerMonth/, 'reads the plan application ceiling instead of the `applications_per_month` entitlement'],
  [/parseJson<string\[\]>\([^)]*\.features/, 'reads plan feature flags instead of an entitlement'],
];

describe('entitlements - no feature check reads payment state (static)', () => {
  it('feature code decides access through src/lib/entitlements only', () => {
    const offenders: string[] = [];
    for (const dir of FEATURE_DIRS) {
      const abs = path.join(ROOT, '..', dir);
      for (const file of files(abs)) {
        const rel = path.relative(path.join(ROOT, '..'), file).split(path.sep).join('/');
        if (PAYMENT_STATE_READERS.some((p) => rel.startsWith(p))) continue;
        const text = readFileSync(file, 'utf8');
        for (const [re, why] of FORBIDDEN) {
          const m = re.exec(text);
          if (m) offenders.push(`${rel}: ${why} (${m[0]})`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('the quota itself never refuses on payment state', () => {
    const text = readFileSync(path.join(ROOT, 'lib', 'subscription.ts'), 'utf8');
    const canApply = /canApply:\s*([^,\n]+)/.exec(text);
    assert.ok(canApply, 'getQuota sets canApply');
    assert.ok(!/status/.test(canApply![1]!), `canApply must not read status: ${canApply![1]}`);
    assert.match(text, /quantityFor\(db, userId, 'applications_per_month'\)/, 'the limit is the entitlement');
  });

  it('a refund never reaches the entitlement service', () => {
    const webhook = readFileSync(path.join(ROOT, 'app', '(app)', 'api', 'webhooks', 'stripe', 'route.ts'), 'utf8');
    const refundCase = webhook.slice(webhook.indexOf("case 'charge.refunded'"), webhook.indexOf('break;', webhook.indexOf("case 'charge.refunded'")));
    assert.ok(refundCase.length > 0, 'the webhook records refunds');
    assert.ok(!/revokeEntitlement|revokeBySource|applySubscriptionAccess|syncPlanEntitlements|setSubscriptionStatus|activatePlan|entitlements\/service/.test(refundCase.replace(/\/\/.*$/gm, '')), 'the refund handler calls nothing that changes access');
    assert.match(refundCase, /billing\.refund\.recorded/);
    for (const file of files(path.join(ROOT, 'lib', 'billing'))) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!/revokeEntitlement|revokeBySource|applySubscriptionAccess/.test(text), `${path.relative(ROOT, file)} must not revoke entitlements (a refund or credit note is money, not access)`);
    }
  });
});

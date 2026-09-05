/**
 * Stage 15 - entitlement state apart from payment state (ADR-0010, ADR-0030).
 *
 * Pure: the registry is well-formed; a plan's grants are deterministic and
 * complete; the merge rule (max quantity, any boolean, free baseline).
 *
 * Database: a grant WITHOUT a payment is honoured by the quota; a revoke
 * WITHOUT a refund removes it; activating a plan grants its rows and a
 * replayed activation changes nothing (no double grant, no second window);
 * an upgrade revokes the old plan's rows as plan_changed and the quota
 * follows; a trial expires; cancel-at-period-end keeps access until then and
 * nothing after; suspension revokes as payment_lapsed and recovery re-grants;
 * a refund recorded from the gateway touches no row; an organization's
 * pooled licence reaches its accepted members and not a removed one; the
 * agent ceiling reads the entitlement; every change is an audit row that
 * never carries an amount.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CAPABILITIES, CAPABILITY_KEYS, UNLIMITED, allows, grantsForPlan, quantityOf, resolveEntitlements } from '../src/lib/entitlements/capabilities';
import { resolvePrice } from '../src/lib/subscription';

describe('entitlements - the registry and the merge rule (pure)', () => {
  it('every capability has a kind and a free baseline of the right type', () => {
    for (const key of CAPABILITY_KEYS) {
      const def = CAPABILITIES[key];
      assert.ok(def.kind === 'boolean' || def.kind === 'quantity');
      assert.equal(typeof def.free, def.kind === 'quantity' ? 'number' : 'boolean', key);
      assert.ok(def.description.length > 10);
    }
  });

  it("a plan's grants come from its row for the two quantities and from the matrix for the rest, once each", () => {
    const g = grantsForPlan({ code: 'starter', applicationsPerMonth: 25, maxAgents: 2 });
    assert.equal(g.find((x) => x.capability === 'applications_per_month')?.quantity, 25);
    assert.equal(g.find((x) => x.capability === 'agents')?.quantity, 2);
    assert.ok(g.some((x) => x.capability === 'docx_export'));
    assert.ok(!g.some((x) => x.capability === 'mailbox_intelligence'), 'starter has no mailbox intelligence');
    assert.equal(new Set(g.map((x) => x.capability)).size, g.length);
    const pro = grantsForPlan({ code: 'professional', applicationsPerMonth: 120, maxAgents: 5 });
    assert.ok(pro.some((x) => x.capability === 'mailbox_intelligence'));
    assert.equal(pro.find((x) => x.capability === 'document_history_days')?.quantity, UNLIMITED);
    const unknown = grantsForPlan({ code: 'legacy', applicationsPerMonth: 10, maxAgents: 1 });
    assert.deepEqual(unknown.map((x) => x.capability), ['applications_per_month', 'agents']);
    assert.equal(grantsForPlan({ code: 'starter-2026', applicationsPerMonth: 25, maxAgents: 1 }).length, g.length, 'a versioned code is its family');
  });

  it('merges by max quantity and any boolean, falls back to the free baseline, ignores revoked and expired rows', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const rows = [
      { id: 'a', capability: 'applications_per_month', kind: 'quantity', quantity: 25, source: 'plan', expiresAt: null, revokedAt: null },
      { id: 'b', capability: 'applications_per_month', kind: 'quantity', quantity: 100, source: 'comp', expiresAt: null, revokedAt: null },
      { id: 'c', capability: 'applications_per_month', kind: 'quantity', quantity: 500, source: 'pilot', expiresAt: new Date('2026-09-01T00:00:00Z'), revokedAt: null },
      { id: 'd', capability: 'docx_export', kind: 'boolean', quantity: null, source: 'plan', expiresAt: null, revokedAt: new Date('2026-09-02T00:00:00Z') },
      { id: 'e', capability: 'agents', kind: 'quantity', quantity: 0, source: 'staff', expiresAt: null, revokedAt: null },
    ];
    const set = resolveEntitlements(rows, now);
    assert.equal(quantityOf(set, 'applications_per_month'), 100);
    assert.equal(set.applications_per_month.source, 'comp');
    assert.deepEqual(set.applications_per_month.rowIds, ['a', 'b'], 'the expired pilot row is not counted');
    assert.equal(allows(set, 'docx_export'), false, 'a revoked row grants nothing');
    assert.equal(set.docx_export.source, 'free');
    assert.equal(quantityOf(set, 'agents'), 1, 'a zero grant never lowers the free baseline');
    assert.equal(set.agents.source, 'free');
    assert.equal(allows(set, 'priority_support'), false);
    assert.equal(quantityOf(set, 'interview_prep_per_month'), 0);
  });

  it('resolvePrice answers in the customer currency from PlanPrice and falls back to the CAD columns, saying so', () => {
    const plan = { monthlyPriceCents: 2900, quarterlyPriceCents: 7800, annualPriceCents: 27900 };
    const prices = [
      { currency: 'USD', interval: 'monthly', amountCents: 2200, externalPriceId: 'price_usd_m', active: true },
      { currency: 'USD', interval: 'annual', amountCents: 21000, externalPriceId: null, active: false },
    ];
    assert.deepEqual(resolvePrice(plan, 'monthly', 'USD', prices), { amountCents: 2200, currency: 'USD', externalPriceId: 'price_usd_m', source: 'plan_price' });
    assert.deepEqual(resolvePrice(plan, 'annual', 'USD', prices), { amountCents: 27900, currency: 'CAD', externalPriceId: null, source: 'plan_columns' }, 'an inactive cell does not answer');
    assert.deepEqual(resolvePrice(plan, 'quarterly', 'CAD'), { amountCents: 7800, currency: 'CAD', externalPriceId: null, source: 'plan_columns' });
  });
});

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Svc = typeof import('../src/lib/entitlements/service');
type Sub = typeof import('../src/lib/subscription');

const S = randomBytes(4).toString('hex');
const U = { id: `ent_u_${S}`, email: `ent-${S}@ent.test` };
const V = { id: `ent_v_${S}`, email: `ent-v-${S}@ent.test` };
const W = { id: `ent_w_${S}`, email: `ent-w-${S}@ent.test` };
let db: Db;
let svc: Svc;
let sub: Sub;
const planIds: Record<string, string> = {};

describe('entitlements - against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    svc = await import('../src/lib/entitlements/service');
    sub = await import('../src/lib/subscription');
    for (const u of [U, V, W]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Ent Tester', country: 'CA' } });
    for (const [code, apps, agents] of [
      [`starter-${S}`, 25, 1],
      [`professional-${S}`, 120, 5],
    ] as const) {
      const plan = await db.plan.create({ data: { code, name: code, tagline: '', monthlyPriceCents: 1000, quarterlyPriceCents: 2700, annualPriceCents: 9000, applicationsPerMonth: apps, maxAgents: agents } });
      planIds[code] = plan.id;
    }
  });
  after(async () => {
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: [U.id, V.id, W.id] } }, { entityType: 'Entitlement', actorType: 'system' }] } });
    await db.user.deleteMany({ where: { id: { in: [U.id, V.id, W.id] } } });
    await db.plan.deleteMany({ where: { code: { endsWith: `-${S}` } } });
    await db.$disconnect();
  });

  const quota = async (userId: string) => (await sub.getQuota(userId))!;
  const active = (userId: string) => db.entitlement.findMany({ where: { userId, revokedAt: null }, orderBy: { capability: 'asc' } });

  it('a grant without a payment is what the quota reads; a revoke without a refund removes it; both are audited without an amount', async () => {
    // Free baseline: no subscription row means no quota window (the usage lives on the subscription), so give W a plain subscription first.
    await sub.activatePlan(W.id, `starter-${S}`, 'monthly');
    assert.equal((await quota(W.id)).limit, 25);
    const g = await svc.grantEntitlement(db, { subject: { userId: W.id }, capability: 'applications_per_month', quantity: 200, source: 'comp', sourceRef: 'ticket-42', grantedBy: 'staff:s1', note: 'pilot customer' });
    assert.equal(g.changed, true);
    assert.equal((await quota(W.id)).limit, 200, 'the comp wins over the plan');
    assert.equal((await quota(W.id)).canApply, true);
    const again = await svc.grantEntitlement(db, { subject: { userId: W.id }, capability: 'applications_per_month', quantity: 200, source: 'comp', sourceRef: 'ticket-42', grantedBy: 'staff:s1' });
    assert.deepEqual(again, { id: g.id, changed: false }, 'the same grant twice is one row');
    assert.equal(await svc.revokeEntitlement(db, g.id, { reason: 'staff', revokedBy: 'staff:s1', note: 'pilot over' }), true);
    assert.equal((await quota(W.id)).limit, 25, 'back to the plan, no refund involved');
    const audit = await db.auditLog.findMany({ where: { entityType: 'Entitlement', entityId: g.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(audit.map((a) => a.action), ['entitlement.granted', 'entitlement.revoked']);
    assert.equal(audit[0]!.actorType, 'staff');
    assert.ok(audit.every((a) => !/amount|cents|\$/i.test(a.after)), 'an entitlement audit row never carries money');
    assert.equal(await svc.revokeEntitlement(db, g.id, { reason: 'staff' }), true, 'idempotent');
  });

  it('activating a plan grants its rows; a replay is a no-op; an upgrade revokes the old rows as plan_changed and the quota and agent ceiling follow', async () => {
    await sub.activatePlan(U.id, `starter-${S}`, 'monthly', { external: { subscriptionId: `sub_${S}` }, by: 'webhook:stripe' });
    const rows = await active(U.id);
    assert.ok(rows.length >= 8);
    assert.ok(rows.every((r) => r.source === 'plan'));
    assert.equal((await quota(U.id)).limit, 25);
    assert.equal(await svc.quantityFor(db, U.id, 'agents'), 1);
    assert.equal(await svc.can(db, U.id, 'mailbox_intelligence'), false);
    // consume some quota, then replay the same activation: nothing changes, the window is not reset
    await sub.consumeQuota(U.id, 3);
    const before = await db.auditLog.count({ where: { entityType: 'Entitlement' } });
    await sub.activatePlan(U.id, `starter-${S}`, 'monthly', { external: { subscriptionId: `sub_${S}` }, by: 'webhook:stripe' });
    assert.equal(await db.auditLog.count({ where: { entityType: 'Entitlement' } }), before, 'a replayed activation writes no audit row');
    assert.equal((await quota(U.id)).used, 3, 'a replayed activation does not hand out a second allowance');
    assert.equal((await active(U.id)).length, rows.length);
    // upgrade
    await sub.activatePlan(U.id, `professional-${S}`, 'annual', { by: 'checkout:simulated' });
    const after = await active(U.id);
    assert.ok(after.every((r) => r.sourceRef?.endsWith(`:professional-${S}`)));
    assert.equal((await quota(U.id)).limit, 120);
    assert.equal(await svc.quantityFor(db, U.id, 'agents'), 5);
    assert.equal(await svc.can(db, U.id, 'mailbox_intelligence'), true);
    const revoked = await db.entitlement.findMany({ where: { userId: U.id, revokedAt: { not: null } } });
    assert.ok(revoked.length >= 8);
    assert.ok(revoked.every((r) => r.revokedReason === 'plan_changed'));
  });

  it('a lapsed payment keeps access while dunning runs; suspension revokes as payment_lapsed; recovery re-grants; cancellation at period end expires; a refund touches nothing', async () => {
    await sub.setSubscriptionStatus(`sub_${S}`, 'past_due', { by: 'webhook:stripe' });
    assert.equal((await quota(U.id)).canApply, true, 'past due is not a refusal (grace)');
    assert.equal((await quota(U.id)).status, 'past_due', 'payment state is reported, not used');
    await sub.suspendSubscription(U.id, { by: 'system:dunning' });
    assert.equal((await active(U.id)).length, 0);
    assert.equal((await quota(U.id)).limit, 5, 'the free baseline remains');
    assert.equal((await db.entitlement.findFirst({ where: { userId: U.id, revokedReason: 'payment_lapsed' } })) !== null, true);
    await sub.setSubscriptionStatus(`sub_${S}`, 'active', { by: 'webhook:stripe' });
    assert.equal((await quota(U.id)).limit, 120, 'recovery re-grants the plan');
    // cancel at period end: access until renewsAt, then nothing
    const cancelled = await sub.cancelSubscription(U.id, { by: 'user' });
    assert.ok(cancelled.accessUntil);
    assert.equal((await quota(U.id)).limit, 120, 'still entitled until the period ends');
    const future = new Date(cancelled.accessUntil!.getTime() + 1000);
    assert.equal(quantityOf(await svc.entitlementsFor(db, U.id, future), 'applications_per_month'), 5, 'after the period end the free baseline applies');
    // a refund recorded from the gateway changes no row
    const snapshot = await active(U.id);
    await db.auditLog.create({ data: { actorType: 'system', actorEmail: '', actorRole: '', action: 'billing.refund.recorded', entityType: 'Charge', entityId: `ch_${S}`, summary: 'Refund recorded', before: '{}', after: '{}', changedFields: '[]' } });
    assert.deepEqual((await active(U.id)).map((r) => r.id), snapshot.map((r) => r.id));
    // immediate cancel revokes now
    await sub.cancelSubscription(U.id, { immediately: true, by: 'staff:s1' });
    assert.equal((await active(U.id)).length, 0);
    assert.ok((await db.entitlement.findMany({ where: { userId: U.id, revokedReason: 'canceled' } })).length >= 8);
  });

  it('a trial grants with an expiry and the sweep records the expiry; converting to a paid plan retires the trial rows', async () => {
    const { trialEndsAt } = await sub.startTrial(V.id, `professional-${S}`, 14, { by: 'staff:s1' });
    const rows = await active(V.id);
    assert.ok(rows.every((r) => r.source === 'trial' && r.expiresAt?.getTime() === trialEndsAt.getTime()));
    assert.equal((await quota(V.id)).limit, 120);
    assert.equal((await quota(V.id)).status, 'trialing');
    await db.entitlement.updateMany({ where: { userId: V.id, source: 'trial' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await quota(V.id)).limit, 5, 'an expired trial is the free baseline before any sweep');
    const swept = await svc.sweepExpired(db);
    assert.ok(swept >= rows.length);
    assert.ok((await db.entitlement.findMany({ where: { userId: V.id } })).every((r) => r.revokedReason === 'expired'));
    await sub.startTrial(V.id, `starter-${S}`, 7);
    await sub.activatePlan(V.id, `starter-${S}`, 'monthly');
    const paid = await active(V.id);
    assert.ok(paid.every((r) => r.source === 'plan'));
    assert.ok((await db.entitlement.findMany({ where: { userId: V.id, source: 'trial', revokedReason: 'trial_ended' } })).length > 0);
  });

  it("an organization's pooled licence reaches accepted members and not removed ones; a stranger's rows are invisible", async () => {
    const org = await db.organization.create({ data: { id: `org_${S}`, name: `Org ${S}`, slug: `org-${S}`, type: 'employer', billingEmail: `org-${S}@ent.test` } });
    await db.membership.create({ data: { organizationId: org.id, userId: W.id, role: 'member', acceptedAt: new Date() } });
    await db.membership.create({ data: { organizationId: org.id, userId: V.id, role: 'member', acceptedAt: new Date(), removedAt: new Date() } });
    await svc.grantEntitlement(db, { subject: { organizationId: org.id }, capability: 'api_access', source: 'licence', sourceRef: 'contract-7', grantedBy: 'staff:s1' });
    await svc.grantEntitlement(db, { subject: { organizationId: org.id }, capability: 'applications_per_month', quantity: 1000, source: 'licence', sourceRef: 'contract-7', grantedBy: 'staff:s1' });
    assert.equal(await svc.can(db, W.id, 'api_access'), true, 'an accepted member has the licence');
    assert.equal((await quota(W.id)).limit, 1000);
    assert.equal(await svc.can(db, V.id, 'api_access'), false, 'a removed member does not');
    assert.equal(await svc.can(db, U.id, 'api_access'), false, 'a stranger does not');
    await svc.revokeBySource(db, { organizationId: org.id }, 'licence', { reason: 'staff', revokedBy: 'staff:s1' });
    assert.equal(await svc.can(db, W.id, 'api_access'), false);
    await db.organization.delete({ where: { id: org.id } });
  });

  it('the entitlement rows are readable on the tenant path for the owner only (RLS)', async () => {
    const { withTenant } = await import('../src/lib/tenancy/context');
    const mine = await withTenant({ userId: W.id }, (tx) => tx.entitlement.count({ where: { userId: W.id } }));
    const theirs = await withTenant({ userId: U.id }, (tx) => tx.entitlement.count({ where: { userId: W.id } }));
    assert.ok(mine > 0);
    assert.equal(theirs, 0, 'another tenant sees nothing of these rows');
  });
});

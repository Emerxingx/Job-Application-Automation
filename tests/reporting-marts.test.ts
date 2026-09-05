/**
 * Stage 21 (ADR-0036) - the reporting marts against the database: the
 * organisation rollup reads the employer, staffing and case tables once and
 * writes rows the product pages read on the tenant path with the numbers the
 * fixture makes true; a second run changes nothing; another organisation
 * sees nothing of the first under RLS; the caseload summary withholds a
 * small cohort; the platform rollup writes activity for the window and a
 * snapshot for the as-of day only; the revenue summary read from the mart
 * agrees with the live computation over the same rows; the cohort mart is
 * system-only; freshness names the runs; the extraction writes the
 * documented CSV; and the mart reads use their indexes.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type OrgRollup = typeof import('../src/lib/analytics/organization/rollup');
type OrgRead = typeof import('../src/lib/analytics/organization/read');
type Platform = typeof import('../src/lib/analytics/platform/rollup');
type Cohorts = typeof import('../src/lib/analytics/finance/cohorts');
type Summary = typeof import('../src/lib/analytics/finance/summary');
type Revenue = typeof import('../src/lib/analytics/revenue');
type Rollups = typeof import('../src/lib/analytics/rollups');
type Freshness = typeof import('../src/lib/analytics/freshness');
type Export = typeof import('../src/lib/analytics/warehouse/export');
type Ctx = typeof import('../src/lib/tenancy/context');
type Dict = typeof import('../src/lib/analytics/platform/dictionary');

const S = randomBytes(4).toString('hex');
const d = (s: string) => new Date(s);
const O = { id: `rm_o_${S}`, email: `rm-o-${S}@rm.test` };
const R = { id: `rm_r_${S}`, email: `rm-r-${S}@rm.test` };
const C1 = { id: `rm_c1_${S}`, email: `rm-c1-${S}@rm.test` };
const C2 = { id: `rm_c2_${S}`, email: `rm-c2-${S}@rm.test` };
/** A member of organisation B only: the org policy shows a person every organisation they belong to, so scoping is proven from a single membership. */
const X = { id: `rm_x_${S}`, email: `rm-x-${S}@rm.test` };
const A = `rm_org_a_${S}`;
const B = `rm_org_b_${S}`;
/** A window no other suite writes into. */
const RANGE = { start: d('2025-01-01T00:00:00Z'), end: d('2025-02-01T00:00:00Z') };
const READ = { from: RANGE.start, to: d('2025-01-31T00:00:00Z') };
const AS_OF = d('2025-01-31T12:00:00Z');

let db: Db;
let orgRollup: OrgRollup;
let orgRead: OrgRead;
let platform: Platform;
let cohorts: Cohorts;
let summary: Summary;
let revenue: Revenue;
let rollups: Rollups;
let freshness: Freshness;
let exporter: Export;
let ctx: Ctx;
let dict: Dict;
let planId = '';

describe('Stage 21 - reporting marts against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    orgRollup = await import('../src/lib/analytics/organization/rollup');
    orgRead = await import('../src/lib/analytics/organization/read');
    platform = await import('../src/lib/analytics/platform/rollup');
    cohorts = await import('../src/lib/analytics/finance/cohorts');
    summary = await import('../src/lib/analytics/finance/summary');
    revenue = await import('../src/lib/analytics/revenue');
    rollups = await import('../src/lib/analytics/rollups');
    freshness = await import('../src/lib/analytics/freshness');
    exporter = await import('../src/lib/analytics/warehouse/export');
    ctx = await import('../src/lib/tenancy/context');
    dict = await import('../src/lib/analytics/platform/dictionary');

    for (const u of [O, R, C1, C2, X]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Mart', country: 'CA' } });
    await db.organization.create({ data: { id: A, name: 'Mart Employer', slug: `mart-a-${S}`, type: 'employer', billingEmail: O.email, verifiedAt: d('2025-01-04T10:00:00Z'), memberships: { create: [{ userId: O.id, role: 'owner', acceptedAt: d('2025-01-01T00:00:00Z') }, { userId: R.id, role: 'member', serviceRole: 'recruiter', acceptedAt: d('2025-01-01T00:00:00Z') }] } } });
    await db.organization.create({ data: { id: B, name: 'Mart Other', slug: `mart-b-${S}`, type: 'employer', billingEmail: O.email, memberships: { create: [{ userId: X.id, role: 'owner', acceptedAt: d('2025-01-01T00:00:00Z') }] } } });

    // --- employer: two submissions in A with a real history, one in B ----------
    const req = await db.requisition.create({ data: { organizationId: A, title: 'Analyst', location: 'Vancouver, BC', createdById: O.id, status: 'open' } });
    const s1 = await db.submission.create({ data: { organizationId: A, requisitionId: req.id, candidateUserId: C1.id, source: 'applied', stage: 'hired', createdById: O.id, createdAt: d('2025-01-06T10:00:00Z') } });
    const s2 = await db.submission.create({ data: { organizationId: A, requisitionId: req.id, candidateUserId: C2.id, source: 'sourced', stage: 'rejected', createdById: R.id, createdAt: d('2025-01-06T15:00:00Z') } });
    const ev = (submissionId: string, fromStage: string, toStage: string, actorId: string, at: string) => db.submissionEvent.create({ data: { submissionId, organizationId: A, fromStage, toStage, actorId, at: d(at) } });
    await ev(s1.id, 'sourced', 'consented', C1.id, '2025-01-06T11:00:00Z'); // the candidate's own event: never recruiter activity
    await ev(s1.id, 'consented', 'screening', R.id, '2025-01-08T10:00:00Z');
    await ev(s1.id, 'screening', 'interviewing', R.id, '2025-01-13T10:00:00Z');
    await ev(s1.id, 'interviewing', 'hired', O.id, '2025-01-23T10:00:00Z');
    await ev(s2.id, 'sourced', 'consented', C2.id, '2025-01-07T10:00:00Z');
    await ev(s2.id, 'consented', 'screening', R.id, '2025-01-12T10:00:00Z');
    await ev(s2.id, 'screening', 'rejected', R.id, '2025-01-15T10:00:00Z');
    const reqB = await db.requisition.create({ data: { organizationId: B, title: 'Other', location: 'Calgary, AB', createdById: O.id } });
    await db.submission.create({ data: { organizationId: B, requisitionId: reqB.id, candidateUserId: C1.id, source: 'sourced', createdById: O.id, createdAt: d('2025-01-07T10:00:00Z') } });

    // --- staffing in A -----------------------------------------------------------
    const contract = await db.clientContract.create({ data: { organizationId: A, clientName: 'Acme', jurisdiction: 'CA-BC', status: 'active', createdById: O.id } });
    const fee = await db.feeStructure.create({ data: { organizationId: A, contractId: contract.id, name: '20%', kind: 'percent', percentBps: 2000, createdById: O.id } });
    const eng = await db.engagement.create({ data: { organizationId: A, contractId: contract.id, feeStructureId: fee.id, title: 'Ops lead', jurisdiction: 'CA-BC', status: 'open', ownerRecruiterId: R.id, createdById: O.id, createdAt: d('2025-01-02T10:00:00Z') } });
    const rc1 = await db.representationConsent.create({ data: { organizationId: A, engagementId: eng.id, invitedEmail: C1.email, candidateUserId: C1.id, status: 'granted', requestedById: R.id, requestedAt: d('2025-01-03T10:00:00Z'), respondedAt: d('2025-01-04T10:00:00Z') } });
    await db.representationConsent.create({ data: { organizationId: A, engagementId: eng.id, invitedEmail: C2.email, status: 'requested', requestedById: R.id, requestedAt: d('2025-01-03T11:00:00Z') } });
    const placement = await db.placement.create({ data: { organizationId: A, engagementId: eng.id, candidateUserId: C1.id, representationConsentId: rc1.id, recruiterId: R.id, startDate: d('2025-01-20T00:00:00Z'), salaryCents: 9_000_000, feeCents: 1_800_000, guaranteeDays: 90, guaranteeEndsAt: d('2025-04-20T00:00:00Z'), status: 'started', createdById: O.id, createdAt: d('2025-01-10T10:00:00Z') } });
    await db.placementInvoice.create({ data: { organizationId: A, placementId: placement.id, contractId: contract.id, status: 'paid', amountCents: 1_800_000, issuedAt: d('2025-01-11T10:00:00Z'), paidAt: d('2025-01-20T10:00:00Z'), createdById: O.id } });

    // --- cases in A: three clients, one closed, two follow-ups -------------------
    for (let i = 1; i <= 3; i += 1) {
      const c = await db.case.create({ data: { organizationId: A, invitedEmail: `rm-client-${i}-${S}@rm.test`, status: i === 3 ? 'closed' : 'open', openedAt: d('2025-01-05T10:00:00Z'), closedAt: i === 3 ? d('2025-01-28T10:00:00Z') : null, createdById: O.id } });
      const outcome = await db.caseOutcome.create({ data: { caseId: c.id, organizationId: A, kind: i === 3 ? 'training' : 'employed', recordedById: O.id, recordedAt: d('2025-01-15T10:00:00Z') } });
      // One client records a second outcome on another day: `people` is per day, and that day alone must be withheld (review H1).
      if (i === 1) await db.caseOutcome.create({ data: { caseId: c.id, organizationId: A, kind: 'employed', recordedById: O.id, recordedAt: d('2025-01-16T10:00:00Z') } });
      if (i <= 2) await db.caseFollowUp.create({ data: { caseId: c.id, organizationId: A, outcomeId: outcome.id, dueAt: d('2025-01-25T10:00:00Z'), completedAt: i === 1 ? d('2025-01-26T10:00:00Z') : null, status: i === 1 ? 'completed' : 'pending' } });
    }

    // --- finance: one subscriber with a plan change, one paid invoice, one failed payment, one ticket
    const plan = await db.plan.create({ data: { code: `t21-${S}`, name: 'T21', tagline: 't', monthlyPriceCents: 2900, quarterlyPriceCents: 7800, annualPriceCents: 29000, applicationsPerMonth: 10, maxAgents: 1 } });
    planId = plan.id;
    const sub = await db.subscription.create({ data: { userId: O.id, planId: plan.id, status: 'active', currency: 'CAD', mrrCents: 4900, startedAt: d('2024-12-15T10:00:00Z'), renewsAt: d('2025-02-15T10:00:00Z'), periodStart: d('2025-01-15T10:00:00Z'), periodEnd: d('2025-02-15T10:00:00Z') } });
    await db.subscriptionEvent.create({ data: { userId: O.id, subscriptionId: sub.id, type: 'created', toPlanCode: plan.code, toStatus: 'active', mrrBeforeCents: 0, mrrAfterCents: 2900, deltaMrrCents: 2900, movement: 'new', occurredAt: d('2024-12-15T10:00:00Z') } });
    await db.subscriptionEvent.create({ data: { userId: O.id, subscriptionId: sub.id, type: 'plan_changed', fromPlanCode: plan.code, toPlanCode: plan.code, mrrBeforeCents: 2900, mrrAfterCents: 4900, deltaMrrCents: 2000, movement: 'expansion', occurredAt: d('2025-01-10T10:00:00Z') } });
    await db.invoice.create({ data: { userId: O.id, subscriptionId: sub.id, status: 'paid', currency: 'CAD', subtotalCents: 2900, totalCents: 2900, amountPaidCents: 2900, planCode: plan.code, planName: 'T21', issuedAt: d('2025-01-05T10:00:00Z'), dueAt: d('2025-01-12T10:00:00Z'), paidAt: d('2025-01-05T11:00:00Z') } });
    await db.payment.create({ data: { userId: O.id, provider: 'manual', externalId: `rm-ok-${S}`, status: 'succeeded', amountCents: 2900, currency: 'CAD', feeCents: 114, netCents: 2786, succeededAt: d('2025-01-05T11:00:00Z'), createdAt: d('2025-01-05T11:00:00Z') } });
    await db.payment.create({ data: { userId: O.id, provider: 'manual', externalId: `rm-failed-${S}`, status: 'failed', amountCents: 2900, currency: 'CAD', failureCode: 'card_declined', failedAt: d('2025-01-09T10:00:00Z'), createdAt: d('2025-01-09T10:00:00Z') } });
    await db.supportTicket.create({ data: { number: `TKT-T21-${S}`, userId: O.id, email: O.email, subject: 'mart', status: 'open', breachedSla: true } });
    // A second subscriber who churned in December and came back in January: the movement's reactivation column (review M8).
    const subR = await db.subscription.create({ data: { userId: R.id, planId: plan.id, status: 'active', currency: 'CAD', mrrCents: 2900, startedAt: d('2024-11-01T10:00:00Z'), renewsAt: d('2025-02-18T10:00:00Z'), periodStart: d('2025-01-18T10:00:00Z'), periodEnd: d('2025-02-18T10:00:00Z') } });
    await db.subscriptionEvent.create({ data: { userId: R.id, subscriptionId: subR.id, type: 'created', toPlanCode: plan.code, toStatus: 'active', mrrBeforeCents: 0, mrrAfterCents: 2900, deltaMrrCents: 2900, movement: 'new', occurredAt: d('2024-11-01T10:00:00Z') } });
    await db.subscriptionEvent.create({ data: { userId: R.id, subscriptionId: subR.id, type: 'status_changed', fromStatus: 'active', toStatus: 'canceled', mrrBeforeCents: 2900, mrrAfterCents: 0, deltaMrrCents: -2900, movement: 'churn', occurredAt: d('2024-12-20T10:00:00Z') } });
    await db.subscriptionEvent.create({ data: { userId: R.id, subscriptionId: subR.id, type: 'status_changed', fromStatus: 'canceled', toStatus: 'active', mrrBeforeCents: 0, mrrAfterCents: 2900, deltaMrrCents: 2900, movement: 'reactivation', occurredAt: d('2025-01-18T10:00:00Z') } });
  });

  after(async () => {
    await db.organization.deleteMany({ where: { id: { in: [A, B] } } });
    await db.supportTicket.deleteMany({ where: { number: `TKT-T21-${S}` } });
    await db.payment.deleteMany({ where: { userId: O.id } });
    await db.invoice.deleteMany({ where: { userId: O.id } });
    await db.subscriptionEvent.deleteMany({ where: { userId: { in: [O.id, R.id] } } });
    await db.subscription.deleteMany({ where: { userId: { in: [O.id, R.id] } } });
    if (planId) await db.plan.deleteMany({ where: { id: planId } });
    const days = Array.from({ length: 32 }, (_, i) => `2025-01-${String(i).padStart(2, '0')}`).concat(['2024-12-31']);
    await db.dailyMetric.deleteMany({ where: { day: { in: days }, metric: { in: [...dict.PLATFORM_ACTIVITY_METRICS, ...dict.PLATFORM_SNAPSHOT_METRICS] } } });
    await db.dailyRevenueRollup.deleteMany({ where: { day: { in: days } } });
    await db.subscriptionCohortMart.deleteMany({ where: { day: '2025-01-31' } });
    await db.user.deleteMany({ where: { id: { in: [O.id, R.id, C1.id, C2.id, X.id] } } });
    await db.$disconnect();
  });

  it('the organisation rollup writes what the fixture makes true, and the employer report reads it on the tenant path', async () => {
    const result = await orgRollup.rollupOrganizations(RANGE);
    assert.equal(result.status, 'succeeded');
    assert.ok(result.organizations >= 2);
    const report = await ctx.withTenant({ userId: O.id, organizationId: A }, (tx) => orgRead.readEmployerReport(tx, A, READ));
    assert.deepEqual(report.funnel, { submissions: 2, consented: 2, screening: 2, interviewing: 1, offered: 0, hired: 1, rejected: 1, withdrawn: 0 });
    assert.deepEqual(report.daysTo, { shortlist: 4, interview: 7, hire: 17 }, 'mean whole days: (2 + 6) / 2, 7 / 1, 17 / 1');
    assert.deepEqual(report.sources, { applied: { submissions: 1, hires: 1 }, sourced: { submissions: 1, hires: 0 } });
    assert.deepEqual(report.recruiterActivity, [{ actorId: R.id, moves: 4 }, { actorId: O.id, moves: 1 }], 'the candidates\' own consent events are not recruiter activity');
  });

  it('a second run changes nothing (replace semantics), and a RollupRun records each run', async () => {
    const before = await db.organizationDailyMart.findMany({ where: { organizationId: A }, orderBy: [{ day: 'asc' }, { product: 'asc' }, { metric: 'asc' }, { dimension: 'asc' }, { key: 'asc' }], select: { day: true, product: true, metric: true, dimension: true, key: true, valueInt: true, valueCents: true, people: true } });
    assert.ok(before.length > 20);
    const again = await orgRollup.rollupOrganizations(RANGE, { organizationId: A });
    assert.equal(again.status, 'succeeded');
    const afterRows = await db.organizationDailyMart.findMany({ where: { organizationId: A }, orderBy: [{ day: 'asc' }, { product: 'asc' }, { metric: 'asc' }, { dimension: 'asc' }, { key: 'asc' }], select: { day: true, product: true, metric: true, dimension: true, key: true, valueInt: true, valueCents: true, people: true } });
    assert.deepEqual(afterRows, before);
    const runs = await db.rollupRun.findMany({ where: { job: orgRollup.ORGANIZATION_ROLLUP_JOB, status: 'succeeded', windowStart: RANGE.start } });
    assert.ok(runs.length >= 1);
    // A single-organisation run is recorded under its own job name and never counts as a rebuild of the mart (review L11).
    assert.ok((await db.rollupRun.count({ where: { job: orgRollup.SCOPED_ROLLUP_JOB, status: 'succeeded', windowStart: RANGE.start } })) >= 1);
    // A single-organisation run leaves the other organisation's rows alone.
    assert.ok((await db.organizationDailyMart.count({ where: { organizationId: B } })) > 0);
  });

  it('another organisation sees nothing of the first under RLS, and the cohort mart is invisible on the tenant path', async () => {
    const seen = await ctx.withTenant({ userId: X.id, organizationId: B }, (tx) => tx.organizationDailyMart.findMany({ select: { organizationId: true } }));
    assert.ok(seen.length > 0);
    assert.ok(seen.every((r) => r.organizationId === B));
    const crossRead = await ctx.withTenant({ userId: X.id, organizationId: B }, (tx) => orgRead.readEmployerReport(tx, A, READ));
    assert.equal(crossRead.funnel.submissions, 0, 'asking for A from B\'s context returns nothing, not A\'s numbers');
    await cohorts.rollupCohorts({ now: AS_OF });
    assert.ok((await db.subscriptionCohortMart.count({ where: { day: '2025-01-31' } })) > 0);
    assert.deepEqual(await ctx.withTenant({ userId: O.id, organizationId: A }, (tx) => tx.subscriptionCohortMart.findMany()), [], 'system-only: no policy for the tenant role');
    const grid = await cohorts.readCohortGrid('CAD', AS_OF);
    assert.equal(grid.asOf?.toISOString(), '2025-01-31T00:00:00.000Z');
    const dec = grid.rows.find((r) => r.key === '2024-12');
    assert.ok(dec && dec.size >= 1, 'the December cohort holds the fixture subscriber');
  });

  it('staffing productivity and invoices come from the mart, fees only when allowed', async () => {
    const withFees = await ctx.withTenant({ userId: O.id, organizationId: A }, (tx) => orgRead.readStaffingProductivity(tx, A, READ, { fees: true }));
    assert.deepEqual(withFees, [{ recruiterId: R.id, engagements: 1, requested: 2, granted: 1, placements: 1, fellOffInGuarantee: 0, feeCents: 1_800_000 }]);
    const noFees = await ctx.withTenant({ userId: R.id, organizationId: A }, (tx) => orgRead.readStaffingProductivity(tx, A, READ, { fees: false, onlyRecruiterId: R.id }));
    assert.equal(noFees[0]!.feeCents, null);
    const none = await ctx.withTenant({ userId: R.id, organizationId: A }, (tx) => orgRead.readStaffingProductivity(tx, A, READ, { fees: false, onlyRecruiterId: O.id }));
    assert.deepEqual(none, []);
    const invoices = await ctx.withTenant({ userId: O.id, organizationId: A }, (tx) => orgRead.readStaffingInvoices(tx, A, READ));
    assert.deepEqual(invoices, { issued: { count: 1, cents: 1_800_000 }, paid: { count: 1, cents: 1_800_000 }, credited: { count: 0, cents: 0 } });
  });

  it('the caseload summary withholds every day under five clients, shows a five-client day, and never counts a client once per day', async () => {
    const small = await ctx.withTenant({ userId: O.id, organizationId: A }, (tx) => orgRead.readCaseloadSummary(tx, A, READ));
    assert.equal(small.opened, 3);
    assert.equal(small.closed, 1);
    assert.deepEqual(small.followUps, { due: 2, completed: 1 });
    assert.equal(small.outcomes.suppressed, true, 'three clients on the 15th and one on the 16th: four outcomes, no number');
    assert.ok(small.outcomesByKind.every((k) => k.count.suppressed));
    for (let i = 4; i <= 5; i += 1) {
      const c = await db.case.create({ data: { organizationId: A, invitedEmail: `rm-client-${i}-${S}@rm.test`, status: 'open', openedAt: d('2025-01-05T10:00:00Z'), createdById: O.id } });
      await db.caseOutcome.create({ data: { caseId: c.id, organizationId: A, kind: 'employed', recordedById: O.id, recordedAt: d('2025-01-15T10:00:00Z') } });
    }
    await orgRollup.rollupOrganizations(RANGE, { organizationId: A });
    const five = await ctx.withTenant({ userId: O.id, organizationId: A }, (tx) => orgRead.readCaseloadSummary(tx, A, READ));
    assert.deepEqual(five.outcomes, { suppressed: false, value: 5, withheldDays: 1 }, 'the 15th (five clients) is shown; the 16th (one client, a second outcome of client 1) is withheld, so the sixth outcome never appears');
    assert.equal(five.outcomesByKind.find((k) => k.kind === 'employed')!.count.suppressed, true, 'four employed clients on the 15th: still withheld by kind');
    assert.equal(five.outcomesByKind.find((k) => k.kind === 'training')!.count.suppressed, true);
  });

  it('the platform rollup writes activity for every day of the window and a snapshot for the as-of day only, idempotently', async () => {
    const first = await platform.rollupPlatform(RANGE, { asOf: AS_OF });
    assert.equal(first.status, 'succeeded');
    const failed = await platform.readDailyMetric('failed_payments', RANGE);
    assert.equal(failed.length, 31);
    assert.equal(failed.find((r) => r.day === '2025-01-09')!.valueInt, 1);
    assert.ok(failed.filter((r) => r.day !== '2025-01-09').every((r) => r.valueInt === 0), 'quiet days are zeros');
    const verified = await platform.readDailyMetric('organizations_verified', RANGE);
    assert.equal(verified.find((r) => r.day === '2025-01-04')!.valueInt, 1);
    const tickets = await platform.readLatestSnapshot('open_tickets');
    assert.ok(tickets && tickets.valueInt >= 1);
    const breached = await platform.readLatestSnapshot('breached_tickets');
    assert.ok(breached && breached.valueInt >= 1);
    const days = Array.from({ length: 31 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`);
    const snapshotRows = await db.dailyMetric.findMany({ where: { day: { in: days }, metric: { in: [...dict.PLATFORM_SNAPSHOT_METRICS] } }, select: { day: true } });
    assert.equal(snapshotRows.length, dict.PLATFORM_SNAPSHOT_METRICS.length);
    assert.ok(snapshotRows.every((r) => r.day === '2025-01-31'), 'no snapshot is written onto a past day');
    await platform.rollupPlatform(RANGE, { asOf: AS_OF });
    const activityRows = await db.dailyMetric.count({ where: { day: { in: days }, metric: { in: [...platform.OWNED_ACTIVITY_METRICS] } } });
    assert.equal(activityRows, 31 * platform.OWNED_ACTIVITY_METRICS.length, 'a second run neither duplicates nor drops a row');
  });

  it('the revenue summary read from the mart agrees with the live computation over the same rows', async () => {
    // The day before the window is rolled up too: the opening row is the previous day's mart row.
    const rolled = await rollups.rollupRevenue({ start: d('2024-12-31T00:00:00Z'), end: RANGE.end });
    assert.equal(rolled.status, 'succeeded');
    const live = await revenue.loadRevenueSummary({ range: RANGE, currency: 'CAD' });
    const mart = await summary.loadRevenueSummaryFromMarts({ range: RANGE, currency: 'CAD' });
    assert.equal(mart.asOfDay, '2025-01-31');
    assert.deepEqual(mart.totals, live.totals);
    assert.deepEqual(mart.revenueOverTime, live.revenueOverTime);
    assert.deepEqual(mart.movement, live.movement);
    assert.equal(mart.openingMrrCents, live.openingMrrCents);
    assert.equal(mart.openingSubscribers, live.openingSubscribers);
    assert.deepEqual(mart.churn, live.churn);
    assert.deepEqual(mart.subscribersOverTime, live.subscribersOverTime);
    assert.deepEqual({ succeeded: mart.paymentHealth.succeeded, failed: mart.paymentHealth.failed, pending: mart.paymentHealth.pending, failureRate: mart.paymentHealth.failureRate, overTime: mart.paymentHealth.overTime }, { succeeded: live.paymentHealth.succeeded, failed: live.paymentHealth.failed, pending: live.paymentHealth.pending, failureRate: live.paymentHealth.failureRate, overTime: live.paymentHealth.overTime });
    assert.ok(mart.totals.paidCents >= 2900 && mart.paymentHealth.failed >= 1, 'the fixture is in the numbers');
    assert.equal(live.movement.reactivatedSubscribers, 1, 'the parity on movement is not vacuous: a reactivation is in the fixture (review M8)');
    assert.equal(mart.openingCovered, true);
    assert.equal(mart.subscriberSnapshotDay, '2025-01-31');
    assert.equal(mart.mrrReportedIn, 'CAD');
    // Review M4: another currency never shows base-currency MRR under its own label.
    const usd = await summary.loadRevenueSummaryFromMarts({ range: RANGE, currency: 'USD' });
    assert.equal(usd.mrr.mrrCents, 0);
    assert.equal(usd.mrr.payingSubscribers, 0);
    assert.equal(usd.mrrReportedIn, 'CAD');
    // Review M10: a window whose previous day was never rolled up says so instead of using an older row or zero silently.
    const uncovered = await summary.loadRevenueSummaryFromMarts({ range: { start: d('2024-12-31T00:00:00Z'), end: RANGE.end }, currency: 'CAD' });
    assert.equal(uncovered.openingCovered, false);
    assert.equal(uncovered.openingMrrCents, 0);
    // What the mart cannot say, it says plainly rather than reading a transactional table.
    assert.deepEqual(mart.paymentHealth.topFailureCodes, []);
  });

  it('freshness names the latest succeeded run per mart', async () => {
    const f = await freshness.martFreshness(['OrganizationDailyMart', 'DailyMetric', 'DailyRevenueRollup', 'SubscriptionCohortMart']);
    assert.deepEqual(f.map((x) => [...x.jobs]), [['organization_reporting'], ['daily_metrics', 'platform_metrics'], ['daily_revenue'], ['subscription_cohorts']]);
    // DailyMetric is written by two jobs: its as-of is the OLDER of the two latest successes, and null while either has never run.
    const latest = async (job: string) => (await db.rollupRun.findFirst({ where: { job, status: 'succeeded' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }))?.finishedAt ?? null;
    const dm = f.find((x) => x.mart === 'DailyMetric')!;
    const [stage13, stage21] = [await latest('daily_metrics'), await latest('platform_metrics')];
    assert.ok(stage21 instanceof Date);
    assert.equal(dm.asOf?.getTime() ?? null, stage13 === null ? null : Math.min(stage13.getTime(), stage21!.getTime()));
    await rollups.rollupPlatformMetrics(RANGE);
    const dm2 = (await freshness.martFreshness(['DailyMetric']))[0]!;
    assert.ok(dm2.asOf instanceof Date && dm2.stale === false, 'both jobs have run: the older success is the as-of');
    assert.ok(dm2.asOf.getTime() <= (await latest('daily_metrics'))!.getTime());
    for (const x of f.filter((y) => y.mart !== 'DailyMetric')) {
      assert.ok(x.asOf instanceof Date, `${x.mart} was rebuilt`);
      assert.equal(x.stale, false);
      assert.equal(x.lastError, null);
    }
  });

  it('the extraction writes one documented CSV per mart per day with rows', async () => {
    const files = new Map<string, string>();
    const result = await exporter.exportMarts(RANGE, { marts: ['OrganizationDailyMart', 'SubscriptionCohortMart'], put: async (key, body) => { files.set(key, body); }, exists: async (key) => key === 'warehouse/OrganizationDailyMart/2025-01-01.csv' });
    assert.equal(result.days, 31);
    const key = 'warehouse/OrganizationDailyMart/2025-01-06.csv';
    assert.ok(files.has(key), 'the submissions\' creation day is a file');
    const lines = files.get(key)!.split('\r\n').filter(Boolean);
    assert.equal(lines[0], exporter.MART_COLUMNS.OrganizationDailyMart.join(','));
    const rowsThatDay = await db.organizationDailyMart.count({ where: { day: '2025-01-06' } });
    assert.equal(lines.length - 1, rowsThatDay);
    assert.ok(lines.some((l) => l.startsWith(`2025-01-06,${A},employer,submissions,all,all,2,0,0`)));
    assert.equal(files.get('warehouse/OrganizationDailyMart/2025-01-01.csv'), exporter.MART_COLUMNS.OrganizationDailyMart.join(',') + '\r\n', 'a day that had a partition and now has no rows is overwritten header-only (review L15)');
    assert.ok(result.files.some((f) => f.key.endsWith('/2025-01-01.csv') && f.rows === 0));
    assert.ok(!files.has('warehouse/OrganizationDailyMart/2025-01-30.csv'), 'a day that never had rows writes no file');
    assert.ok(files.has('warehouse/SubscriptionCohortMart/2025-01-31.csv'));
    assert.ok([...files.keys()].every((k) => /^warehouse\/[A-Za-z]+\/\d{4}-\d{2}-\d{2}\.csv$/.test(k)));
    await assert.rejects(exporter.exportMarts(RANGE, { marts: ['Submission' as never], put: async () => {} }), /Unknown mart/);
  });

  it('the mart reads use their indexes', async () => {
    const plans = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const org = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN SELECT "metric", "valueInt" FROM "OrganizationDailyMart" WHERE "organizationId" = '${A}' AND "product" = 'employer' AND "day" >= '2025-01-01' AND "day" <= '2025-01-31'`);
      const metric = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN SELECT "day", "valueInt" FROM "DailyMetric" WHERE "metric" = 'failed_payments' AND "dimension" = 'all' AND "day" IN ('2025-01-01', '2025-01-02')`);
      const cohort = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN SELECT "retained" FROM "SubscriptionCohortMart" WHERE "currency" = 'CAD'`);
      return { org: org.map((r) => r['QUERY PLAN']).join('\n'), metric: metric.map((r) => r['QUERY PLAN']).join('\n'), cohort: cohort.map((r) => r['QUERY PLAN']).join('\n') };
    });
    // PostgreSQL truncates an index name to 63 characters; match the table prefix and the leading columns.
    const usesIndex = (prefix: string) => new RegExp(`(Index (Only )?Scan using|Bitmap Index Scan on) "${prefix}`);
    assert.match(plans.org, usesIndex('OrganizationDailyMart_organizationId_'));
    assert.match(plans.metric, usesIndex('DailyMetric_(metric_day|day_metric)'));
    assert.match(plans.cohort, usesIndex('SubscriptionCohortMart_currency_'));
  });
});

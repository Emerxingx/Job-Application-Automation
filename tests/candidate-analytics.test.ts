/**
 * Stage 13 - the candidate marts against the database: the rollup reads the
 * transactional truth once and writes rows the dashboard reads on the tenant
 * path; PARITY between the mart and the pure metric engine over the same
 * applications; a second run changes nothing; a single-user refresh does not
 * shrink the benchmark; another tenant sees nothing; the benchmark
 * suppresses a small cohort; RollupRun records the run.
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
type Rollup = typeof import('../src/lib/analytics/candidate/rollup');
type Read = typeof import('../src/lib/analytics/candidate/read');
type Metrics = typeof import('../src/lib/analytics/metrics');
type Ctx = typeof import('../src/lib/tenancy/context');
const S = randomBytes(4).toString('hex');
const A = { id: `ca_a_${S}`, email: `ca-a-${S}@ca.test` };
const B = { id: `ca_b_${S}`, email: `ca-b-${S}@ca.test` };
let db: Db;
let rollup: Rollup;
let read: Read;
let metrics: Metrics;
let ctx: Ctx;
const RANGE = { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-09-01T00:00:00Z') };

describe('Stage 13 - candidate marts against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    rollup = await import('../src/lib/analytics/candidate/rollup');
    read = await import('../src/lib/analytics/candidate/read');
    metrics = await import('../src/lib/analytics/metrics');
    ctx = await import('../src/lib/tenancy/context');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Mart', country: 'CA', createdAt: new Date('2026-08-01T00:00:00Z') } });
    // A's search: six applications across August with a real history each.
    const specs = [
      { title: 'Senior Data Analyst', company: 'Maple Analytics', day: '2026-08-03', path: ['ready_to_submit', 'submitted', 'interviewing', 'offer'], outcome: 'hired', score: 88, interview: 'phone' },
      { title: 'Data Analyst', company: 'Birch Financial', day: '2026-08-05', path: ['ready_to_submit', 'submitted', 'rejected'], outcome: 'rejected', score: 72, interview: null },
      { title: 'Reporting Analyst', company: 'Cedar Health', day: '2026-08-05', path: ['ready_to_submit', 'submitted'], outcome: 'pending', score: 65, interview: null },
      { title: 'Data Analyst', company: 'Oak Retail', day: '2026-08-12', path: ['ready_to_submit', 'submitted', 'interviewing', 'rejected'], outcome: 'rejected', score: 80, interview: 'video' },
      { title: 'BI Developer', company: 'Pine Logistics', day: '2026-08-20', path: ['ready_to_submit'], outcome: 'pending', score: 55, interview: null },
      { title: 'Data Analyst', company: 'Elm Media', day: '2026-08-25', path: ['queued', 'failed'], outcome: 'pending', score: 90, interview: null },
    ];
    let n = 0;
    for (const s of specs) {
      n += 1;
      const job = await db.job.create({ data: { source: 'mock', externalId: `ca-${S}-${n}`, title: s.title, normalizedTitle: s.title.toLowerCase(), company: s.company, location: 'Toronto, ON', country: 'CA', description: 'x', postedAt: new Date(`${s.day}T00:00:00Z`) } });
      const createdAt = new Date(`${s.day}T10:00:00Z`);
      const final = s.path[s.path.length - 1];
      const sent = s.path.includes('submitted');
      const responded = s.path.includes('interviewing') || s.path.includes('rejected');
      const app = await db.application.create({ data: { userId: A.id, jobId: job.id, status: final, outcome: s.outcome, matchScore: s.score, createdAt, appliedAt: sent ? new Date(createdAt.getTime() + 3600_000) : null, respondedAt: responded ? new Date(createdAt.getTime() + 49 * 3600_000) : null } });
      let from = '';
      for (const to of s.path) {
        await db.applicationStatusHistory.create({ data: { userId: A.id, applicationId: app.id, fromStatus: from, toStatus: to, actor: 'system', source: 'applicator', at: createdAt } });
        from = to;
      }
      if (s.interview) await db.applicationInterview.create({ data: { userId: A.id, applicationId: app.id, kind: s.interview, scheduledAt: new Date(createdAt.getTime() + 72 * 3600_000) } });
      await db.documentVersion.create({ data: { userId: A.id, applicationId: app.id, scopeKey: app.id, kind: 'resume', format: 'txt', version: n <= 3 ? 1 : 2, contentHash: 'h', sizeBytes: 1, storageKey: `ca-${S}/${n}` } });
    }
    const agent = await db.agent.create({ data: { userId: A.id, name: 'a', keywords: '[]', locations: '[]' } });
    const job = await db.job.findFirstOrThrow({ where: { externalId: `ca-${S}-1` } });
    await db.jobMatch.create({ data: { agentId: agent.id, jobId: job.id, matchScore: 88, createdAt: new Date('2026-08-02T00:00:00Z'), matchedKeywords: JSON.stringify(['sql', 'python']), missingKeywords: JSON.stringify(['tableau']) } });
  });
  after(async () => {
    await db.candidateBenchmarkMart.deleteMany({ where: { day: { gte: '2026-08-01', lt: '2026-09-01' } } });
    await db.rollupRun.deleteMany({ where: { job: rollup.CANDIDATE_ROLLUP_JOB, windowStart: { gte: new Date('2026-07-01T00:00:00Z') } } });
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.job.deleteMany({ where: { externalId: { startsWith: `ca-${S}` } } });
    await db.$disconnect();
  });

  it('the rollup writes the marts and records its run; the dashboard read on the tenant path matches the pure engine over the same rows (parity)', async () => {
    const result = await rollup.rollupCandidateOutcomes(RANGE, { userId: A.id });
    assert.equal(result.applicationsRead, 6);
    assert.equal(result.matchesRead, 1);
    assert.ok(result.outcomeRows > 6, 'one row per dimension key per day');
    const run = await db.rollupRun.findFirst({ where: { job: rollup.CANDIDATE_ROLLUP_JOB }, orderBy: { startedAt: 'desc' } });
    assert.equal(run?.status, 'succeeded');

    const view = await ctx.withTenant({ userId: A.id }, (tx) => read.readCandidateOutcomes(tx, A.id, RANGE, 'day'));
    // The transactional truth, through the pre-existing pure engine (Stage 00), over the same applications.
    const rows = await metrics.loadApplicationRows(A.id, { range: RANGE });
    const truth = metrics.computeApplicationMetrics(rows, { range: RANGE });
    const parity = {
      applications: [view.totals.applications, truth.totals.applications],
      sent: [view.totals.sent, truth.totals.sent],
      responded: [view.totals.responded, truth.totals.responded],
      offers: [view.totals.offers, truth.totals.offers],
      responseRate: [view.rates.responseRate.parts, truth.funnel.responseRate.parts],
      offerRate: [view.rates.offerRate.parts, truth.funnel.offerRate.parts],
      averageMatchScore: [view.averageMatchScore, truth.totals.averageMatchScore],
      byCompanyTop: [view.cuts.company[0].key, truth.byCompany[0].key.toLowerCase()],
    };
    for (const [k, [mart, live]] of Object.entries(parity)) assert.equal(mart, live, `parity on ${k}: mart ${mart} vs transactional ${live}`);
    // Where the definitions deliberately differ, the mart is the richer one: reach from the HISTORY.
    assert.equal(view.totals.interviews, 2, 'two applications interviewed (one later rejected)');
    assert.equal(truth.totals.interviews, 1, 'the status-only engine sees one, the record still at offer');
    assert.equal(view.totals.hires, 1);
    assert.equal(view.totals.screens, 1);
    assert.equal(view.totals.failed, 1);
    assert.equal(view.totals.responseSamples, 3);
    assert.equal(view.averageResponseHours, 48);
    assert.deepEqual(view.cuts.resume_version.map((c) => `${c.key}=${c.applications}`), ['v1=3', 'v2=3']);
    assert.deepEqual(view.cuts.seniority.map((c) => c.key).sort(), ['senior', 'unspecified']);
    assert.equal(view.cuts.score_band.find((c) => c.key === '85-100')?.applications, 2);
    const matches = await ctx.withTenant({ userId: A.id }, (tx) => read.readCandidateMatches(tx, A.id, RANGE));
    assert.equal(matches.totalMatches, 1);
    assert.deepEqual(matches.topMissingKeywords[0], { keyword: 'tableau', count: 1, parts: 1_000_000 });
    const totals = await ctx.withTenant({ userId: A.id }, (tx) => read.readCandidateTotals(tx, A.id));
    assert.equal(totals.applications, 6);
  });

  it('a second run changes nothing; a single-user refresh rebuilds the benchmark from the whole mart rather than shrinking it', async () => {
    const before = await db.candidateOutcomeMart.findMany({ where: { userId: A.id }, orderBy: [{ day: 'asc' }, { dimension: 'asc' }, { key: 'asc' }] });
    await rollup.rollupCandidateOutcomes(RANGE, { userId: A.id });
    const afterRows = await db.candidateOutcomeMart.findMany({ where: { userId: A.id }, orderBy: [{ day: 'asc' }, { dimension: 'asc' }, { key: 'asc' }] });
    assert.deepEqual(afterRows.map((r) => [r.day, r.dimension, r.key, r.applications, r.sent, r.interviews]), before.map((r) => [r.day, r.dimension, r.key, r.applications, r.sent, r.interviews]));
    assert.equal(afterRows.length, before.length);
    // B (no applications) refreshes: A's rows and the benchmark rows for those days survive.
    await rollup.refreshCandidateMarts(B.id, new Date('2026-08-31T00:00:00Z'));
    assert.equal(await db.candidateOutcomeMart.count({ where: { userId: A.id } }), before.length);
    const bench = await db.candidateBenchmarkMart.findFirst({ where: { day: '2026-08-05', dimension: 'all' } });
    assert.ok(bench && bench.applications >= 2, 'the benchmark still carries A');
  });

  it('another tenant reads nothing; the benchmark suppresses a cohort under five people', async () => {
    const other = await ctx.withTenant({ userId: B.id }, (tx) => read.readCandidateOutcomes(tx, B.id, RANGE));
    assert.equal(other.totals.applications, 0);
    assert.deepEqual(await ctx.withTenant({ userId: B.id }, (tx) => tx.candidateOutcomeMart.findMany({ where: { userId: A.id } })), []);
    assert.deepEqual(await ctx.withTenant({ userId: B.id }, (tx) => tx.candidateBenchmarkMart.findMany()), [], 'the benchmark has no tenant policy: a tenant transaction sees no row at all');
    const bench = await read.readBenchmark('title', 'data analyst', RANGE);
    assert.equal(bench.suppressed, true, 'one person is not a cohort');
    if (bench.suppressed) assert.match(bench.reason, /Fewer than 5 people/);
  });
});

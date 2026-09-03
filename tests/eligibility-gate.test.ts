/**
 * Stage 07 — eligibility against the database: the facts are read on the
 * tenant path and audited; verdicts are stored per (user, job) and go stale
 * with the profile; the scanner gates every posting BEFORE scoring, so an
 * ineligible posting never becomes a match and the exclusion is recorded
 * with its reason; tenants see only their own verdicts.
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
type Service = typeof import('../src/lib/eligibility/service');
type Ctx = typeof import('../src/lib/tenancy/context');
type Prefs = typeof import('../src/lib/candidate/preferences');
type Scanner = typeof import('../src/lib/services/scanner');
const S = randomBytes(4).toString('hex');
const A = { id: `elig_a_${S}`, email: `elig-a-${S}@elig.test` };
const B = { id: `elig_b_${S}`, email: `elig-b-${S}@elig.test` };
let db: Db;
let service: Service;
let ctx: Ctx;
let prefs: Prefs;
let scanner: Scanner;

describe('Stage 07 — eligibility gate against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    service = await import('../src/lib/eligibility/service');
    ctx = await import('../src/lib/tenancy/context');
    prefs = await import('../src/lib/candidate/preferences');
    scanner = await import('../src/lib/services/scanner');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Eligibility', country: 'CA' } });
    // A needs sponsorship; B is a citizen. Written on the tenant path like the settings form does.
    await ctx.withTenant({ userId: A.id }, (tx) => prefs.saveWorkAuthorization(tx, A.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'requires_sponsorship', sponsorshipNeeded: true, notes: '' })));
    await ctx.withTenant({ userId: B.id }, (tx) => prefs.saveWorkAuthorization(tx, B.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'citizen', sponsorshipNeeded: false, notes: '' })));
  });
  after(async () => {
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id] } } });
    await db.$disconnect();
  });

  it('reads the facts on the tenant path and audits the read without a value', async () => {
    const profile = await service.loadCandidateEligibility(A.id, { reason: 'test', jobs: 3 });
    assert.equal(profile.facts.workAuth?.status, 'requires_sponsorship');
    assert.ok(profile.version, 'a profile version derived from the rows read');
    const audit = await db.auditLog.findFirst({ where: { action: 'eligibility.profile.read', actorId: A.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit, 'the read is audited');
    assert.equal(JSON.parse(audit.after ?? '{}').jobs, 3);
    assert.ok(!(audit.after ?? '').includes('requires_sponsorship'), 'never a value');
  });

  it('stores one verdict per (user, job), keeps it while the profile is unchanged, and re-evaluates when the profile changes', async () => {
    const job = await db.job.create({ data: { source: 'mock', externalId: `elig_job_${S}`, title: 'Data Analyst', company: 'Co', location: 'Toronto, ON', country: 'CA', description: 'x', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: new Date(), postalRegion: 'CA-ON/toronto', workAuthorization: 'authorization_required', sponsorship: 'not_offered', canonicalHash: `h_elig_${S}` } });
    try {
      const profile = await service.loadCandidateEligibility(A.id, { reason: 'test' });
      const first = await service.ensureEligibility(db, A.id, job, profile);
      assert.equal(first.fresh, true);
      assert.equal(first.verdict.outcome, 'ineligible');
      const second = await service.ensureEligibility(db, A.id, job, profile);
      assert.equal(second.fresh, false, 'unchanged profile: the stored verdict is reused');
      assert.equal(second.result.id, first.result.id);
      // The candidate becomes a permanent resident: the verdict is stale and re-computed.
      await new Promise((r) => setTimeout(r, 5));
      await ctx.withTenant({ userId: A.id }, (tx) => prefs.saveWorkAuthorization(tx, A.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'permanent_resident', sponsorshipNeeded: false, notes: '' })));
      const updated = await service.loadCandidateEligibility(A.id, { reason: 'test' });
      assert.notEqual(updated.version, profile.version);
      const third = await service.ensureEligibility(db, A.id, job, updated);
      assert.equal(third.fresh, true);
      assert.equal(third.verdict.outcome, 'eligible');
      assert.equal(await db.eligibilityResult.count({ where: { userId: A.id, jobId: job.id } }), 1, 'one row per (user, job)');
      // Back to needing sponsorship for the scanner test below.
      await ctx.withTenant({ userId: A.id }, (tx) => prefs.saveWorkAuthorization(tx, A.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'requires_sponsorship', sponsorshipNeeded: true, notes: '' })));
    } finally {
      await db.job.delete({ where: { id: job.id } });
    }
  });

  it('the scanner gates BEFORE scoring: an ineligible posting never becomes a match, and the exclusion is recorded with its reason', async () => {
    // A's résumé, so the scan can run; the agent targets the mock posting that says it does not sponsor.
    for (const u of [A, B]) {
      const profile = await import('../src/lib/candidate/profile');
      await ctx.withTenant({ userId: u.id }, async (tx) => {
        const content = { fullName: 'Eligibility Tester', headline: 'Data Analyst', email: u.email, summary: 'Analyst with SQL and Python.', skills: ['SQL', 'Python', 'Tableau'], experience: [{ title: 'Data Analyst', company: 'Old Co', location: 'Toronto', startDate: '2021-01', endDate: 'Present', bullets: ['Built SQL reporting', 'Python pipelines'] }], education: [], certifications: [], projects: [] };
        await profile.saveResumeSections(tx, u.id, content);
        await profile.writeResumeProjection(tx, u.id, content);
      });
    }
    const mkAgent = (userId: string) => db.agent.create({ data: { userId, name: `Elig ${S}`, titles: JSON.stringify(['Senior Data Analyst', 'Data Analyst']), keywords: '[]', excludeKeywords: '[]', locations: JSON.stringify(['Toronto']), workMode: 'any', jobType: 'any', minMatchScore: 0, autoApplyThreshold: 101, status: 'active' } });
    const agentA = await mkAgent(A.id);
    const agentB = await mkAgent(B.id);
    try {
      const resultA = await scanner.runAgentScan(A.id, agentA.id);
      assert.ok(resultA.excluded >= 1, `A needs sponsorship: at least the posting that says it does not sponsor is excluded (${resultA.excluded})`);
      const excludedJobs = await db.eligibilityResult.findMany({ where: { userId: A.id, outcome: 'ineligible' }, include: { job: { select: { id: true, title: true } } } });
      assert.ok(excludedJobs.some((e) => e.job.title.startsWith('Senior Data Analyst')), 'the no-sponsorship posting is among the exclusions');
      for (const e of excludedJobs) {
        const rules = JSON.parse(e.rules) as { status: string; reason: string }[];
        assert.ok(rules.some((r) => r.status === 'fail' && /sponsor|authori[sz]ation/.test(r.reason)), 'every exclusion states its reason');
        assert.equal(await db.jobMatch.count({ where: { agentId: agentA.id, jobId: e.jobId } }), 0, 'an ineligible posting never becomes a match');
      }
      // B is a citizen: the same posting is scored, not excluded.
      const resultB = await scanner.runAgentScan(B.id, agentB.id);
      const excludedB = await db.eligibilityResult.count({ where: { userId: B.id, outcome: 'ineligible' } });
      assert.equal(excludedB, 0, `a citizen who does not need sponsorship is excluded from nothing (${resultB.excluded})`);
      assert.ok(resultB.newMatches >= 1);
      // Every scored posting has a stored verdict too (eligible or unknown), so nothing is silent.
      const matchesB = await db.jobMatch.findMany({ where: { agentId: agentB.id }, select: { jobId: true } });
      for (const m of matchesB) {
        const v = await db.eligibilityResult.findUnique({ where: { userId_jobId: { userId: B.id, jobId: m.jobId } } });
        assert.ok(v && v.outcome !== 'ineligible');
      }
    } finally {
      await db.agent.deleteMany({ where: { id: { in: [agentA.id, agentB.id] } } });
    }
  });

  it('review H1: adding a certification changes the profile version, so a licensure exclusion is re-evaluated', async () => {
    const nurse = await db.job.create({ data: { source: 'mock', externalId: `elig_rn_${S}`, title: 'Registered Nurse', normalizedTitle: 'registered nurse', company: 'Hospital', location: 'Toronto, ON', country: 'CA', description: 'RN required.', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: new Date(), postalRegion: 'CA-ON/toronto', certificationRequirements: JSON.stringify(['rn']), canonicalHash: `h_rn_${S}` } });
    try {
      const before = await service.loadCandidateEligibility(B.id, { reason: 'test' });
      const first = await service.ensureEligibility(db, B.id, nurse, before);
      assert.equal(first.verdict.outcome, 'ineligible');
      const profile = await import('../src/lib/candidate/profile');
      await ctx.withTenant({ userId: B.id }, async (tx) => {
        const content = { fullName: 'Eligibility Tester', headline: 'Registered Nurse', email: B.email, summary: 'Nurse.', skills: ['Triage'], experience: [], education: [], certifications: ['Registered Nurse (CNO)'], projects: [] };
        await profile.saveResumeSections(tx, B.id, content);
        await profile.writeResumeProjection(tx, B.id, content);
      });
      const after = await service.loadCandidateEligibility(B.id, { reason: 'test' });
      assert.notEqual(after.version, before.version, 'certifications are part of the profile version');
      const second = await service.ensureEligibility(db, B.id, nurse, after);
      assert.equal(second.fresh, true);
      assert.equal(second.verdict.outcome, 'eligible', 'the spelled-out designation counts');
    } finally {
      await db.job.delete({ where: { id: nurse.id } });
    }
  });

  it('review H2: a match created while eligible is demoted when the candidate becomes ineligible, hidden by the feed filter, and restored when the verdict lifts', async () => {
    const job = await db.job.create({ data: { source: 'mock', externalId: `elig_flip_${S}`, title: 'Data Analyst', normalizedTitle: 'data analyst', company: 'Co', location: 'Toronto, ON', country: 'CA', description: 'x', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: new Date(), postalRegion: 'CA-ON/toronto', workAuthorization: 'authorization_required', sponsorship: 'not_offered', canonicalHash: `h_flip_${S}` } });
    const agent = await db.agent.create({ data: { userId: B.id, name: `Flip ${S}`, titles: '[]', keywords: '[]', excludeKeywords: '[]', locations: '[]', workMode: 'any', jobType: 'any', minMatchScore: 0, autoApplyThreshold: 101, status: 'active' } });
    try {
      // Eligible: a match exists.
      const eligible = await service.loadCandidateEligibility(B.id, { reason: 'test' });
      assert.equal((await service.ensureEligibility(db, B.id, job, eligible)).verdict.outcome, 'eligible');
      const match = await db.jobMatch.create({ data: { agentId: agent.id, jobId: job.id, matchScore: 80, status: 'new' } });
      const feedWhere = { agent: { userId: B.id }, status: { in: ['new', 'reviewed', 'queued'] }, job: { activeState: { not: 'closed' }, ...service.notIneligibleFor(B.id) } };
      assert.equal(await db.jobMatch.count({ where: { ...feedWhere, jobId: job.id } }), 1, 'in the feed while eligible');
      // The candidate now needs sponsorship: the verdict flips on the next evaluation.
      await ctx.withTenant({ userId: B.id }, (tx) => prefs.saveWorkAuthorization(tx, B.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'requires_sponsorship', sponsorshipNeeded: true, notes: '' })));
      const needs = await service.loadCandidateEligibility(B.id, { reason: 'test' });
      assert.equal((await service.ensureEligibility(db, B.id, job, needs)).verdict.outcome, 'ineligible');
      assert.equal((await db.jobMatch.findUniqueOrThrow({ where: { id: match.id } })).status, 'ineligible', 'demoted, not deleted');
      assert.equal(await db.jobMatch.count({ where: { ...feedWhere, jobId: job.id } }), 0, 'and out of the feed');
      // Back to citizen: restored.
      await ctx.withTenant({ userId: B.id }, (tx) => prefs.saveWorkAuthorization(tx, B.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'citizen', sponsorshipNeeded: false, notes: '' })));
      const citizen = await service.loadCandidateEligibility(B.id, { reason: 'test' });
      assert.equal((await service.ensureEligibility(db, B.id, job, citizen)).verdict.outcome, 'eligible');
      assert.equal((await db.jobMatch.findUniqueOrThrow({ where: { id: match.id } })).status, 'new');
      assert.equal(await db.jobMatch.count({ where: { ...feedWhere, jobId: job.id } }), 1);
    } finally {
      await db.agent.delete({ where: { id: agent.id } });
      await db.job.delete({ where: { id: job.id } });
    }
  });

  it('review M5: a page view with a current verdict reads no facts and writes no audit row; a stale one does', async () => {
    const { eligibilityForPage } = await import('../src/lib/eligibility/page');
    const job = await db.job.create({ data: { source: 'mock', externalId: `elig_page_${S}`, title: 'Data Analyst', normalizedTitle: 'data analyst', company: 'Co', location: 'Toronto, ON', country: 'CA', description: 'x', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: new Date(), postalRegion: 'CA-ON/toronto', canonicalHash: `h_page_${S}` } });
    const run = <T,>(fn: (tx: Parameters<Parameters<typeof ctx.withTenant>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId: B.id }, fn);
    const audits = () => db.auditLog.count({ where: { action: 'eligibility.profile.read', actorId: B.id } });
    try {
      const n0 = await audits();
      const first = await eligibilityForPage(B.id, job, run);
      assert.equal(first.fresh, true, 'no verdict yet: evaluated (one audited read)');
      const n1 = await audits();
      assert.equal(n1, n0 + 1);
      const second = await eligibilityForPage(B.id, job, run);
      const third = await eligibilityForPage(B.id, job, run);
      assert.equal(second.fresh, false);
      assert.equal(third.fresh, false);
      assert.equal(await audits(), n1, 'two more views, no audit rows');
      await new Promise((r) => setTimeout(r, 5));
      await ctx.withTenant({ userId: B.id }, (tx) => prefs.saveWorkAuthorization(tx, B.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'permanent_resident', sponsorshipNeeded: false, notes: '' })));
      const fourth = await eligibilityForPage(B.id, job, run);
      assert.equal(fourth.fresh, true, 'a profile change re-evaluates');
      assert.equal(await audits(), n1 + 1);
    } finally {
      await db.job.delete({ where: { id: job.id } });
    }
  });

  it('tenants see their own verdicts only, and cannot forge one', async () => {
    const mine = await ctx.withTenant({ userId: A.id }, (tx) => tx.eligibilityResult.findMany());
    assert.ok(mine.length >= 1);
    assert.ok(mine.every((r) => r.userId === A.id));
    const theirs = await ctx.withTenant({ userId: B.id }, (tx) => tx.eligibilityResult.findMany({ where: { userId: A.id } }));
    assert.deepEqual(theirs, []);
    await assert.rejects(
      () => ctx.withTenant({ userId: B.id }, (tx) => tx.eligibilityResult.create({ data: { userId: A.id, jobId: mine[0].jobId, outcome: 'eligible', rulesVersion: 'forged' } })),
      /row-level security|42501|permission denied/,
    );
  });
});

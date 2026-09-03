/**
 * Stage 08 — the compatibility engine against the database: the governed
 * weight register (draft → second-admin approval → active → retired,
 * rollback recorded, cache invalidated), the built-in baseline when nothing
 * is active, the regression that an existing match keeps the version and
 * score it was computed with when a new version is activated, the
 * per-dimension rows the scanner writes with their citations, and tenant
 * isolation of dimensions and the register.
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
type Weights = typeof import('../src/lib/matching/weights');
type Ctx = typeof import('../src/lib/tenancy/context');
type Scanner = typeof import('../src/lib/services/scanner');
type Pipeline = typeof import('../src/lib/matching/pipeline');
type Keywords = typeof import('../src/lib/providers/ai/keywords');
const S = randomBytes(4).toString('hex');
const A = { id: `mw_staff_a_${S}`, email: `mw-a-${S}@mw.test`, fullName: 'Admin A', role: 'admin' as const, storedRole: 'admin' };
const B = { id: `mw_staff_b_${S}`, email: `mw-b-${S}@mw.test`, fullName: 'Admin B', role: 'admin' as const, storedRole: 'admin' };
const USER = { id: `mw_user_${S}`, email: `mw-user-${S}@mw.test` };
let db: Db;
let weights: Weights;
let ctx: Ctx;
let scanner: Scanner;
let pipeline: Pipeline;
let keywords: Keywords;

describe('Stage 08 — weight governance, regression and dimensions against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    weights = await import('../src/lib/matching/weights');
    ctx = await import('../src/lib/tenancy/context');
    scanner = await import('../src/lib/services/scanner');
    pipeline = await import('../src/lib/matching/pipeline');
    keywords = await import('../src/lib/providers/ai/keywords');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName, role: 'admin' } });
    await db.user.create({ data: { id: USER.id, email: USER.email, passwordHash: 'x', fullName: 'Candidate', country: 'CA' } });
    // A clean register: any active version left by an earlier run would change every score below.
    await db.matchWeightVersion.deleteMany({});
    await weights.invalidateActiveWeights();
    const profile = await import('../src/lib/candidate/profile');
    const prefs = await import('../src/lib/candidate/preferences');
    await ctx.withTenant({ userId: USER.id }, async (tx) => {
      const content = { fullName: 'Candidate', headline: 'Data Analyst', email: USER.email, summary: 'Analyst with SQL, Python and Tableau.', skills: ['SQL', 'Python', 'Tableau'], experience: [{ title: 'Data Analyst', company: 'Old Co', location: 'Toronto', startDate: '2021-01', endDate: 'Present', bullets: ['Built SQL reporting', 'Python pipelines'] }], education: [], certifications: [], projects: [] };
      await profile.saveResumeSections(tx, USER.id, content);
      await profile.writeResumeProjection(tx, USER.id, content);
      await prefs.saveWorkAuthorization(tx, USER.id, prefs.workAuthorizationSchema.parse({ country: 'CA', status: 'citizen', sponsorshipNeeded: false, notes: '' }));
    });
  });
  after(async () => {
    await db.matchWeightVersion.deleteMany({});
    await weights.invalidateActiveWeights();
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id, USER.id] } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id, USER.id] } } });
    await db.$disconnect();
  });

  it('with no active version the built-in baseline scores, recorded as builtin:1', async () => {
    const active = await weights.getActiveWeights();
    assert.equal(active.version, weights.BUILTIN_WEIGHT_VERSION);
    assert.deepEqual(active.weights, weights.BUILTIN_WEIGHTS);
  });

  it('the scanner writes a match with its weight version and one cited dimension row per dimension', async () => {
    const agent = await db.agent.create({ data: { userId: USER.id, name: `MW ${S}`, titles: JSON.stringify(['Data Analyst', 'Senior Data Analyst']), keywords: '[]', excludeKeywords: '[]', locations: JSON.stringify(['Toronto']), workMode: 'any', jobType: 'any', minMatchScore: 0, autoApplyThreshold: 101, status: 'active' } });
    try {
      const result = await scanner.runAgentScan(USER.id, agent.id);
      assert.ok(result.newMatches >= 1);
      const matches = await db.jobMatch.findMany({ where: { agentId: agent.id }, include: { dimensions: true } });
      for (const m of matches) {
        assert.equal(m.weightVersion, 'builtin:1');
        assert.ok(m.pipelineVersion);
        assert.deepEqual(m.dimensions.map((d) => d.dimension).sort(), ['experience', 'keywords', 'location', 'seniority', 'skills']);
        const breakdown = JSON.parse(m.scoreBreakdown) as Record<string, number>;
        let sumWeights = 0;
        for (const d of m.dimensions) {
          assert.equal(d.score, breakdown[d.dimension], 'the dimension row is the breakdown value');
          assert.equal(d.userId, USER.id);
          assert.ok(d.note.length > 10, 'every dimension explains itself');
          assert.ok(Math.abs(d.contribution - Math.round(d.score * d.weight * 100) / 100) < 0.011, 'contribution = score × weight');
          sumWeights += d.weight;
        }
        assert.ok(Math.abs(sumWeights - 1) < 0.001);
      }
      // The strongest match's skills dimension names what matched and what was missing.
      const best = matches.sort((a, b) => b.matchScore - a.matchScore)[0];
      const skills = best.dimensions.find((d) => d.dimension === 'skills')!;
      assert.ok(JSON.parse(skills.matched).length + JSON.parse(skills.missing).length > 0);
    } finally {
      await db.agent.delete({ where: { id: agent.id } });
    }
  });

  it('the decomposition is truthful: semantic matches are labelled, nice-to-haves are marked, keywords decompose into the tokens scored, citations are precise, the score is the weights applied to the breakdown', async () => {
    const job = await db.job.create({
      data: {
        source: 'mock',
        externalId: `mw-decomp-${S}`,
        title: 'Data Analyst',
        company: `Maple ${S}`,
        location: 'Toronto, ON',
        description: 'We need Postgres and Python. Nice to have: Looker.',
        requirements: JSON.stringify(['Strong SQL and Postgres']),
        skills: JSON.stringify(['postgres', 'python', 'looker']),
        requiredSkills: JSON.stringify(['postgres', 'python', 'sql']),
        preferredSkills: JSON.stringify(['looker']),
        experienceYearsMin: 1,
        postedAt: new Date(),
      },
    });
    try {
      const resume = { fullName: 'Candidate', headline: 'Data Analyst', email: USER.email, location: 'Toronto, ON', summary: 'Analyst with PostgreSQL, Python and Tableau.', skills: ['PostgreSQL', 'Python', 'Tableau'], experience: [{ title: 'Data Analyst', company: 'Old Co', location: 'Toronto', startDate: '2021-01', endDate: 'Present', bullets: ['Built SQL reporting', 'Python pipelines'] }], education: [], certifications: [], projects: [] };
      const entries = [
        { id: 'x', kind: 'achievement', claim: 'Helped the team go live with new reporting' },
        { id: 'y', kind: 'skill', claim: 'Skill: PostgreSQL' },
        { id: 'z', kind: 'employment', claim: 'Data Analyst at Old Co, 2021-01 to present' },
        { id: 'w', kind: 'achievement', claim: 'Built SQL reporting for finance' },
      ];
      const active = await weights.getActiveWeights();
      const r = await pipeline.scoreCompatibility({ userId: USER.id, resume, evidence: { ids: entries.map((e) => e.id), claims: entries.map((e) => e.claim), entries }, job, weights: active });
      assert.equal(r.run.route, 'deterministic');
      assert.equal(r.analysis.matchScore, keywords.combineScore(r.analysis.breakdown, active.weights), 'the recorded score is the governed rule over the breakdown');

      const skills = r.dimensions.find((d) => d.dimension === 'skills')!;
      assert.deepEqual(skills.matched.find((m) => m.term === 'postgres'), { term: 'postgres', how: 'semantic', via: 'postgresql' }, 'satisfied through the map, and says so');
      assert.deepEqual(skills.matched.filter((m) => m.how === 'exact').map((m) => m.term), ['python', 'sql']);
      assert.deepEqual(skills.missing, [{ term: 'looker', level: 'preferred' }]);
      assert.equal(r.analysis.breakdown.skills, 86, '3 of 3.5: the nice-to-have costs half');
      assert.deepEqual(skills.evidenceIds, ['y', 'w'], '"go live" is not evidence of anything asked for; the SQL and PostgreSQL claims are');
      assert.match(skills.note, /3 of 3 required skills evidenced; 0 of 1 nice-to-haves \(1 through the equivalence map\)/);
      assert.deepEqual(r.semanticMatches, [{ required: 'postgres', satisfiedBy: 'postgresql', how: 'semantic' }]);

      const kw = r.dimensions.find((d) => d.dimension === 'keywords')!;
      assert.deepEqual(kw.matched.map((m) => m.term), ['analyst', 'data', 'python', 'sql'], 'the tokens the density score counted');
      assert.deepEqual(kw.missing, [{ term: 'looker', level: 'wording' }, { term: 'postgres', level: 'wording' }]);
      assert.deepEqual(kw.evidenceIds, ['z', 'w'], 'claims containing those tokens as whole words');
      assert.match(kw.note, /4 of 6 terms/);

      assert.deepEqual(r.dimensions.find((d) => d.dimension === 'experience')!.evidenceIds, ['z']);
      assert.deepEqual(r.dimensions.find((d) => d.dimension === 'seniority')!.evidenceIds, ['z'], 'the claim carrying the highest-level title');
      const location = r.dimensions.find((d) => d.dimension === 'location')!;
      assert.deepEqual(location.evidenceIds, []);
      assert.match(location.note, /not an evidence claim/);

      // The persisted shape carries the labels.
      const rows = pipeline.matchRows(USER.id, r);
      const stored = JSON.parse(rows.dimensions.find((d) => d.dimension === 'skills')!.matched) as { term: string; how: string; via?: string }[];
      assert.ok(stored.some((m) => m.how === 'semantic' && m.via === 'postgresql'));
      assert.equal(rows.match.pipelineVersion, pipeline.PIPELINE_VERSION);
    } finally {
      await db.job.delete({ where: { id: job.id } });
    }
  });

  it('governance: create → approve by a second admin → activate; a match scored before keeps its version and score; rollback recorded; retire rules', async () => {
    const v1 = await weights.createWeightVersion({ weights: { skills: 0.5, keywords: 0.2, experience: 0.15, seniority: 0.1, location: 0.05 }, notes: 'skills-heavy' }, A);
    assert.equal(v1.version, 1);
    assert.equal(v1.status, 'draft');
    await assert.rejects(() => weights.activateWeightVersion(v1.id, A), /Only an approved version/);
    await assert.rejects(() => weights.approveWeightVersion(v1.id, A), /second admin/);
    await assert.rejects(() => weights.createWeightVersion({ weights: { skills: 0.9, keywords: 0.2, experience: 0.15, seniority: 0.1, location: 0.05 } }, A), /sum to 1/);
    await weights.approveWeightVersion(v1.id, B);
    // No evaluation gate exists for weights; the governance signal in its place is a mandatory, audited reason.
    await assert.rejects(() => weights.activateWeightVersion(v1.id, A), /reason is required/);
    await assert.rejects(() => weights.activateWeightVersion(v1.id, A, '   '), /reason is required/);

    // A match scored with the baseline, before activation.
    const agent = await db.agent.create({ data: { userId: USER.id, name: `MW2 ${S}`, titles: JSON.stringify(['Data Analyst']), keywords: '[]', excludeKeywords: '[]', locations: JSON.stringify(['Toronto']), workMode: 'any', jobType: 'any', minMatchScore: 0, autoApplyThreshold: 101, status: 'active' } });
    try {
      await scanner.runAgentScan(USER.id, agent.id);
      const before = await db.jobMatch.findMany({ where: { agentId: agent.id } });
      assert.ok(before.length >= 1);
      assert.ok(before.every((m) => m.weightVersion === 'builtin:1'));

      await weights.activateWeightVersion(v1.id, A, 'go live');
      const active = await weights.getActiveWeights();
      assert.equal(active.version, 'v1');
      assert.equal(active.weights.skills, 0.5);

      // Regression: the stored matches are untouched — same score, same version.
      const after = await db.jobMatch.findMany({ where: { agentId: agent.id } });
      for (const m of after) {
        const was = before.find((b) => b.id === m.id)!;
        assert.equal(m.matchScore, was.matchScore);
        assert.equal(m.weightVersion, 'builtin:1');
      }
      // A NEW agent's matches are scored with v1 and say so.
      const agent2 = await db.agent.create({ data: { userId: USER.id, name: `MW3 ${S}`, titles: JSON.stringify(['Data Analyst']), keywords: '[]', excludeKeywords: '[]', locations: JSON.stringify(['Toronto']), workMode: 'any', jobType: 'any', minMatchScore: 0, autoApplyThreshold: 101, status: 'active' } });
      try {
        await scanner.runAgentScan(USER.id, agent2.id);
        const fresh = await db.jobMatch.findMany({ where: { agentId: agent2.id }, include: { dimensions: true } });
        assert.ok(fresh.length >= 1);
        assert.ok(fresh.every((m) => m.weightVersion === 'v1'));
        assert.ok(fresh.every((m) => m.dimensions.find((d) => d.dimension === 'skills')?.weight === 0.5));
      } finally {
        await db.agent.delete({ where: { id: agent2.id } });
      }
    } finally {
      await db.agent.delete({ where: { id: agent.id } });
    }

    // v2, then rollback to v1 is recorded as a rollback; the active version cannot be retired.
    const v2 = await weights.createWeightVersion({ weights: { skills: 0.3, keywords: 0.3, experience: 0.2, seniority: 0.1, location: 0.1 } }, B);
    await weights.approveWeightVersion(v2.id, A);
    await weights.activateWeightVersion(v2.id, B, 'trial of a keyword-heavier mix');
    assert.equal((await weights.getActiveWeights()).version, 'v2');
    await weights.activateWeightVersion(v1.id, B, 'v2 over-weighted keywords');
    const audit = await db.auditLog.findMany({ where: { entityType: 'MatchWeightVersion', entityId: v1.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(audit.map((a) => a.action), ['match_weights.create', 'match_weights.approve', 'match_weights.activate', 'match_weights.rollback']);
    assert.equal(audit[3].reason, 'v2 over-weighted keywords');
    await assert.rejects(() => weights.retireWeightVersion(v1.id, A), /cannot be retired/);
    await weights.retireWeightVersion(v2.id, A);
    assert.equal(await db.matchWeightVersion.count({ where: { status: 'active' } }), 1);
  });

  it('tenants read their own dimension rows only and cannot see the weight register', async () => {
    const agent = await db.agent.create({ data: { userId: USER.id, name: `MW4 ${S}`, titles: JSON.stringify(['Data Analyst']), keywords: '[]', excludeKeywords: '[]', locations: JSON.stringify(['Toronto']), workMode: 'any', jobType: 'any', minMatchScore: 0, autoApplyThreshold: 101, status: 'active' } });
    try {
      await scanner.runAgentScan(USER.id, agent.id);
      const mine = await ctx.withTenant({ userId: USER.id }, (tx) => tx.matchDimension.findMany());
      assert.ok(mine.length >= 5, `dimension rows readable by their owner (${mine.length})`);
      assert.ok(mine.every((d) => d.userId === USER.id));
      assert.deepEqual(await ctx.withTenant({ userId: A.id }, (tx) => tx.matchDimension.findMany({ where: { userId: USER.id } })), []);
      assert.deepEqual(await ctx.withTenant({ userId: USER.id }, (tx) => tx.matchWeightVersion.findMany()), [], 'the register is system-only');
    } finally {
      await db.agent.delete({ where: { id: agent.id } });
    }
  });
});

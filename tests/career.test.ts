/**
 * Stage 16 (ADR-0031) - the learning graph and the career transition
 * service against PostgreSQL: the licence gate on loading, the loaded
 * graph with an unmatched NOC reported (never invented), the engine on the
 * tenant path with the entitlement deciding whether offerings are shown,
 * versioned plans with milestones and the analysis budget, the evidence
 * rule on a completed milestone, RLS ownership, the credential
 * counterfactual on real rows, and the purge a prohibition triggers.
 *
 * The occupations are created directly under the fixture dataset with
 * deliberately odd titles, so no posting in another suite can classify to
 * them while this suite runs; everything is removed afterwards.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { validateLearningGraph, type LearningGraphFile } from '../src/lib/career/loader';
import { profileIdFor } from '../src/lib/candidate/profile';
import type { CandidateEligibility, JobEligibilityFacts } from '../src/lib/eligibility/engine';

const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'learning-fixture.json'), 'utf8')) as LearningGraphFile;

describe('career - learning graph file validation (pure)', () => {
  it('accepts the fixture and refuses an unknown kind, an unknown provider, an unknown credential and a malformed NOC code', () => {
    assert.doesNotThrow(() => validateLearningGraph(FIXTURE));
    const clone = () => JSON.parse(JSON.stringify(FIXTURE)) as LearningGraphFile;
    let f = clone();
    f.credentials[0]!.kind = 'medal';
    assert.throws(() => validateLearningGraph(f), /unknown kind/);
    f = clone();
    f.offerings[0]!.provider = 'nobody';
    assert.throws(() => validateLearningGraph(f), /known provider/);
    f = clone();
    f.offerings[0]!.credential = 'nope';
    assert.throws(() => validateLearningGraph(f), /unknown credential/);
    f = clone();
    f.occupationCredentials[0]!.noc = '2121';
    assert.throws(() => validateLearningGraph(f), /NOC 2021/);
    f = clone();
    f.occupationSkills![0]!.importance = 9;
    assert.throws(() => validateLearningGraph(f), /importance is 1..5/);
    f = clone();
    f.credentials.push({ ...f.credentials[0]! });
    assert.throws(() => validateLearningGraph(f), /duplicate slug/);
  });
});

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Svc = typeof import('../src/lib/career/service');
type Loader = typeof import('../src/lib/career/loader');
type Datasets = typeof import('../src/lib/taxonomy/datasets');
type Ent = typeof import('../src/lib/entitlements/service');
type Ctx = typeof import('../src/lib/tenancy/context');

const S = randomBytes(4).toString('hex');
const U = { id: `car_u_${S}`, email: `car-${S}@car.test` };
const V = { id: `car_v_${S}`, email: `car-v-${S}@car.test` };
const STAFF = { id: `car_staff_${S}`, email: `car-staff-${S}@car.test`, fullName: 'Staff', role: 'admin' as const, storedRole: 'admin' };
const KEY = 'learning-fixture';
const CODES: Record<string, string> = { '21211': 'Fixture data scientists', '21223': 'Fixture database analysts', '21220': 'Fixture cybersecurity specialists', '11100': 'Fixture financial auditors' };
let db: Db;
let svc: Svc;
let loader: Loader;
let datasets: Datasets;
let ent: Ent;
let ctx: Ctx;
let datasetId = '';
const occ: Record<string, string> = {};

async function resetDataset() {
  const d = await db.taxonomyDataset.findUniqueOrThrow({ where: { key: KEY } });
  await db.occupationSkill.deleteMany({ where: { datasetId: d.id } });
  await db.occupationCredential.deleteMany({ where: { datasetId: d.id } });
  await db.learningOffering.deleteMany({ where: { datasetId: d.id } });
  await db.learningProvider.deleteMany({ where: { datasetId: d.id } });
  await db.credential.deleteMany({ where: { datasetId: d.id } });
  await db.occupation.deleteMany({ where: { datasetId: d.id } });
  await db.taxonomyDataset.update({ where: { key: KEY }, data: { licenceStatus: 'unrecorded', ingestionApproved: false, ingestedAt: null, rowCount: 0, licenceName: '', attribution: '' } });
  return d.id;
}

describe('career - graph, engine on the tenant path, plans, budget, RLS, counterfactual, purge', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    svc = await import('../src/lib/career/service');
    loader = await import('../src/lib/career/loader');
    datasets = await import('../src/lib/taxonomy/datasets');
    ent = await import('../src/lib/entitlements/service');
    ctx = await import('../src/lib/tenancy/context');
    await datasets.ensureDatasetRegistry();
    datasetId = await resetDataset();
    for (const u of [U, V]) {
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Career Tester', country: 'CA' } });
      await db.candidateProfile.create({ data: { id: profileIdFor(u.id), userId: u.id } });
    }
    // U holds SQL (by shared skill id) and data pipelines (by name only), no certifications
    const sql = await db.skill.upsert({ where: { normalizedName: 'sql' }, create: { name: 'SQL', normalizedName: 'sql' }, update: {} });
    await db.candidateSkill.create({ data: { profileId: profileIdFor(U.id), userId: U.id, name: 'SQL', normalizedName: 'sql', skillId: sql.id } });
    await db.candidateSkill.create({ data: { profileId: profileIdFor(U.id), userId: U.id, name: 'Data pipelines', normalizedName: 'data pipelines' } });
    // U is entitled to two analyses and to learning recommendations; V to nothing
    await ent.grantEntitlement(db, { subject: { userId: U.id }, capability: 'career_transition_per_month', quantity: 2, source: 'comp', sourceRef: `car-${S}`, grantedBy: 'staff:test' });
    await ent.grantEntitlement(db, { subject: { userId: U.id }, capability: 'learning_recommendations', source: 'comp', sourceRef: `car-${S}`, grantedBy: 'staff:test' });
    // occupations with the fixture's NOC codes, odd titles, under the learning-fixture dataset
    for (const [code, title] of Object.entries(CODES)) {
      const o = await db.occupation.create({ data: { slug: `car-${S}-${code}`, level: 'unit_group', datasetId, labels: { create: { locale: 'en', title, normalizedTitle: title.toLowerCase() } }, codes: { create: { scheme: 'NOC2021', version: '1.0', code, teer: Number(code[1]) } } } });
      occ[code] = o.id;
    }
    await db.careerPath.create({ data: { fromOccupationId: occ['21223']!, toOccupationId: occ['21220']!, kind: 'lateral', source: 'fixture' } });
    await db.careerPath.create({ data: { fromOccupationId: occ['21220']!, toOccupationId: occ['21211']!, kind: 'progression', source: 'fixture' } });
  });
  after(async () => {
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: [U.id, V.id, STAFF.id] } }, { entityType: 'Entitlement', actorType: 'system' }] } });
    await db.user.deleteMany({ where: { id: { in: [U.id, V.id] } } });
    await resetDataset();
    await db.$disconnect();
  });

  const tenant = <T,>(userId: string, fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId }, fn);

  it('refuses to load the graph until the licence is recorded AND ingestion approved', async () => {
    await assert.rejects(() => loader.loadLearningGraph(FIXTURE, KEY), /licence has not been recorded/);
    await datasets.recordDatasetLicence(KEY, { licenceName: 'Fixture', attribution: 'Fixture attribution (Stage 16)', status: 'recorded', ingestionApproved: false }, STAFF, 'Test: recorded, not approved');
    await assert.rejects(() => loader.loadLearningGraph(FIXTURE, KEY), /recorded and approved/);
    assert.equal(await db.credential.count({ where: { datasetId } }), 0);
  });

  it('loads under a recorded licence: every row carries the dataset, an unknown NOC is reported and not loaded, a second load is idempotent', async () => {
    await datasets.recordDatasetLicence(KEY, { licenceName: 'Fixture', attribution: 'Fixture attribution (Stage 16)', status: 'recorded', ingestionApproved: true }, STAFF, 'Test: approved');
    const report = await loader.loadLearningGraph(FIXTURE, KEY);
    assert.equal(report.credentials, 4);
    assert.equal(report.providers, 2);
    assert.equal(report.offerings, 5);
    assert.equal(report.occupationCredentials, 4, 'the row for NOC 99999 was not loaded');
    assert.deepEqual(report.unmatchedNoc, ['99999']);
    assert.equal(report.occupationSkills, 14);
    assert.equal(await db.occupationCredential.count({ where: { datasetId } }), 4);
    assert.ok((await db.learningOffering.findMany({ where: { datasetId } })).every((o) => o.datasetId === datasetId));
    const again = await loader.loadLearningGraph(FIXTURE, KEY);
    assert.equal(again.skillsCreated, 0);
    assert.equal(await db.credential.count({ where: { datasetId } }), 4);
    assert.equal(await db.learningOffering.count({ where: { datasetId } }), 5);
    const d = await db.taxonomyDataset.findUniqueOrThrow({ where: { key: KEY } });
    assert.ok(d.ingestedAt);
  });

  it('analyses on the tenant path: transfers, gaps by kind with provenance, a pathway of licensed offerings for the entitled, the pathway locked for the unentitled', async () => {
    const r = await tenant(U.id, (tx) => svc.analyseFor(tx, U.id, { targetOccupationId: occ['21211']!, currentOccupationId: occ['21223']! }));
    assert.equal(r.offeringsShown, true);
    assert.deepEqual(r.analysis.transferable.map((s) => s.normalizedName).sort(), ['data pipelines', 'sql']);
    assert.deepEqual(r.analysis.gaps.skills.map((s) => s.name.toLowerCase()), ['python', 'machine learning', 'statistics', 'data visualization'], 'importance desc, then name; a shared Skill row keeps whichever casing it was created with');
    assert.deepEqual(r.analysis.gaps.credentials.map((c) => c.name).sort(), ['AWS Certified Data Analytics - Specialty', 'Master of Science in Data Science'].sort());
    assert.ok(r.analysis.gaps.credentials.every((c) => c.recognition === 'vendor' || c.recognition === 'unverified'), 'recognition is what the file states');
    assert.ok(r.analysis.pathway.some((p) => p.offeringId !== null), 'offerings appear for the entitled');
    assert.ok(r.analysis.pathway.every((p) => p.kind === 'experience' || p.offeringId === null || p.provenance?.datasetKey === KEY));
    assert.ok(r.analysis.provenance.some((p) => p.attribution === 'Fixture attribution (Stage 16)'));
    // the bridge 21223 -> 21220 -> 21211 the dataset records
    assert.deepEqual(r.analysis.bridges.map((b) => b.occupationId), [occ['21220']]);
    assert.equal(r.analysis.market.postingsOpen, 0);
    // V: the gaps are complete, the offerings are withheld and the reason stated
    const v = await tenant(V.id, (tx) => svc.analyseFor(tx, V.id, { targetOccupationId: occ['21211']! }));
    assert.equal(v.offeringsShown, false);
    assert.match(v.offeringsNote ?? '', /not included in your plan/);
    assert.equal(v.analysis.gaps.skills.length, 6);
    assert.ok(v.analysis.pathway.every((p) => p.offeringId === null));
    await assert.rejects(() => tenant(V.id, (tx) => svc.analyseFor(tx, V.id, { targetOccupationId: 'nope' })), (e: Error & { status: number }) => e.status === 404);
  });

  it('a plan is versioned: create counts against the budget, refresh supersedes and carries done milestones, the budget refuses at the limit, the unentitled are refused at zero', async () => {
    await assert.rejects(() => tenant(V.id, (tx) => svc.createCareerPlan(tx, V.id, { targetOccupationId: occ['21211']! })), (e: Error & { status: number }) => e.status === 403 && /not included/.test(e.message));
    const b0 = await tenant(U.id, (tx) => svc.analysisBudget(tx, U.id));
    assert.deepEqual(b0, { limit: 2, used: 0, remaining: 2, unlimited: false });
    const p1 = await tenant(U.id, (tx) => svc.createCareerPlan(tx, U.id, { targetOccupationId: occ['21211']!, currentOccupationId: occ['21223']! }));
    assert.equal(p1.version, 1);
    const view = (await tenant(U.id, (tx) => svc.loadPlan(tx, U.id, p1.id)))!;
    assert.ok(view.milestones.length >= 3);
    assert.ok(view.milestones.some((m) => m.kind === 'credential'));
    assert.ok(view.milestones.some((m) => m.kind === 'experience' && m.occupationId === occ['21220']));
    assert.equal((await tenant(U.id, (tx) => svc.analysisBudget(tx, U.id))).used, 1);
    // complete one milestone, then refresh: a NEW version, the old archived, the done one carried by title
    const first = view.milestones[0]!;
    await tenant(U.id, (tx) => svc.updateMilestone(tx, U.id, first.id, { status: 'done' }));
    const p2 = await tenant(U.id, (tx) => svc.refreshCareerPlan(tx, U.id, p1.id));
    assert.equal(p2.version, 2);
    assert.equal(p2.supersedesId, p1.id);
    assert.equal((await db.careerPlan.findUniqueOrThrow({ where: { id: p1.id } })).status, 'archived');
    const v2 = (await tenant(U.id, (tx) => svc.loadPlan(tx, U.id, p2.id)))!;
    assert.equal(v2.milestones.find((m) => m.title === first.title)?.status, 'done');
    assert.equal((await tenant(U.id, (tx) => svc.analysisBudget(tx, U.id))).used, 1, 'a refresh is not a new analysis for the budget');
    await assert.rejects(() => tenant(U.id, (tx) => svc.refreshCareerPlan(tx, U.id, p1.id)), (e: Error & { status: number }) => e.status === 409);
    // second new plan fine, third refused
    const p3 = await tenant(U.id, (tx) => svc.createCareerPlan(tx, U.id, { targetOccupationId: occ['21220']!, title: 'Security' }));
    assert.equal(p3.title, 'Security');
    await assert.rejects(() => tenant(U.id, (tx) => svc.createCareerPlan(tx, U.id, { targetOccupationId: occ['11100']! })), (e: Error & { status: number }) => e.status === 403 && /used the 2 career analyses/.test(e.message));
    const list = await tenant(U.id, (tx) => svc.listPlans(tx, U.id));
    assert.deepEqual(list.map((p) => p.id).sort(), [p2.id, p3.id].sort(), 'archived versions are not listed');
    assert.equal(await tenant(U.id, (tx) => svc.archiveCareerPlan(tx, U.id, p3.id)), true);
    assert.equal(await tenant(U.id, (tx) => svc.archiveCareerPlan(tx, U.id, p3.id)), false);
  });

  it("a completed milestone may cite the person's own APPROVED evidence and nothing else; another tenant sees and touches none of it (RLS)", async () => {
    const plan = (await tenant(U.id, (tx) => svc.listPlans(tx, U.id)))[0]!;
    const view = (await tenant(U.id, (tx) => svc.loadPlan(tx, U.id, plan.id)))!;
    const m = view.milestones.find((x) => x.status !== 'done')!;
    const draft = await db.careerEvidence.create({ data: { userId: U.id, kind: 'skill', sourceType: 'manual', claim: 'Completed the Python course', status: 'draft' } });
    await assert.rejects(() => tenant(U.id, (tx) => svc.updateMilestone(tx, U.id, m.id, { status: 'done', evidenceId: draft.id })), (e: Error & { status: number }) => e.status === 422);
    const approved = await db.careerEvidence.create({ data: { userId: U.id, kind: 'skill', sourceType: 'manual', claim: 'Completed the Python course', status: 'approved', approvedAt: new Date() } });
    const done = await tenant(U.id, (tx) => svc.updateMilestone(tx, U.id, m.id, { status: 'done', evidenceId: approved.id }));
    assert.equal(done.evidenceId, approved.id);
    assert.ok(done.completedAt);
    const theirs = await db.careerEvidence.create({ data: { userId: V.id, kind: 'skill', sourceType: 'manual', claim: 'Theirs', status: 'approved', approvedAt: new Date() } });
    await assert.rejects(() => tenant(U.id, (tx) => svc.updateMilestone(tx, U.id, m.id, { status: 'done', evidenceId: theirs.id })), (e: Error & { status: number }) => e.status === 422, "another person's evidence is not visible, so not citable");
    // RLS: V sees nothing of U's plans and cannot move U's milestone
    assert.equal(await tenant(V.id, (tx) => tx.careerPlan.count({ where: { userId: U.id } })), 0);
    assert.equal(await tenant(V.id, (tx) => tx.careerPlanMilestone.count({ where: { userId: U.id } })), 0);
    assert.equal(await tenant(V.id, (tx) => svc.loadPlan(tx, V.id, plan.id)), null);
    await assert.rejects(() => tenant(V.id, (tx) => svc.updateMilestone(tx, V.id, m.id, { status: 'dropped' })), (e: Error & { status: number }) => e.status === 404);
    assert.equal((await db.careerPlanMilestone.findUniqueOrThrow({ where: { id: m.id } })).status, 'done');
    // reference rows are readable by every tenant
    assert.equal(await tenant(V.id, (tx) => tx.credential.count({ where: { datasetId } })), 4);
    assert.equal(await tenant(V.id, (tx) => tx.learningOffering.count({ where: { datasetId } })), 5);
  });

  it('the counterfactual on real rows: holding the regulated CPA turns an ineligible verdict eligible on exactly the licensure rule; an unknown credential is 404', async () => {
    const cpa = await db.credential.findUniqueOrThrow({ where: { slug: 'cpa-ca' } });
    const candidate: CandidateEligibility = { workAuth: { country: 'CA', status: 'citizen', permitExpiresAt: null, sponsorshipNeeded: false }, preferences: { countries: ['CA'], locations: [], relocation: 'open' }, certifications: [], languages: [{ language: 'en', proficiency: 'native' }] };
    const job: JobEligibilityFacts = { title: 'CPA - Senior Accountant', normalizedTitle: 'cpa senior accountant', read: true, country: 'CA', location: 'Toronto, ON', postalRegion: 'CA-ON/toronto', workMode: 'onsite', workAuthorization: null, sponsorship: 'unknown', certificationRequirements: ['CPA'], languageRequirements: [] };
    const r = await tenant(U.id, (tx) => svc.credentialWhatIf(tx, cpa.id, candidate, job, new Date('2026-09-05')));
    assert.equal(r.outcomeBefore, 'ineligible');
    assert.equal(r.outcomeAfter, 'eligible');
    assert.equal(r.materiallyChanged, true);
    assert.deepEqual(r.changes.map((c) => [c.rule, c.from, c.to]), [['licensure', 'fail', 'pass']]);
    assert.equal(r.recognition, 'regulated');
    assert.equal(r.provenance?.attribution, 'Fixture attribution (Stage 16)');
    await assert.rejects(() => tenant(U.id, (tx) => svc.credentialWhatIf(tx, 'nope', candidate, job)), (e: Error & { status: number }) => e.status === 404);
  });

  it('a prohibition purges the graph the dataset loaded and the plans keep their stored analysis with the offering links detached', async () => {
    const plans = await db.careerPlan.findMany({ where: { userId: U.id } });
    assert.ok(plans.length >= 2);
    const linked = await db.careerPlanMilestone.count({ where: { userId: U.id, offeringId: { not: null } } });
    assert.ok(linked > 0);
    await datasets.recordDatasetLicence(KEY, { licenceName: '', attribution: '', status: 'prohibited', ingestionApproved: true }, STAFF, 'Test: counsel says no');
    assert.equal(await db.credential.count({ where: { datasetId } }), 0);
    assert.equal(await db.learningProvider.count({ where: { datasetId } }), 0);
    assert.equal(await db.learningOffering.count({ where: { datasetId } }), 0);
    assert.equal(await db.occupationCredential.count({ where: { datasetId } }), 0);
    assert.equal(await db.careerPlan.count({ where: { userId: U.id } }), plans.length, 'the person keeps their plans');
    assert.equal(await db.careerPlanMilestone.count({ where: { userId: U.id, offeringId: { not: null } } }), 0, 'the purged offerings are no longer cited');
    // the Stage 04 rule: a prohibited dataset's occupations go with it, so the target is gone too
    assert.equal(await db.occupation.count({ where: { datasetId } }), 0);
    await assert.rejects(() => tenant(U.id, (tx) => svc.analyseFor(tx, U.id, { targetOccupationId: occ['21211']! })), (e: Error & { status: number }) => e.status === 404);
    const kept = (await tenant(U.id, (tx) => svc.loadPlan(tx, U.id, plans.find((p) => p.status !== 'archived')!.id)))!;
    assert.ok(kept.analysis.pathway.length > 0, 'the stored analysis is the record of what was computed; it is not rewritten');
  });
});

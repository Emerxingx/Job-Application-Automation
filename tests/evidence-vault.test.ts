/**
 * Stage 03 — the Career Evidence Vault against the migrated PostgreSQL.
 *
 * Proves: derivation from the structured profile (idempotent; edits supersede,
 * removals revoke), the draft → approved lifecycle, revision as a new version,
 * immutability of approved rows enforced BY THE DATABASE (trigger) as well as
 * by the service, what generation receives, and that another tenant sees
 * nothing on the tenant path with no application filter.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Vault = typeof import('../src/lib/evidence/vault');
type Ctx = typeof import('../src/lib/tenancy/context');

const S = randomBytes(4).toString('hex');
const A = { id: `ev_a_${S}`, email: `ev-a-${S}@vault.test` };
const B = { id: `ev_b_${S}`, email: `ev-b-${S}@vault.test` };
let db: Db;
let vault: Vault;
let ctx: Ctx;

describe('Stage 03 — evidence vault', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    vault = await import('../src/lib/evidence/vault');
    ctx = await import('../src/lib/tenancy/context');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Vault' } });
    const profileId = `cp_${A.id}`;
    await db.candidateProfile.create({ data: { id: profileId, userId: A.id, headline: 'Senior Data Analyst', summary: 'Six years.' } });
    const own = { profileId, userId: A.id };
    await db.employmentHistory.createMany({
      data: [
        { ...own, company: 'Northbridge Commerce', title: 'Senior Data Analyst', startDate: '2022-03', isCurrent: true, bullets: JSON.stringify(['Cut refresh time by 40%', 'Led migration of 12 dashboards to Snowflake']), sortOrder: 0 },
        { ...own, company: 'Halcyon Retail', title: 'Data Analyst', startDate: '2020-01', endDate: '2022-02', bullets: '[]', sortOrder: 1 },
      ],
    });
    await db.education.create({ data: { ...own, institution: 'University of Toronto', credential: 'Honours BSc', fieldOfStudy: 'Statistics', endYear: 2018 } });
    await db.candidateSkill.createMany({ data: [{ ...own, name: 'SQL', normalizedName: 'sql' }, { ...own, name: 'Python', normalizedName: 'python' }] });
    await db.certification.create({ data: { ...own, name: 'Tableau Desktop Specialist', issuer: 'Tableau' } });
    await db.project.create({ data: { ...own, name: 'Rental tracker', description: 'Scraped listings', technologies: '["Python"]' } });
    await db.achievement.create({ data: { ...own, title: 'Cut reporting cost', metric: '30%', occurredAt: '2023-06' } });
    await db.candidateLanguage.create({ data: { ...own, language: 'fr', proficiency: 'professional' } });
  });
  after(async () => {
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.$disconnect();
  });

  const asA = <T,>(fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId: A.id }, fn);

  it('derives one approved claim per profile fact, idempotently', async () => {
    const first = await asA((tx) => vault.syncEvidenceFromProfile(tx, A.id));
    // 2 roles + 2 bullets + 1 achievement + 1 education + 1 certification + 1 project + 2 skills + 1 language
    assert.deepEqual(first, { created: 11, superseded: 0, revoked: 0, unchanged: 0 });
    const second = await asA((tx) => vault.syncEvidenceFromProfile(tx, A.id));
    assert.deepEqual(second, { created: 0, superseded: 0, revoked: 0, unchanged: 11 });
    const approved = await asA((tx) => vault.listEvidence(tx, A.id, 'approved'));
    assert.equal(approved.length, 11);
    assert.ok(approved.every((e) => e.approvedAt !== null && e.version === 1));
    assert.ok(approved.some((e) => e.claim === 'Senior Data Analyst at Northbridge Commerce, 2022-03 to present'));
    assert.ok(approved.some((e) => e.claim === 'Honours BSc in Statistics, University of Toronto, 2018'));
  });

  it('a changed fact supersedes; a removed fact revokes; the rest is untouched', async () => {
    // End the current role (same natural key → superseded) and drop a skill (→ revoked).
    const role = await db.employmentHistory.findFirstOrThrow({ where: { userId: A.id, company: 'Northbridge Commerce' } });
    await db.employmentHistory.update({ where: { id: role.id }, data: { isCurrent: false, endDate: '2026-08' } });
    await db.candidateSkill.deleteMany({ where: { userId: A.id, normalizedName: 'python' } });

    const report = await asA((tx) => vault.syncEvidenceFromProfile(tx, A.id));
    assert.deepEqual(report, { created: 0, superseded: 1, revoked: 1, unchanged: 9 });
    const all = await asA((tx) => vault.listEvidence(tx, A.id));
    const v2 = all.find((e) => e.claim === 'Senior Data Analyst at Northbridge Commerce, 2022-03 to 2026-08');
    assert.ok(v2 && v2.version === 2 && v2.status === 'approved' && v2.supersedesId);
    const v1 = all.find((e) => e.id === v2!.supersedesId);
    assert.equal(v1?.status, 'superseded');
    assert.equal(all.find((e) => e.claim.startsWith('Skill: Python'))?.status, 'revoked');
  });

  it('manual evidence starts as a draft, grounds nothing until approved, and is approved by the candidate', async () => {
    const draft = await asA((tx) => vault.addManualEvidence(tx, A.id, { kind: 'achievement', claim: 'Presented at the Toronto Data Summit 2024', facts: { year: 2024 } }));
    assert.equal(draft.status, 'draft');
    let bundle = await asA((tx) => vault.loadEvidenceForGeneration(tx, A.id));
    assert.equal(bundle.ids.includes(draft.id), false);
    const approved = await asA((tx) => vault.approveEvidence(tx, A.id, draft.id));
    assert.equal(approved.status, 'approved');
    bundle = await asA((tx) => vault.loadEvidenceForGeneration(tx, A.id));
    assert.ok(bundle.ids.includes(draft.id));
    assert.ok(bundle.claims.some((c) => c.startsWith('Presented at the Toronto Data Summit 2024') && c.includes('2024')));
    await assert.rejects(() => asA((tx) => vault.approveEvidence(tx, A.id, draft.id)), /Only a draft can be approved/);
  });

  it('approved evidence is immutable: the service refuses in place and revises as a new version; the database trigger refuses any direct edit', async () => {
    const approved = (await asA((tx) => vault.listEvidence(tx, A.id, 'approved'))).find((e) => e.sourceType === 'manual')!;
    // Service: a revision is a NEW draft version, the original untouched.
    const revision = await asA((tx) => vault.reviseEvidence(tx, A.id, approved.id, { claim: 'Presented at the Toronto Data Summit 2024 (keynote)' }));
    assert.equal(revision.status, 'draft');
    assert.equal(revision.version, approved.version + 1);
    assert.equal(revision.supersedesId, approved.id);
    assert.equal((await db.careerEvidence.findUniqueOrThrow({ where: { id: approved.id } })).claim, approved.claim);
    // Database: even the system client cannot rewrite an approved claim.
    await assert.rejects(
      () => db.careerEvidence.update({ where: { id: approved.id }, data: { claim: 'Something else' } }),
      /immutable/,
    );
    await assert.rejects(
      () => db.careerEvidence.update({ where: { id: approved.id }, data: { status: 'draft' } }),
      /cannot move from approved/,
    );
    // Approving the revision supersedes the original.
    await asA((tx) => vault.approveEvidence(tx, A.id, revision.id));
    assert.equal((await db.careerEvidence.findUniqueOrThrow({ where: { id: approved.id } })).status, 'superseded');
    await assert.rejects(
      () => db.careerEvidence.update({ where: { id: approved.id }, data: { status: 'approved' } }),
      /cannot change status/,
    );
  });

  it('revoked evidence never grounds a generation again', async () => {
    const live = (await asA((tx) => vault.listEvidence(tx, A.id, 'approved'))).find((e) => e.sourceType === 'manual')!;
    await asA((tx) => vault.revokeEvidence(tx, A.id, live.id));
    const bundle = await asA((tx) => vault.loadEvidenceForGeneration(tx, A.id));
    assert.equal(bundle.ids.includes(live.id), false);
  });

  it('another tenant sees none of it, with no application filter', async () => {
    const rows = await ctx.withTenant({ userId: B.id }, (tx) => tx.careerEvidence.findMany());
    assert.deepEqual(rows, []);
    const questions = await ctx.withTenant({ userId: B.id }, (tx) => tx.applicationQuestion.findMany());
    assert.deepEqual(questions, []);
    // And cannot approve, revise or revoke A's draft by id.
    const draft = await asA((tx) => vault.addManualEvidence(tx, A.id, { kind: 'skill', claim: 'Skill: dbt' }));
    await assert.rejects(() => ctx.withTenant({ userId: B.id }, (tx) => vault.approveEvidence(tx, B.id, draft.id)), /not found/);
    await assert.rejects(() => ctx.withTenant({ userId: B.id }, (tx) => vault.revokeEvidence(tx, B.id, draft.id)), /not found/);
    assert.equal((await db.careerEvidence.findUniqueOrThrow({ where: { id: draft.id } })).status, 'draft');
  });
});

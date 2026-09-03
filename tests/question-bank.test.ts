/**
 * Stage 03 — the application question bank: classification, policy floors
 * (pure), and the stored form against the migrated PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { classifyQuestion, enforcePolicy, questionKey, resolveAutomation } from '../src/lib/evidence/questions';

describe('question bank — classification and policy floors (pure)', () => {
  it('sensitive questions are pinned to NEVER_AUTOMATE whatever is requested', () => {
    for (const q of [
      'What is your gender?',
      'Do you identify as a person with a disability?',
      'Are you a veteran?',
      'Do you have a criminal record?',
      'What is your date of birth?',
      'Are you an Indigenous person (First Nations, Métis or Inuit)?',
      'Please provide your SIN',
      'What is your citizenship?',
    ]) {
      const c = classifyQuestion(q);
      assert.equal(c.category, 'sensitive', q);
      assert.equal(c.riskLevel, 'high');
      assert.equal(enforcePolicy(c.category, 'AUTO_FILL'), 'NEVER_AUTOMATE', q);
      assert.equal(enforcePolicy(c.category, null), 'NEVER_AUTOMATE');
    }
  });
  it('eligibility and compensation cannot drop below REQUIRE_REVIEW; logistics may be AUTO_FILL', () => {
    assert.equal(classifyQuestion('Are you legally authorized to work in Canada?').category, 'eligibility');
    assert.equal(enforcePolicy('eligibility', 'AUTO_FILL'), 'REQUIRE_REVIEW');
    assert.equal(enforcePolicy('eligibility', 'NEVER_AUTOMATE'), 'NEVER_AUTOMATE');
    assert.equal(classifyQuestion('What are your salary expectations?').category, 'compensation');
    assert.equal(enforcePolicy('compensation', 'ASK_IF_CHANGED'), 'REQUIRE_REVIEW');
    assert.equal(classifyQuestion('What is your LinkedIn profile URL?').category, 'logistics');
    assert.equal(enforcePolicy('logistics', 'AUTO_FILL'), 'AUTO_FILL');
    assert.equal(classifyQuestion('How many years of experience do you have with SQL?').category, 'experience');
    assert.equal(enforcePolicy('experience', 'AUTO_FILL'), 'ASK_IF_CHANGED');
    assert.equal(classifyQuestion('Why do you want to work here?').category, 'motivation');
    assert.equal(classifyQuestion('Describe a time you handled conflict.').category, 'screening');
    assert.equal(classifyQuestion('Favourite colour').category, 'other');
    assert.equal(enforcePolicy('other', 'AUTO_FILL'), 'REQUIRE_REVIEW');
  });
  it('a sensitive term anywhere wins over an eligibility term', () => {
    assert.equal(classifyQuestion('Do you require a visa, and do you have a disability we should accommodate?').category, 'sensitive');
  });
  it('the key ignores case, punctuation and spacing', () => {
    assert.equal(questionKey('  Are you authorized to WORK in Canada?! '), questionKey('are you authorized to work in canada'));
    assert.equal(questionKey('a'.repeat(300)).length, 200);
  });
  it('resolveAutomation follows the policy and the confirmation bookkeeping', () => {
    const t0 = new Date('2026-01-01');
    const t1 = new Date('2026-02-01');
    assert.equal(resolveAutomation({ policy: 'NEVER_AUTOMATE', answer: 'x', lastConfirmedAt: t1, answerUpdatedAt: t0 }), 'never');
    assert.equal(resolveAutomation({ policy: 'AUTO_FILL', answer: '', lastConfirmedAt: null, answerUpdatedAt: null }), 'review');
    assert.equal(resolveAutomation({ policy: 'AUTO_FILL', answer: 'x', lastConfirmedAt: null, answerUpdatedAt: t0 }), 'fill');
    assert.equal(resolveAutomation({ policy: 'ASK_IF_CHANGED', answer: 'x', lastConfirmedAt: null, answerUpdatedAt: t0 }), 'ask');
    assert.equal(resolveAutomation({ policy: 'ASK_IF_CHANGED', answer: 'x', lastConfirmedAt: t1, answerUpdatedAt: t0 }), 'fill');
    assert.equal(resolveAutomation({ policy: 'ASK_IF_CHANGED', answer: 'x', lastConfirmedAt: t0, answerUpdatedAt: t1 }), 'ask');
    assert.equal(resolveAutomation({ policy: 'REQUIRE_REVIEW', answer: 'x', lastConfirmedAt: t1, answerUpdatedAt: t0 }), 'review');
  });
});

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Q = typeof import('../src/lib/evidence/questions');
type Vault = typeof import('../src/lib/evidence/vault');
type Ctx = typeof import('../src/lib/tenancy/context');
const S = randomBytes(4).toString('hex');
const A = { id: `qb_a_${S}`, email: `qb-a-${S}@qb.test` };
const B = { id: `qb_b_${S}`, email: `qb-b-${S}@qb.test` };
let db: Db;
let questions: Q;
let vault: Vault;
let ctx: Ctx;

describe('question bank — stored form', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    questions = await import('../src/lib/evidence/questions');
    vault = await import('../src/lib/evidence/vault');
    ctx = await import('../src/lib/tenancy/context');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'QB' } });
  });
  after(async () => {
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.$disconnect();
  });
  const asA = <T,>(fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId: A.id }, fn);

  it('a sensitive question is stored NEVER_AUTOMATE with no evidence link, even when AUTO_FILL and evidence are requested', async () => {
    const ev = await asA(async (tx) => vault.approveEvidence(tx, A.id, (await vault.addManualEvidence(tx, A.id, { kind: 'skill', claim: 'Skill: French' })).id));
    const q = await asA((tx) => questions.upsertQuestion(tx, A.id, { question: 'Do you have a disability?', answer: 'Prefer not to say', policy: 'AUTO_FILL', evidenceIds: [ev.id] }));
    assert.equal(q.category, 'sensitive');
    assert.equal(q.policy, 'NEVER_AUTOMATE');
    assert.equal(q.evidenceIds, '[]');
    assert.equal(questions.resolveAutomation(q), 'never');
  });
  it('the same question in different words updates one row; a requested policy below the floor is raised', async () => {
    const first = await asA((tx) => questions.upsertQuestion(tx, A.id, { question: 'Are you authorized to work in Canada?', answer: 'Yes', policy: 'AUTO_FILL' }));
    assert.equal(first.policy, 'REQUIRE_REVIEW');
    const second = await asA((tx) => questions.upsertQuestion(tx, A.id, { question: '  are you AUTHORIZED to work in canada ', answer: 'Yes, citizen', policy: 'NEVER_AUTOMATE' }));
    assert.equal(second.id, first.id);
    assert.equal(second.policy, 'NEVER_AUTOMATE');
    assert.equal(second.answer, 'Yes, citizen');
    assert.equal((await asA((tx) => questions.listQuestions(tx, A.id))).length, 2);
  });
  it('evidence links must be the candidate\'s own approved evidence', async () => {
    const draft = await asA((tx) => vault.addManualEvidence(tx, A.id, { kind: 'skill', claim: 'Skill: Looker' }));
    await assert.rejects(
      () => asA((tx) => questions.upsertQuestion(tx, A.id, { question: 'How many years of Looker experience?', answer: '2', evidenceIds: [draft.id] })),
      /approved evidence/,
    );
    const approvedB = await ctx.withTenant({ userId: B.id }, async (tx) => vault.approveEvidence(tx, B.id, (await vault.addManualEvidence(tx, B.id, { kind: 'skill', claim: 'Skill: dbt' })).id));
    await assert.rejects(
      () => asA((tx) => questions.upsertQuestion(tx, A.id, { question: 'How many years of dbt experience?', answer: '2', evidenceIds: [approvedB.id] })),
      /approved evidence/,
    );
  });
  it('confirming records the bookkeeping ASK_IF_CHANGED relies on', async () => {
    const q = await asA((tx) => questions.upsertQuestion(tx, A.id, { question: 'When could you start?', answer: 'Two weeks', policy: 'ASK_IF_CHANGED' }));
    assert.equal(questions.resolveAutomation(q), 'ask');
    const confirmed = await asA((tx) => questions.confirmAnswer(tx, A.id, q.id));
    assert.equal(questions.resolveAutomation(confirmed), 'fill');
    await assert.rejects(() => ctx.withTenant({ userId: B.id }, (tx) => questions.confirmAnswer(tx, B.id, q.id)), /not found/);
  });
});

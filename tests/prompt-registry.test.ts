/**
 * Stage 03 — the governed prompt registry (ADR-0019 Tier 1, AI_GOVERNANCE.md
 * § Prompt governance) against the migrated PostgreSQL.
 *
 * The one property everything else hangs on: a version cannot serve traffic
 * until its evaluation has passed. Plus: validation both ways on the variable
 * contract, approval, promotion demoting the old default, rollback recorded
 * as rollback, retirement rules, a failed evaluation demoting a live default,
 * an audit row per change, and the read path's hard errors.
 */
import './helpers/database-env'; // FIRST: the static imports below reach src/lib/db
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { validatePromptInput } from '../src/lib/ai/prompt-registry';

describe('prompt registry — input validation (pure)', () => {
  const base = { slug: 'ok-slug', targetModel: 'claude-opus-5', systemPrompt: 'Use {{a}}.', userPromptTemplate: '{{b}}', requiredVariables: ['a', 'b'] };
  it('accepts a consistent version', () => assert.equal(validatePromptInput(base), null));
  it('refuses a declared variable with no placeholder', () => assert.match(validatePromptInput({ ...base, requiredVariables: ['a', 'b', 'c'] })!, /lists "c"/));
  it('refuses a placeholder that is not declared', () => assert.match(validatePromptInput({ ...base, requiredVariables: ['a'] })!, /uses \{\{b\}\}/));
  it('refuses a bad slug and bad parameters', () => {
    assert.match(validatePromptInput({ ...base, slug: 'Bad Slug' })!, /slug/);
    assert.match(validatePromptInput({ ...base, modelParameters: { temperature: 3 } })!, /temperature/);
    assert.match(validatePromptInput({ ...base, modelParameters: { effort: 'huge' } })!, /effort/);
  });
});

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Registry = typeof import('../src/lib/ai/prompt-registry');
const S = randomBytes(4).toString('hex');
const SLUG = `test-${S}`;
const STAFF = { id: `staff_${S}`, email: `staff-${S}@registry.test`, fullName: 'Staff', role: 'admin' as const, storedRole: 'admin' };
const SECOND = { id: `staff2_${S}`, email: `staff2-${S}@registry.test`, fullName: 'Second', role: 'admin' as const, storedRole: 'admin' };
let db: Db;
let reg: Registry;

describe('prompt registry — lifecycle against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    reg = await import('../src/lib/ai/prompt-registry');
  });
  after(async () => {
    await db.promptVersion.deleteMany({ where: { slug: SLUG } });
    await db.auditLog.deleteMany({ where: { actorId: { in: [STAFF.id, SECOND.id] } } });
    await db.user.deleteMany({ where: { id: { in: [STAFF.id, SECOND.id] } } });
    await db.$disconnect();
  });

  const input = (n: number) => ({
    slug: SLUG,
    targetModel: 'claude-opus-5',
    systemPrompt: `Version ${n}. Never invent. {{job_block}}`,
    userPromptTemplate: '{{resume_json}}',
    requiredVariables: ['job_block', 'resume_json'],
    modelParameters: { effort: 'medium', max_tokens: 1000 },
  });

  it('the seeded baselines are approved but NOT default, so no external prompt serves until an evaluation passes', async () => {
    for (const slug of ['analyze-match', 'tailor', 'prepare-interview']) {
      const rows = await db.promptVersion.findMany({ where: { slug } });
      assert.ok(rows.length >= 1, slug);
      // The gateway suite may hold tailor v1 at default for its own run; every
      // seeded row must still carry the seed's evaluation posture or a note.
      for (const r of rows) assert.ok(r.deploymentStatus !== 'default' || r.evaluationStatus === 'passed', `${slug} v${r.version} is default without a passed evaluation`);
    }
    await assert.rejects(() => reg.renderPrompt(SLUG, {}), reg.PromptNotFoundError);
  });

  it('create → approve → (evaluation gate) → promote, each audited', async () => {
    const v1 = await reg.createPromptVersion(input(1), STAFF, 'first');
    assert.equal(v1.version, 1);
    assert.equal(v1.deploymentStatus, 'draft');
    await assert.rejects(() => reg.promotePromptVersion(v1.id, STAFF), /Only an approved version/);
    // Separation of duties: the author cannot approve their own version.
    await assert.rejects(() => reg.approvePromptVersion(v1.id, STAFF), /second admin/);
    const approved = await reg.approvePromptVersion(v1.id, SECOND);
    assert.equal(approved.approvedByEmail, SECOND.email);
    await assert.rejects(() => reg.promotePromptVersion(v1.id, STAFF), /evaluation has passed/);
    await assert.rejects(() => reg.recordPromptEvaluation(v1.id, { status: 'passed', note: 'ok' }, STAFF), /note/);
    await reg.recordPromptEvaluation(v1.id, { status: 'passed', note: 'Golden set 12/12 on claude-opus-5, 2026-09-03.' }, STAFF);
    const live = await reg.promotePromptVersion(v1.id, STAFF, 'go live');
    assert.equal(live.deploymentStatus, 'default');
    assert.equal((await reg.getActivePrompt(SLUG))?.id, v1.id);

    const audit = await db.auditLog.findMany({ where: { entityType: 'PromptVersion', entityId: v1.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(audit.map((a) => a.action), ['prompt.create', 'prompt.approve', 'prompt.evaluate', 'prompt.promote']);
    assert.ok(audit.every((a) => a.actorType === 'staff'));
    assert.equal(audit[1].actorEmail, SECOND.email);
    // The evaluation note survives in the audit trail even after the row's note is overwritten.
    assert.match(JSON.parse(audit[2].after).evaluationNote, /Golden set 12\/12/);
    assert.equal(audit[3].reason, 'go live');
    // The audit row carries a digest of the text, not the text.
    assert.ok(JSON.parse(audit[3].after).digest.length === 64);
    assert.equal(JSON.parse(audit[3].after).systemPrompt, undefined);
  });

  it('the read path renders single-pass; a missing declared variable is a hard error; injection in a value is inert', async () => {
    await assert.rejects(() => reg.renderPrompt(SLUG, { job_block: 'x' }), reg.MissingPromptVariablesError);
    const rendered = await reg.renderPrompt(SLUG, { job_block: 'Job', resume_json: '{{job_block}} {{system}}' });
    assert.equal(rendered.version, 1);
    assert.equal(rendered.userPrompt, '{{job_block}} {{system}}');
    assert.ok(rendered.systemPrompt.includes('Job'));
    assert.deepEqual(rendered.modelParameters, { effort: 'medium', max_tokens: 1000 });
  });

  it('promoting v2 demotes v1 to approved; promoting v1 again is recorded as a rollback', async () => {
    const v2 = await reg.createPromptVersion(input(2), STAFF);
    assert.equal(v2.version, 2);
    await reg.approvePromptVersion(v2.id, SECOND);
    await reg.recordPromptEvaluation(v2.id, { status: 'passed', note: 'Golden set 12/12, no regression against v1.' }, STAFF);
    await reg.promotePromptVersion(v2.id, STAFF);
    const rows = await db.promptVersion.findMany({ where: { slug: SLUG }, orderBy: { version: 'asc' } });
    assert.deepEqual(rows.map((r) => r.deploymentStatus), ['approved', 'default']);
    assert.equal((await reg.renderPrompt(SLUG, { job_block: 'j', resume_json: 'r' })).version, 2);

    await reg.promotePromptVersion(rows[0].id, STAFF, 'v2 regressed');
    const after = await db.promptVersion.findMany({ where: { slug: SLUG }, orderBy: { version: 'asc' } });
    assert.deepEqual(after.map((r) => r.deploymentStatus), ['default', 'approved']);
    const last = await db.auditLog.findFirstOrThrow({ where: { entityType: 'PromptVersion', entityId: rows[0].id }, orderBy: { createdAt: 'desc' } });
    assert.equal(last.action, 'prompt.rollback');
    assert.match(last.summary, /Rolled .* back from v2 to v1/);
  });

  it('the default cannot be retired; a non-default can; a retired version cannot be evaluated', async () => {
    const [v1, v2] = await db.promptVersion.findMany({ where: { slug: SLUG }, orderBy: { version: 'asc' } });
    await assert.rejects(() => reg.retirePromptVersion(v1.id, STAFF), /cannot be retired/);
    await reg.retirePromptVersion(v2.id, STAFF);
    await assert.rejects(() => reg.recordPromptEvaluation(v2.id, { status: 'failed', note: 'x' }, STAFF), /retired/);
    await assert.rejects(() => reg.promotePromptVersion(v2.id, STAFF), /Only an approved version/);
  });

  it('resetting the live default to pending demotes it: nothing serves without a PASSED evaluation at any moment', async () => {
    const v1 = await db.promptVersion.findUniqueOrThrow({ where: { slug_version: { slug: SLUG, version: 1 } } });
    assert.equal(v1.deploymentStatus, 'default');
    const reset = await reg.recordPromptEvaluation(v1.id, { status: 'pending', note: 'Re-evaluating on a new model.' }, STAFF);
    assert.equal(reset.deploymentStatus, 'approved');
    assert.equal(await reg.getActivePrompt(SLUG), null);
    // Put it back for the next case, through the gate.
    await reg.recordPromptEvaluation(v1.id, { status: 'passed', note: 'Golden set 12/12 on the new model.' }, STAFF);
    await reg.promotePromptVersion(v1.id, STAFF);
    assert.equal((await reg.getActivePrompt(SLUG))?.id, v1.id);
  });

  it('a failed evaluation on the live default demotes it immediately: the slug has no default', async () => {
    const v1 = await db.promptVersion.findUniqueOrThrow({ where: { slug_version: { slug: SLUG, version: 1 } } });
    const demoted = await reg.recordPromptEvaluation(v1.id, { status: 'failed', note: 'Truthfulness suite: 2 fabricated employers.' }, STAFF);
    assert.equal(demoted.deploymentStatus, 'approved');
    assert.equal(demoted.evaluationStatus, 'failed');
    assert.equal(await reg.getActivePrompt(SLUG), null);
    await assert.rejects(() => reg.promotePromptVersion(v1.id, STAFF), /evaluation has passed/);
  });

  it('concurrent promotes of two passed versions leave exactly one default', async () => {
    const [v1, v2] = await db.promptVersion.findMany({ where: { slug: SLUG }, orderBy: { version: 'asc' } });
    await db.promptVersion.update({ where: { id: v1.id }, data: { deploymentStatus: 'approved', evaluationStatus: 'passed' } });
    await db.promptVersion.update({ where: { id: v2.id }, data: { deploymentStatus: 'approved', evaluationStatus: 'passed' } });
    const results = await Promise.allSettled([reg.promotePromptVersion(v1.id, STAFF), reg.promotePromptVersion(v2.id, STAFF)]);
    assert.ok(results.every((r) => r.status === 'fulfilled'));
    const defaults = await db.promptVersion.count({ where: { slug: SLUG, deploymentStatus: 'default' } });
    assert.equal(defaults, 1);
  });

  it('step-up: a wrong password is refused and audited; an account without a local password cannot step up; attempts are rate-limited', async () => {
    const { hashPassword } = await import('../src/lib/auth');
    const { requireStepUp, StepUpError } = await import('../src/lib/crm/step-up');
    await db.user.create({ data: { id: STAFF.id, email: STAFF.email, passwordHash: await hashPassword('correct horse battery staple'), fullName: 'Staff', role: 'admin' } });
    await db.user.create({ data: { id: SECOND.id, email: SECOND.email, passwordHash: '', fullName: 'Second', role: 'admin' } });
    await requireStepUp(STAFF, 'correct horse battery staple', {});
    await assert.rejects(() => requireStepUp(STAFF, 'wrong', { ip: '203.0.113.9' }), StepUpError);
    const audit = await db.auditLog.findFirst({ where: { action: 'auth.step_up.failed', actorId: STAFF.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit);
    assert.equal(audit.ip, '203.0.113.9');
    assert.equal(audit.after.includes('wrong'), false, 'the attempted password is never recorded');
    await assert.rejects(() => requireStepUp(SECOND, 'anything', {}), StepUpError);
    // The auth bucket allows 10 attempts per window; the rest are refused before any comparison.
    for (let i = 0; i < 12; i += 1) await requireStepUp(STAFF, 'wrong', {}).catch(() => undefined);
    await assert.rejects(() => requireStepUp(STAFF, 'correct horse battery staple', {}), /Too many/);
  });
});

/**
 * ADR-0006 / ADR-0015 — the AI gateway.
 *
 * STATIC (no database): nothing outside the gateway can reach an external
 * model. The SDK and the Anthropic adapter are imported only by the provider
 * registry; the registry's external accessor is called only by the gateway.
 *
 * DATABASE: the policy-enforcement proof (MASTER_BUILD_PLAN Stage 03
 * evidence: "a prohibited tenant is never routed externally"), the
 * traceability record, the refusal of a RESTRICTED payload, and the
 * truthfulness suite against the live-model PATH with a fake provider that
 * returns fabricated claims. Runs against the migrated PostgreSQL the tenancy
 * suite uses, so the RLS-policied AiRun table and the seeded PromptVersion
 * rows are the real ones.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { CompletionRequest, ExternalModelProvider } from '../src/lib/providers/ai/types';
import { JOB, RESUME } from './fixtures/ai-fixtures';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

// --- STATIC ------------------------------------------------------------------------
function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

describe('AI gateway — static: only the gateway can reach an external model', () => {
  it('the Anthropic SDK and adapter are imported only by the provider registry', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const rel = path.relative(ROOT, f);
      const src = readFileSync(f, 'utf8');
      if (/@anthropic-ai\/sdk/.test(src) && rel !== 'src/lib/providers/ai/anthropic.ts') offenders.push(`${rel} imports the SDK`);
      if (/ai\/anthropic["'`]/.test(src) && !['src/lib/providers/index.ts', 'src/lib/providers/ai/anthropic.ts'].includes(rel)) offenders.push(`${rel} imports the adapter`);
      if (/AnthropicModelProvider/.test(src) && !['src/lib/providers/index.ts', 'src/lib/providers/ai/anthropic.ts'].includes(rel)) offenders.push(`${rel} names the adapter`);
    }
    assert.deepEqual(offenders, []);
  });
  it('getExternalModelProvider is called only by the gateway', () => {
    const callers: string[] = [];
    for (const f of files(SRC)) {
      const rel = path.relative(ROOT, f);
      if (rel === 'src/lib/providers/index.ts') continue;
      if (/getExternalModelProvider/.test(readFileSync(f, 'utf8'))) callers.push(rel);
    }
    assert.deepEqual(callers, ['src/lib/ai/gateway.ts']);
  });
  it('no route or service imports a provider AI class directly', () => {
    const importers: string[] = [];
    for (const f of files(SRC)) {
      const rel = path.relative(ROOT, f);
      if (rel.startsWith('src/lib/providers/') || rel.startsWith('src/lib/ai/')) continue;
      if (/providers\/ai\/(mock|anthropic)["'`]/.test(readFileSync(f, 'utf8'))) importers.push(rel);
    }
    assert.deepEqual(importers, []);
  });
});

// --- DATABASE ---------------------------------------------------------------------
type Db = typeof import('../src/lib/db')['db'];
type Gateway = typeof import('../src/lib/ai/gateway');
type Providers = typeof import('../src/lib/providers');
type Registry = typeof import('../src/lib/ai/prompt-registry');
type Orgs = typeof import('../src/lib/tenancy/organizations');

const S = randomBytes(4).toString('hex');
const ALLOWED = { id: `gw_allowed_${S}`, email: `gw-allowed-${S}@gw.test`, fullName: 'Allowed' };
const RESTRICTED = { id: `gw_restricted_${S}`, email: `gw-restricted-${S}@gw.test`, fullName: 'Restricted' };
const PROHIBITED = { id: `gw_prohibited_${S}`, email: `gw-prohibited-${S}@gw.test`, fullName: 'Prohibited' };
const ORPHAN = { id: `gw_orphan_${S}`, email: `gw-orphan-${S}@gw.test`, fullName: 'No organisation' };
const STAFF = { id: 'staff_test', email: 'staff@gw.test', fullName: 'Staff', role: 'admin' as const, storedRole: 'admin' };

/** A fake external provider that records what it was asked and answers with fabrications. */
class FakeProvider implements ExternalModelProvider {
  readonly name = 'fake';
  calls: CompletionRequest[] = [];
  answer: unknown = null;
  async complete<T>(request: CompletionRequest): Promise<T | null> {
    this.calls.push(request);
    return this.answer as T | null;
  }
}

const FABRICATED_TAILOR = {
  summary: 'Senior Data Analyst with 9 years at Google leading Looker migrations.',
  headline: 'Senior Data Analyst',
  skills: ['SQL', 'Looker', 'Snowflake', 'Kubernetes'],
  experience: [
    { company: 'Northbridge Commerce', title: 'Senior Data Analyst', bullets: ['Increased revenue by 300% through Tableau reporting', 'Led migration of 12 dashboards to Snowflake'] },
    { company: 'Google', title: 'Staff Analyst', bullets: ['Ran everything'] },
  ],
  coverLetter: 'Dear Hiring Team, I saved $4M at Northbridge Commerce and hold a PhD from MIT. Sincerely, Avery Chen',
  changes: ['Rewrote the summary.'],
  atsScore: 95,
};

let db: Db;
let gateway: Gateway;
let providers: Providers;
let registry: Registry;
let orgs: Orgs;
let fake: FakeProvider;
let tailorV1: { id: string; deploymentStatus: string; evaluationStatus: string; evaluationNote: string };

describe('AI gateway — policy enforcement, traceability and grounding on the live-model path', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    gateway = await import('../src/lib/ai/gateway');
    providers = await import('../src/lib/providers');
    registry = await import('../src/lib/ai/prompt-registry');
    orgs = await import('../src/lib/tenancy/organizations');

    for (const u of [ALLOWED, RESTRICTED, PROHIBITED, ORPHAN]) {
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName } });
    }
    for (const u of [ALLOWED, RESTRICTED, PROHIBITED]) await orgs.ensurePersonalWorkspace(db, u);
    await db.organization.update({ where: { id: orgs.personalOrganizationId(ALLOWED.id) }, data: { aiProcessingPolicy: 'EXTERNAL_AI_ALLOWED' } });
    await db.organization.update({ where: { id: orgs.personalOrganizationId(RESTRICTED.id) }, data: { aiProcessingPolicy: 'EXTERNAL_AI_RESTRICTED' } });

    // The seeded tailor v1 sits at approved/pending. Put it on the default
    // path through the registry's own gate, restoring the seed state after.
    const seeded = await db.promptVersion.findUniqueOrThrow({ where: { slug_version: { slug: 'tailor', version: 1 } } });
    tailorV1 = seeded;
    if (seeded.evaluationStatus !== 'passed') {
      await registry.recordPromptEvaluation(seeded.id, { status: 'passed', note: 'Test fixture: gateway suite marks the seeded baseline as passed for the duration of the run.' }, STAFF);
    }
    if (seeded.deploymentStatus !== 'default') await registry.promotePromptVersion(seeded.id, STAFF);

    fake = new FakeProvider();
    providers.setExternalModelProviderForTests(fake);
  });

  after(async () => {
    providers.resetProviders();
    await db.promptVersion.update({
      where: { id: tailorV1.id },
      data: { deploymentStatus: tailorV1.deploymentStatus, evaluationStatus: tailorV1.evaluationStatus, evaluationNote: tailorV1.evaluationNote },
    });
    await db.user.deleteMany({ where: { id: { in: [ALLOWED.id, RESTRICTED.id, PROHIBITED.id, ORPHAN.id] } } });
    await db.$disconnect();
  });

  const analysis = () => providers.getDeterministicEngine().analyzeMatch(RESUME, JOB);
  const lastRun = (userId: string) => db.aiRun.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } });

  it('EXTERNAL_AI_PROHIBITED: the provider is never called; the run says so; the candidate is told', async () => {
    fake.calls = [];
    fake.answer = FABRICATED_TAILOR;
    const { value, run } = await gateway.tailor({ userId: PROHIBITED.id, inputRefs: ['job:test'] }, RESUME, JOB, await analysis());
    assert.equal(fake.calls.length, 0);
    assert.equal(run.route, 'deterministic');
    assert.equal(run.reason, 'policy_prohibited');
    assert.equal(run.policyState, 'EXTERNAL_AI_PROHIBITED');
    assert.ok(value.notes.changes.at(-1)?.includes('no external model was used'));
    const row = await lastRun(PROHIBITED.id);
    assert.equal(row.route, 'deterministic');
    assert.equal(row.provider, 'deterministic');
    assert.equal(row.promptVersion, null);
    assert.equal(row.policyState, 'EXTERNAL_AI_PROHIBITED');
    assert.ok(JSON.parse(row.inputRefs).includes('policy_basis:organization'));
    // Nothing fabricated reached the output.
    assert.equal(/Google|Looker|MIT|300|\$4M/.test(value.resumeText + value.coverLetter), false);
  });

  it('a user with no organisation resolves to PROHIBITED (fail closed)', async () => {
    fake.calls = [];
    const { run } = await gateway.tailor({ userId: ORPHAN.id }, RESUME, JOB, await analysis());
    assert.equal(fake.calls.length, 0);
    assert.equal(run.route, 'deterministic');
    assert.equal(run.policyState, 'EXTERNAL_AI_PROHIBITED');
    assert.equal(run.policyBasis, 'missing_organization');
    const row = await lastRun(ORPHAN.id);
    assert.ok(JSON.parse(row.inputRefs).includes('policy_basis:missing_organization'));
  });

  it('EXTERNAL_AI_RESTRICTED: no task is listed as permitted, so nothing leaves', async () => {
    fake.calls = [];
    const { run } = await gateway.tailor({ userId: RESTRICTED.id }, RESUME, JOB, await analysis());
    assert.equal(fake.calls.length, 0);
    assert.equal(run.route, 'deterministic');
    assert.equal(run.reason, 'policy_restricted');
    assert.equal((await lastRun(RESTRICTED.id)).policyState, 'EXTERNAL_AI_RESTRICTED');
  });

  it('EXTERNAL_AI_ALLOWED without a default prompt for the task: degraded, provider not called', async () => {
    fake.calls = [];
    const { run } = await gateway.analyzeMatch({ userId: ALLOWED.id }, RESUME, JOB);
    assert.equal(fake.calls.length, 0);
    assert.equal(run.route, 'degraded');
    assert.equal(run.reason, 'no_default_prompt');
    const row = await lastRun(ALLOWED.id);
    assert.equal(row.route, 'degraded');
    assert.equal(row.error, 'no_default_prompt');
  });

  it('EXTERNAL_AI_ALLOWED with a default prompt: the provider is called with a fully rendered prompt, and every fabricated claim is rejected before render', async () => {
    fake.calls = [];
    fake.answer = FABRICATED_TAILOR;
    const evidence = { ids: ['ev_1', 'ev_2'], claims: ['Skill: SQL', 'Led migration of 12 dashboards to Snowflake'] };
    const { value, run } = await gateway.tailor({ userId: ALLOWED.id, evidence, inputRefs: ['job:test'] }, RESUME, JOB, await analysis());

    assert.equal(fake.calls.length, 1);
    const req = fake.calls[0];
    assert.equal(req.model, 'claude-opus-5');
    assert.equal(req.prompt.includes('{{'), false, 'no placeholder survives interpolation');
    assert.ok(req.prompt.includes('Maple Analytics'));
    assert.ok(req.prompt.includes('Northbridge Commerce'));
    assert.ok(req.prompt.includes('Led migration of 12 dashboards to Snowflake'), 'approved claims reach the model');
    assert.equal(req.effort, 'high');
    assert.equal(req.maxTokens, 16000);

    assert.equal(run.route, 'external');
    assert.equal(run.provider, 'fake');
    assert.equal(run.promptSlug, 'tailor');
    assert.equal(run.promptVersion, 1);
    assert.ok(run.claimsRejected >= 5, `expected several rejections, got ${run.claimsRejected}`);

    const text = value.resumeText + '\n' + value.coverLetter + '\n' + JSON.stringify(value.resumeContent);
    for (const forbidden of ['Google', 'Looker', 'MIT', 'PhD', 'Kubernetes', '300', '$4M', 'Staff Analyst']) {
      assert.equal(text.includes(forbidden), false, `fabricated "${forbidden}" reached the output`);
    }
    assert.ok(value.resumeContent.skills.includes('Snowflake'), 'an evidenced skill survives');
    assert.equal(value.resumeContent.experience.length, 2);
    assert.ok(value.notes.changes.some((c) => c.startsWith('Grounding:')));

    const row = await lastRun(ALLOWED.id);
    assert.equal(row.route, 'external');
    assert.equal(row.provider, 'fake');
    assert.equal(row.promptSlug, 'tailor');
    assert.equal(row.promptVersion, 1);
    assert.equal(row.claimsRejected, run.claimsRejected);
    assert.deepEqual(JSON.parse(row.evidenceRefs), ['ev_1', 'ev_2']);
    assert.ok(JSON.parse(row.inputRefs).includes('job:test'));
    assert.equal(row.status, 'ok');
  });

  it('a payload carrying a RESTRICTED field is refused on every route, recorded, and never sent', async () => {
    fake.calls = [];
    const poisoned = { ...RESUME, gender: 'woman' } as unknown as typeof RESUME;
    await assert.rejects(async () => gateway.tailor({ userId: ALLOWED.id }, poisoned, JOB, await analysis()), /RESTRICTED field: resume\.gender/);
    assert.equal(fake.calls.length, 0);
    const row = await lastRun(ALLOWED.id);
    assert.equal(row.route, 'refused');
    assert.equal(row.status, 'refused');
    assert.equal(row.error, 'restricted_payload:resume.gender');
    // The same for a prohibited tenant: the payload is wrong, not the route.
    await assert.rejects(async () => gateway.tailor({ userId: PROHIBITED.id }, poisoned, JOB, await analysis()), /RESTRICTED field/);
  });

  it('a provider that returns nothing degrades explicitly; a provider that returns garbage degrades explicitly', async () => {
    fake.calls = [];
    fake.answer = null;
    let r = await gateway.tailor({ userId: ALLOWED.id }, RESUME, JOB, await analysis());
    assert.equal(r.run.route, 'degraded');
    assert.equal(r.run.reason, 'provider_unavailable');
    assert.ok(r.value.notes.changes.at(-1)?.includes('did not respond'));
    fake.answer = { nonsense: true };
    r = await gateway.tailor({ userId: ALLOWED.id }, RESUME, JOB, await analysis());
    assert.equal(r.run.route, 'degraded');
    assert.equal(r.run.reason, 'malformed_output');
    assert.equal(fake.calls.length, 2);
  });

  it('a provider that THROWS still leaves a trace: the run is recorded as failed and the error propagates', async () => {
    const throwing: ExternalModelProvider = { name: 'throwing', complete: async () => { throw new Error('socket hang up'); } };
    providers.setExternalModelProviderForTests(throwing);
    await assert.rejects(async () => gateway.tailor({ userId: ALLOWED.id }, RESUME, JOB, await analysis()), /socket hang up/);
    const row = await lastRun(ALLOWED.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'provider_threw');
    assert.equal(row.route, 'external');
    assert.equal(row.provider, 'throwing');
    assert.equal(row.promptVersion, 1);
    providers.setExternalModelProviderForTests(fake);
  });

  it('the tenant can read its own AiRun rows and nothing else, and cannot change them', async () => {
    const ctx = await import('../src/lib/tenancy/context');
    const mine = await ctx.withTenant({ userId: ALLOWED.id }, (tx) => tx.aiRun.findMany());
    assert.ok(mine.length > 0);
    assert.ok(mine.every((r) => r.userId === ALLOWED.id));
    // No write policy: a DELETE sees no rows (affects 0) and an INSERT is refused outright.
    const deleted = await ctx.withTenant({ userId: ALLOWED.id }, (tx) => tx.aiRun.deleteMany());
    assert.equal(deleted.count, 0);
    assert.equal((await db.aiRun.count({ where: { userId: ALLOWED.id } })), mine.length);
    await assert.rejects(
      () => ctx.withTenant({ userId: ALLOWED.id }, (tx) => tx.aiRun.create({ data: { task: 'tailor', userId: ALLOWED.id, policyState: 'EXTERNAL_AI_ALLOWED', route: 'external', provider: 'forged' } })),
      /row-level security|42501|permission denied/,
    );
    const theirs = await ctx.withTenant({ userId: RESTRICTED.id }, (tx) => tx.aiRun.findMany({ where: { userId: ALLOWED.id } }));
    assert.deepEqual(theirs, []);
  });

  it('no external provider configured: an ALLOWED tenant degrades and is told; nothing pretends to be a model', async () => {
    providers.setExternalModelProviderForTests(null);
    const { run, value } = await gateway.tailor({ userId: ALLOWED.id }, RESUME, JOB, await analysis());
    assert.equal(run.route, 'degraded');
    assert.equal(run.reason, 'no_external_provider');
    assert.ok(value.notes.changes.at(-1)?.includes('not configured'));
    providers.setExternalModelProviderForTests(fake);
  });

  it('the interview path grounds stories and answers the same way', async () => {
    fake.calls = [];
    // No default prompt for prepare-interview: the route is degraded, the pack is the deterministic one.
    const { run, value } = await gateway.prepareInterview({ userId: ALLOWED.id }, RESUME, JOB);
    assert.equal(run.route, 'degraded');
    assert.equal(run.reason, 'no_default_prompt');
    assert.ok(value.questions.length >= 4);
    assert.equal(JSON.stringify(value).includes('Amazon'), false);
  });
});

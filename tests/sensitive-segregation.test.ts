/**
 * ADR-0007 — the sensitive schema is unreachable from every decision path.
 *
 * Three independent proofs, because each closes a different door:
 *   1. DATABASE: the tenant role cannot name, read or write the schema; the
 *      sensitive role can read only its own row; the ordinary Prisma client
 *      has no model for it at all.
 *   2. STATIC: no module on a matching, scoring, ranking, recommendation,
 *      document-generation or AI path references the sensitive module or the
 *      schema — a grep over the source that fails when someone adds one.
 *   3. PAYLOAD: what the AI providers receive is the résumé projection, whose
 *      fields are enumerated; a profile whose owner HAS recorded
 *      self-identification produces a payload containing none of the values.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

// --- 2. STATIC — runs everywhere, no database needed --------------------------
const DECISION_PATHS = [
  'src/lib/services',
  'src/lib/providers/ai',
  'src/lib/providers/apply',
  'src/lib/providers/jobs',
  'src/lib/resume-render.ts',
  'src/lib/prompt-engine.ts',
  'src/lib/prompt-interpolate.ts',
  'src/lib/candidate',
  'src/lib/analytics',
  'src/lib/exports',
];
const FORBIDDEN = [/lib\/sensitive/, /sensitive\.self_identification/, /self_identification/, /SelfIdentification/, /app_sensitive/];

function* files(p: string): Generator<string> {
  const abs = path.resolve(__dirname, '..', p);
  if (statSync(abs).isFile()) {
    yield abs;
    return;
  }
  for (const entry of readdirSync(abs)) {
    const full = path.join(abs, entry);
    if (statSync(full).isDirectory()) yield* files(path.relative(path.resolve(__dirname, '..'), full));
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

describe('ADR-0007 — static: no decision path references the sensitive schema', () => {
  it('matching, scoring, AI, apply, document, analytics and export code never name it', () => {
    const offenders: string[] = [];
    for (const p of DECISION_PATHS) {
      for (const f of files(p)) {
        const src = readFileSync(f, 'utf8');
        for (const re of FORBIDDEN) if (re.test(src)) offenders.push(`${path.relative(process.cwd(), f)} matches ${re}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
  it('the sensitive module is imported only by its own route and the erasure path', () => {
    const importers: string[] = [];
    for (const f of files('src')) {
      if (f.includes(`${path.sep}lib${path.sep}sensitive${path.sep}`)) continue;
      if (/lib\/sensitive\//.test(readFileSync(f, 'utf8'))) importers.push(path.relative(path.resolve(__dirname, '..'), f));
    }
    assert.deepEqual(importers.sort(), ['src/app/(app)/api/profile/self-identification/route.ts', 'src/components/self-identification-form.tsx'].filter((x) => importers.includes(x)).sort());
    assert.ok(importers.every((f) => f.startsWith('src/app/(app)/api/profile/self-identification/') || f === 'src/lib/security-audit.ts'), `unexpected importer: ${importers.join(', ')}`);
  });
});

// --- 1. DATABASE and 3. PAYLOAD -------------------------------------------------
type Db = typeof import('../src/lib/db')['db'];
type Sens = typeof import('../src/lib/sensitive/self-identification');
type Ctx = typeof import('../src/lib/tenancy/context');
type Profile = typeof import('../src/lib/candidate/profile');
const S = randomBytes(4).toString('hex');
const A = { id: `sens_a_${S}`, email: `sens-a-${S}@seg.test` };
const B = { id: `sens_b_${S}`, email: `sens-b-${S}@seg.test` };
let db: Db;
let sens: Sens;
let ctx: Ctx;
let profile: Profile;

describe('ADR-0007 — database and payload segregation', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    sens = await import('../src/lib/sensitive/self-identification');
    ctx = await import('../src/lib/tenancy/context');
    profile = await import('../src/lib/candidate/profile');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Seg' } });
    await sens.writeSelfIdentification(A, { gender: 'woman', ethnicity: 'racialized', indigenousStatus: 'first_nations', veteranStatus: 'veteran', disabilityStatus: 'person_with_disability' });
    await db.$transaction(async (tx) => {
      await profile.saveResumeSections(tx, A.id, { fullName: 'Seg', headline: 'Analyst', email: A.email, summary: 's', skills: ['SQL'], experience: [], education: [], certifications: [], projects: [] });
    });
  });
  after(async () => {
    await sens.eraseSelfIdentification(A, { actor: 'system' });
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id] } } });
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.$disconnect();
  });

  it('the TENANT role cannot even name the sensitive schema', async () => {
    await assert.rejects(
      ctx.withTenant({ userId: A.id }, (tx) => tx.$queryRaw`SELECT gender FROM sensitive.self_identification`),
      (e: unknown) => sens.isSensitiveAccessDenied(e),
      'app_tenant must get "permission denied for schema sensitive"',
    );
  });
  it('the sensitive role sees only its own row, and cannot forge another user’s', async () => {
    const own = await sens.readSelfIdentification(A);
    assert.equal(own?.gender, 'woman');
    const other = await sens.readSelfIdentification(B);
    assert.equal(other, null, 'B sees nothing of A');
    // A forged write for B from A's context is refused by the policy.
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${sens.SENSITIVE_ROLE}`);
        await tx.$queryRaw`SELECT set_config('app.current_user_id', ${A.id}, TRUE)`;
        await tx.$executeRaw`INSERT INTO sensitive.self_identification (user_id, notice_version) VALUES (${B.id}, 'x')`;
      }),
      /row-level security/i,
    );
  });
  it('the sensitive role holds nothing beyond its table: it cannot read the profile tables', async () => {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${sens.SENSITIVE_ROLE}`);
        await tx.$queryRaw`SELECT count(*) FROM "public"."CandidateProfile"`;
      }),
      /permission denied/i,
    );
  });
  it('the Prisma client has no model for the sensitive table', () => {
    const client = db as unknown as Record<string, unknown>;
    assert.equal(Object.keys(client).some((k) => /sensitive|selfIdentification/i.test(k)), false);
  });
  it('every access is audited without the values', async () => {
    const rows = await db.auditLog.findMany({ where: { actorId: A.id, action: { startsWith: 'sensitive.' } } });
    assert.ok(rows.length >= 2, 'a write and a read were audited');
    const text = JSON.stringify(rows);
    for (const v of ['woman', 'racialized', 'first_nations', 'veteran', 'person_with_disability']) {
      assert.equal(text.includes(v), false, `audit must not contain the value ${v}`);
    }
  });
  it('the AI payload for a candidate who answered contains none of the answers', async () => {
    const content = await profile.loadResumeContent(db, A.id);
    const text = JSON.stringify(content);
    for (const v of ['woman', 'racialized', 'first_nations', 'veteran', 'person_with_disability', 'prefer_not_to_say']) {
      assert.equal(text.includes(v), false, `résumé projection must not contain ${v}`);
    }
  });
  it('the sensitive table is RLS-forced, classified RESTRICTED, and denied to the REST roles by name', async () => {
    const [t] = await db.$queryRaw<{ enabled: boolean; forced: boolean; comment: string | null }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'sensitive' AND c.relname = 'self_identification'`;
    assert.equal(t.enabled && t.forced, true);
    assert.match(t.comment ?? '', /RESTRICTED/);
    const [priv] = await db.$queryRaw<{ tenant: boolean }[]>`SELECT has_schema_privilege('app_tenant', 'sensitive', 'USAGE') AS tenant`;
    assert.equal(priv.tenant, false);
  });
});

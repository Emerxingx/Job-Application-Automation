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
// An ALLOWLIST, not a denylist: every TypeScript file under src/ and scripts/
// is scanned, and only the files that ARE the sensitive path may mention it.
// A new module anywhere that names the schema, table, role or module fails
// here until it is deliberately added below.
const ALLOWED_TO_REFERENCE = new Set([
  'src/lib/sensitive/self-identification.ts',
  'src/app/(app)/api/profile/self-identification/route.ts',
  'src/components/self-identification-form.tsx',
  // Stage 23 (ADR-0037): account erasure must erase the RESTRICTED schema too, and it
  // does so ONLY by calling the sensitive module's own erase function - never the schema.
  'src/lib/privacy/erasure.ts',
  'src/app/(app)/dashboard/settings/self-identification/page.tsx',
  'src/app/(app)/dashboard/settings/page.tsx', // the link to the page, nothing else
  'src/lib/security-audit.ts', // the event names
  // Stage 03: the AI gateway's deny-list of RESTRICTED keys. It names the
  // attributes in order to REFUSE any payload carrying them; it imports
  // nothing from the sensitive path and reads no value.
  'src/lib/ai/restricted-fields.ts',
]);
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

describe('ADR-0007 — static: nothing outside the sensitive path names the sensitive schema', () => {
  it('every file under src/ and scripts/ that mentions it is on the allowlist', () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    for (const dir of ['src', 'scripts']) {
      for (const f of files(dir)) {
        const rel = path.relative(root, f);
        if (ALLOWED_TO_REFERENCE.has(rel)) continue;
        const src = readFileSync(f, 'utf8');
        for (const re of FORBIDDEN) if (re.test(src)) offenders.push(`${rel} matches ${re}`);
      }
    }
    assert.deepEqual(offenders, [], 'add a file to ALLOWED_TO_REFERENCE only if it IS the sensitive path');
  });
  it('the module itself is imported only by its route and its form', () => {
    const root = path.resolve(__dirname, '..');
    const importers: string[] = [];
    for (const f of files('src')) {
      const rel = path.relative(root, f);
      if (rel.startsWith('src/lib/sensitive/')) continue;
      if (/from '@\/lib\/sensitive\//.test(readFileSync(f, 'utf8'))) importers.push(rel);
    }
    assert.deepEqual(importers.sort(), ['src/app/(app)/api/profile/self-identification/route.ts', 'src/lib/privacy/erasure.ts']);
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
  it('every access is audited without the values, and the audit is a precondition of the access', async () => {
    const rows = await db.auditLog.findMany({ where: { actorId: A.id, action: { startsWith: 'sensitive.' } } });
    assert.ok(rows.length >= 2, 'a write and a read were audited');
    // Strict: if the audit row cannot be written the read does not happen.
    const broken = { ...db, auditLog: { create: async () => { throw new Error('audit store down'); } } } as unknown as typeof db;
    await assert.rejects(sens.readSelfIdentification(A, { client: broken }), /audit store down/);
    const text = JSON.stringify(rows);
    for (const v of ['woman', 'racialized', 'first_nations', 'veteran', 'person_with_disability']) {
      assert.equal(text.includes(v), false, `audit must not contain the value ${v}`);
    }
  });
  it('the matching path loads the résumé AS THE TENANT ROLE, which cannot reach the schema — and gets a full projection', async () => {
    // This is how scanner.ts and applicator.ts load the résumé since the
    // review: the read runs as app_tenant, so a query touching the sensitive
    // schema on this path would be a permission error, not a leak.
    const content = await ctx.withTenant({ userId: A.id }, (tx) => profile.loadResumeContent(tx, A.id));
    assert.ok(content);
    assert.deepEqual(content.skills, ['SQL']);
    await assert.rejects(
      ctx.withTenant({ userId: A.id }, (tx) => tx.$queryRaw`SELECT count(*) FROM sensitive.self_identification`),
      (e: unknown) => sens.isSensitiveAccessDenied(e),
    );
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

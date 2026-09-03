/**
 * ADR-0005 — the tenancy backstop through the REAL runtime.
 *
 * tests/rls-isolation.test.ts proves the PostgreSQL mechanism with raw SQL on
 * a throwaway table. This file proves the deployed artefacts: the committed
 * migrations, the generated policies on the application's own tables, the
 * `app_tenant` role, and `withTenant()` driving the actual Prisma client — the
 * code request handlers run. Application filters are deliberately ABSENT from
 * every tenant query below (`findMany()` with no `where`), so what is measured
 * is RLS alone: MASTER_BUILD_PLAN Stage 01 acceptance 3.
 *
 * The Prisma client is capped at ONE connection so that "the next request got
 * the previous request's connection" is the scenario under test rather than a
 * race, and the backend PID is asserted across requests so a green run cannot
 * mean the reuse silently did not happen. A second, wider client runs the
 * concurrent case.
 *
 * Scope, stated honestly: this runs against a stock PostgreSQL 16 (CI's service
 * container, or a developer's local server). It exercises the same code and the
 * same SQL the deployment will run, but it is NOT the proof against the real
 * Supavisor pooler in its configured mode. That proof needs the staging project
 * reachable from the build environment — AUTONOMOUS_STATUS.json → blockers.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) {
  throw new Error(
    'TENANCY_TEST_DATABASE_URL is not set, but this environment requires the tenancy isolation suite to run. ' +
      'CI must provide a migrated PostgreSQL (see .github/workflows/ci.yml).',
  );
}
const SKIP = CONNECTION_STRING
  ? false
  : 'TENANCY_TEST_DATABASE_URL is not set — no migrated PostgreSQL available. REQUIRED in CI and enforced there.';

type Prisma = typeof import('@prisma/client');
type Client = InstanceType<Prisma['PrismaClient']>;
type Tenancy = typeof import('../src/lib/tenancy/context');
type Orgs = typeof import('../src/lib/tenancy/organizations');
type Tables = typeof import('../src/lib/tenancy/rls-tables');

const SUFFIX = randomBytes(4).toString('hex');
const A = { id: `user_a_${SUFFIX}`, email: `a-${SUFFIX}@isolation.test`, fullName: 'Tenant A' };
const B = { id: `user_b_${SUFFIX}`, email: `b-${SUFFIX}@isolation.test`, fullName: 'Tenant B' };
const JOB_ID = `job_${SUFFIX}`;
const APP_A = `app_a_${SUFFIX}`;
const APP_B = `app_b_${SUFFIX}`;

let single: Client; // connection_limit=1: deterministic reuse
let wide: Client; // connection_limit=4: real concurrency
let system: Client; // fixtures and assertions from the system role
let withTenant: Tenancy['withTenant'];
let TenantContextError: Tenancy['TenantContextError'];
let orgs: Orgs;
let tables: Tables;
let orgX: string; // A owner, B invited but NOT accepted
let orgY: string; // B owner

function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

async function pid(tx: { $queryRaw: Client['$queryRaw'] }): Promise<number> {
  const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  return rows[0].pid;
}

describe('ADR-0005 — tenancy isolation through Prisma and the migrated schema', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    const { PrismaClient } = await import('@prisma/client');
    single = new PrismaClient({ datasourceUrl: withParam(CONNECTION_STRING!, 'connection_limit', '1') });
    wide = new PrismaClient({ datasourceUrl: withParam(CONNECTION_STRING!, 'connection_limit', '4') });
    system = new PrismaClient({ datasourceUrl: CONNECTION_STRING });
    ({ withTenant, TenantContextError } = await import('../src/lib/tenancy/context'));
    orgs = await import('../src/lib/tenancy/organizations');
    tables = await import('../src/lib/tenancy/rls-tables');

    for (const u of [A, B]) {
      await system.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName } });
      await orgs.ensurePersonalWorkspace(system, u);
    }
    await system.job.create({
      data: {
        id: JOB_ID, source: 'test', externalId: `ext_${SUFFIX}`, title: 'Analyst', company: 'Co', location: 'Toronto',
        country: 'CA', description: '', requirements: '', skills: '[]', applyUrl: 'https://example.test', postedAt: new Date(),
      },
    });
    await system.application.create({ data: { id: APP_A, userId: A.id, jobId: JOB_ID, notes: 'A private' } });
    await system.application.create({ data: { id: APP_B, userId: B.id, jobId: JOB_ID, notes: 'B private' } });
    await system.auditLog.create({ data: { id: `al_${SUFFIX}`, action: 'test', entityType: 'X', entityId: 'y' } });

    const x = await system.organization.create({
      data: { id: `org_x_${SUFFIX}`, name: 'X', slug: `x-${SUFFIX}`, type: 'employer', billingEmail: A.email },
    });
    orgX = x.id;
    await system.membership.create({ data: { organizationId: orgX, userId: A.id, role: 'owner', acceptedAt: new Date() } });
    // B is INVITED to X and has not accepted: must confer nothing.
    await system.membership.create({ data: { organizationId: orgX, userId: B.id, role: 'admin' } });
    const y = await system.organization.create({
      data: { id: `org_y_${SUFFIX}`, name: 'Y', slug: `y-${SUFFIX}`, type: 'staffing_agency', billingEmail: B.email },
    });
    orgY = y.id;
    await system.membership.create({ data: { organizationId: orgY, userId: B.id, role: 'owner', acceptedAt: new Date() } });
  });

  after(async () => {
    await system.$transaction([
      system.membership.deleteMany({ where: { OR: [{ userId: A.id }, { userId: B.id }] } }),
      system.organization.deleteMany({ where: { id: { in: [orgX, orgY, orgs.personalOrganizationId(A.id), orgs.personalOrganizationId(B.id)] } } }),
      system.application.deleteMany({ where: { id: { in: [APP_A, APP_B] } } }),
      system.auditLog.deleteMany({ where: { id: `al_${SUFFIX}` } }),
      system.job.deleteMany({ where: { id: JOB_ID } }),
      system.user.deleteMany({ where: { id: { in: [A.id, B.id] } } }),
    ]);
    await Promise.all([single.$disconnect(), wide.$disconnect(), system.$disconnect()]);
  });

  it('1 — every table is classified, exists, and is ENABLE + FORCE row level security', async () => {
    const rows = await system.$queryRaw<{ name: string; enabled: boolean; forced: boolean }[]>`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    const inDb = new Set(rows.map((r) => r.name));
    const classified = new Set(Object.keys(tables.RLS_TABLES));
    for (const t of tables.UNCLASSIFIED_TABLES) inDb.delete(t);
    assert.deepEqual([...inDb].filter((t) => !classified.has(t)), [], 'every table in the database must be classified in rls-tables.ts');
    assert.deepEqual([...classified].filter((t) => !inDb.has(t)), [], 'every classified table must exist');
    const unforced = rows.filter((r) => !tables.UNCLASSIFIED_TABLES.includes(r.name) && !(r.enabled && r.forced)).map((r) => r.name);
    assert.deepEqual(unforced, [], 'every table must be ENABLE and FORCE ROW LEVEL SECURITY');
  });

  it('2 — the tenant role exists and cannot bypass RLS', async () => {
    const [role] = await system.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]>`
      SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ${tables.TENANT_ROLE}`;
    assert.ok(role, 'app_tenant must exist');
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    assert.equal(role.rolcanlogin, false, 'reached only by SET ROLE');
  });

  it('3 — cross-tenant READ is impossible with application filters removed', async () => {
    const seenByA = await withTenant({ userId: A.id }, (tx) => tx.application.findMany(), { client: single });
    assert.deepEqual(seenByA.map((r) => r.id), [APP_A]);
    const seenByB = await withTenant({ userId: B.id }, (tx) => tx.application.findMany(), { client: single });
    assert.deepEqual(seenByB.map((r) => r.id), [APP_B]);
    const direct = await withTenant({ userId: A.id }, (tx) => tx.application.findUnique({ where: { id: APP_B } }), { client: single });
    assert.equal(direct, null, 'B’s row by primary key must be invisible to A');
    const viaRelation = await withTenant({ userId: A.id }, (tx) => tx.job.findUnique({ where: { id: JOB_ID }, include: { applications: true } }), { client: single });
    assert.deepEqual(viaRelation?.applications.map((r) => r.id), [APP_A], 'the relation must not leak the other tenant’s rows either');
  });

  it('4 — cross-tenant WRITE is impossible: forge refused, update and delete match nothing', async () => {
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.application.create({ data: { id: `forged_${SUFFIX}`, userId: B.id, jobId: JOB_ID } }), { client: single }),
      /row-level security/i,
      'inserting a row owned by another tenant must be refused by WITH CHECK',
    );
    const updated = await withTenant({ userId: A.id }, (tx) => tx.application.updateMany({ where: { id: APP_B }, data: { notes: 'hijacked' } }), { client: single });
    assert.equal(updated.count, 0);
    const deleted = await withTenant({ userId: A.id }, (tx) => tx.application.deleteMany({ where: { id: APP_B } }), { client: single });
    assert.equal(deleted.count, 0);
    // And re-parenting one's own row to another tenant is refused too.
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.application.update({ where: { id: APP_A }, data: { userId: B.id } }), { client: single }),
      /row-level security|not found/i,
    );
    const stillB = await system.application.findUniqueOrThrow({ where: { id: APP_B } });
    assert.equal(stillB.notes, 'B private');
  });

  it('5 — missing or malformed context is refused BEFORE reaching the database', async () => {
    for (const bad of ['', ' ', 'a b', "a'b", 'x; DROP TABLE "User"', 'é', 'a'.repeat(97), undefined, null, 42]) {
      await assert.rejects(
        withTenant({ userId: bad as string }, (tx) => tx.application.findMany(), { client: single }),
        TenantContextError,
        `context ${JSON.stringify(bad)} must be refused`,
      );
    }
    await assert.rejects(
      withTenant({ userId: A.id, organizationId: 'not valid' }, (tx) => tx.application.findMany(), { client: single }),
      TenantContextError,
    );
  });

  it('6 — an unknown but well-formed context sees nothing (fail closed)', async () => {
    const rows = await withTenant({ userId: `user_nobody_${SUFFIX}` }, (tx) => tx.application.findMany(), { client: single });
    assert.deepEqual(rows, []);
  });

  it('7 — CONNECTION REUSE: the next request on the same backend inherits nothing', async () => {
    let pidA = 0;
    const a = await withTenant({ userId: A.id }, async (tx) => { pidA = await pid(tx); return tx.application.findMany(); }, { client: single });
    assert.deepEqual(a.map((r) => r.id), [APP_A]);

    // Same physical connection, tenant role assumed, NO context established:
    // what a worker that forgot to set context — or a request whose context
    // call failed — would look like.
    // Schema-qualified on purpose: through a transaction-mode pooler even the
    // search_path is session state another client may have left behind, and a
    // raw query that relies on it resolves the wrong table. Prisma's own
    // queries are always qualified; this raw one must be too.
    const [, , noContext, pidNone] = await single.$transaction([
      single.$executeRawUnsafe(`SET LOCAL ROLE ${tables.TENANT_ROLE}`),
      single.$queryRaw`SELECT current_setting('app.current_user_id', TRUE) AS ctx`,
      single.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."Application"`,
      single.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    assert.equal(pidNone[0].pid, pidA, 'the pool must hand back the same backend for this to be the scenario under test');
    assert.equal(noContext[0].n, 0, 'no context on a reused connection must see NO rows');

    let pidB = 0;
    const b = await withTenant({ userId: B.id }, async (tx) => { pidB = await pid(tx); return tx.application.findMany(); }, { client: single });
    assert.equal(pidB, pidA, 'same backend');
    assert.deepEqual(b.map((r) => r.id), [APP_B], 'B on A’s previous connection sees only B');

    // The role reverted with the transaction: the connection is the system
    // role again, so the next system query is not silently running as tenant.
    const [{ who }] = await single.$queryRaw<{ who: string }[]>`SELECT current_user AS who`;
    assert.notEqual(who, tables.TENANT_ROLE, 'SET LOCAL ROLE must not outlive the transaction');
  });

  it('8 — PARALLEL requests for different tenants never see each other’s rows', async () => {
    const runs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? A : B)).map((u) =>
      withTenant({ userId: u.id }, (tx) => tx.application.findMany().then((rows) => ({ u: u.id, rows: rows.map((r) => r.id) })), { client: wide }),
    );
    const results = await Promise.all(runs);
    for (const r of results) {
      assert.deepEqual(r.rows, [r.u === A.id ? APP_A : APP_B], `tenant ${r.u} saw ${JSON.stringify(r.rows)}`);
    }
  });

  it('9 — organisation scope: membership grants, a pending invitation grants nothing, an owner cannot reach another tenant', async () => {
    const seenByA = await withTenant({ userId: A.id }, (tx) => tx.organization.findMany({ select: { id: true } }), { client: single });
    assert.deepEqual(seenByA.map((o) => o.id).sort(), [orgX, orgs.personalOrganizationId(A.id)].sort());
    const seenByB = await withTenant({ userId: B.id }, (tx) => tx.organization.findMany({ select: { id: true } }), { client: single });
    assert.deepEqual(seenByB.map((o) => o.id).sort(), [orgY, orgs.personalOrganizationId(B.id)].sort(), 'B’s pending invitation to X must not make X visible');
    // OWNER BYPASS: A owns X; that confers nothing over B's personal data.
    const bRows = await withTenant({ userId: A.id, organizationId: orgX }, (tx) => tx.application.findMany({ where: { userId: B.id } }), { client: single });
    assert.deepEqual(bRows, []);
    // B cannot write into X's roster (not an accepted member).
    await assert.rejects(
      withTenant({ userId: B.id }, (tx) => tx.membership.create({ data: { organizationId: orgX, userId: `user_c_${SUFFIX}`, role: 'owner' } }), { client: single }),
      /row-level security|foreign key/i,
    );
  });

  it('10 — reference data is readable but not writable; system tables are neither', async () => {
    await withTenant({ userId: A.id }, (tx) => tx.plan.findMany(), { client: single }); // must not throw
    const planUpdate = await withTenant({ userId: A.id }, (tx) => tx.plan.updateMany({ data: { name: 'x' } }), { client: single });
    assert.equal(planUpdate.count, 0, 'a tenant cannot modify reference data');
    const audit = await withTenant({ userId: A.id }, (tx) => tx.auditLog.findMany(), { client: single });
    assert.deepEqual(audit, [], 'the audit log is invisible to the tenant path');
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.auditLog.create({ data: { action: 'forged', entityType: 'X', entityId: 'y' } }), { client: single }),
      /row-level security/i,
    );
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.webhookEvent.create({ data: { provider: 'stripe', externalEventId: `evt_${SUFFIX}`, type: 'unknown', payload: '{}', occurredAt: new Date() } }), { client: single }),
      /row-level security/i,
    );
  });

  it('11 — a tenant cannot read the other tenant’s account row or sessions', async () => {
    const users = await withTenant({ userId: A.id }, (tx) => tx.user.findMany({ select: { id: true } }), { client: single });
    assert.deepEqual(users.map((u) => u.id), [A.id]);
    const sessionB = await system.session.create({ data: { userId: B.id, expiresAt: new Date(Date.now() + 60_000) } });
    try {
      const sessions = await withTenant({ userId: A.id }, (tx) => tx.session.findMany(), { client: single });
      assert.deepEqual(sessions, []);
      const revoked = await withTenant({ userId: A.id }, (tx) => tx.session.updateMany({ where: { id: sessionB.id }, data: { revokedAt: new Date() } }), { client: single });
      assert.equal(revoked.count, 0, 'A cannot revoke B’s session through the tenant path');
    } finally {
      await system.session.delete({ where: { id: sessionB.id } });
    }
  });

  it('12 — background execution on the system client is explicit and audited by construction', async () => {
    // The system client sees everything: that is its purpose (webhooks,
    // rollups, the console). What matters is that NOTHING reaches it by
    // accident from the tenant path, which tests 7 and 10 establish, and that
    // it is the connection role — not app_tenant — outside a tenant tx.
    const all = await system.application.findMany({ where: { id: { in: [APP_A, APP_B] } } });
    assert.equal(all.length, 2);
    const [{ who, bypass }] = await system.$queryRaw<{ who: string; bypass: boolean }[]>`
      SELECT current_user AS who, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    assert.notEqual(who, tables.TENANT_ROLE);
    // On a stock server the connection role is typically superuser; on the
    // managed deployment it is the owner with a named system_full_access
    // policy. Either way the policy row must exist so the bypass is explicit.
    const [{ n }] = await system.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'system_full_access' AND schemaname = 'public'`;
    assert.equal(n, Object.keys(tables.RLS_TABLES).length, 'one named system policy per classified public table (the sensitive schema has its own)');
    // The system policy is bound to the role that ran the migration. The role
    // the APPLICATION connects as must be that same role, or — with FORCE on
    // every table — the system client sees nothing. This asserts it against
    // whatever database the suite runs on, so a misconfigured DATABASE_URL on
    // staging fails here rather than in production.
    const roles = await system.$queryRaw<{ roles: string[] }[]>`SELECT roles FROM pg_policies WHERE policyname = 'system_full_access' AND tablename = 'User'`;
    assert.ok(roles[0].roles.includes(who), `DATABASE_URL role ${who} must be the migration role ${JSON.stringify(roles[0].roles)}`);
    void bypass;
  });

  it('13 — write surface is minimal: a tenant cannot change its own role, email or password, nor touch the roster, nor see coupons', async () => {
    // User: the UPDATE policy exists but column privileges confine it.
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.user.update({ where: { id: A.id }, data: { role: 'admin' } }), { client: single }),
      /permission denied/i,
      'role is the staff console’s second lock and is not tenant-writable',
    );
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.user.update({ where: { id: A.id }, data: { email: 'stolen@example.test' } }), { client: single }),
      /permission denied/i,
    );
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.user.update({ where: { id: A.id }, data: { passwordHash: 'x' } }), { client: single }),
      /permission denied/i,
    );
    // …while the profile columns the tenant path edits still work.
    const updated = await withTenant({ userId: A.id }, (tx) => tx.user.update({ where: { id: A.id }, data: { headline: 'Analyst' } }), { client: single });
    assert.equal(updated.headline, 'Analyst');
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.user.delete({ where: { id: A.id } }), { client: single }),
      /permission denied|not found/i,
    );
    // Membership and Organization: readable, never writable on the tenant path.
    const promote = await withTenant({ userId: A.id }, (tx) => tx.membership.updateMany({ where: { organizationId: orgX, userId: A.id }, data: { role: 'owner' } }), { client: single });
    assert.equal(promote.count, 0, 'no UPDATE policy on Membership for the tenant role');
    const relax = await withTenant({ userId: A.id }, (tx) => tx.organization.updateMany({ where: { id: orgX }, data: { aiProcessingPolicy: 'EXTERNAL_AI_ALLOWED' } }), { client: single });
    assert.equal(relax.count, 0, 'the AI policy cannot be relaxed from the tenant path');
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.membership.create({ data: { organizationId: orgX, userId: B.id, role: 'owner', acceptedAt: new Date() } }), { client: single }),
      /row-level security/i,
    );
    const coupons = await withTenant({ userId: A.id }, (tx) => tx.coupon.findMany(), { client: single });
    assert.deepEqual(coupons, [], 'coupon codes are not enumerable on the tenant path');
    // The migration ledger is out of reach entirely.
    await assert.rejects(
      withTenant({ userId: A.id }, (tx) => tx.$queryRaw`SELECT count(*) FROM "public"."_prisma_migrations"`, { client: single }),
      /permission denied/i,
    );
  });
});

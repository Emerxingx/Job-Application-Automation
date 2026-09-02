/**
 * ADR-0005 — proof that the tenancy backstop actually isolates, and that the
 * obvious way to wire it does not.
 *
 * This file is not a unit test of application code. It is the *mechanism proof*
 * the multi-tenancy ADR requires before RLS is relied upon, executed against a
 * real PostgreSQL server rather than reasoned about. Every claim ADR-0005 makes
 * about `SET LOCAL`, pooling, `FORCE ROW LEVEL SECURITY` and fail-closed
 * behaviour is asserted here, including the two that are counter-intuitive:
 *
 *   1. A session-level `SET` leaks tenant context to the NEXT request that
 *      reuses the same physical connection. Test 2 reproduces a cross-tenant
 *      read caused by nothing but connection reuse.
 *   2. `ENABLE ROW LEVEL SECURITY` alone is not enough. A table's OWNER bypasses
 *      its own policies unless `FORCE ROW LEVEL SECURITY` is also set — and on a
 *      managed Postgres the application's migration role typically IS the owner.
 *      Test 8 reproduces a total bypass with policies present and enabled.
 *
 * Connection reuse is asserted, not assumed: each pooled test compares
 * `pg_backend_pid()` across checkouts and fails if the pool happened to hand
 * back a different backend, so a green run cannot mean "the scenario never
 * occurred".
 *
 * Scope, stated honestly: this proves the mechanism on a stock PostgreSQL 16.
 * It does NOT prove the deployed configuration. The deployment-specific proof
 * ADR-0005 also requires — the same assertions through the real connection
 * pooler in its configured pool mode — needs a provisioned project and is
 * tracked in AUTONOMOUS_STATUS.json as SUPABASE-PROJECT.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, Pool, type PoolClient } from 'pg';

const CONNECTION_STRING = process.env.RLS_TEST_DATABASE_URL;

/**
 * Skipping is allowed on a developer machine with no PostgreSQL, and nowhere
 * else. In CI the absence of the URL is a configuration defect, not a reason to
 * pass: a suite that silently skips its only isolation proof is worse than one
 * that has none, because it reads green. `RLS_TEST_REQUIRED=1` forces the same
 * failure outside CI for anyone who wants the guarantee locally.
 */
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';

if (!CONNECTION_STRING && REQUIRED) {
  throw new Error(
    'RLS_TEST_DATABASE_URL is not set, but this environment requires the RLS isolation proof to run. ' +
      'CI must provide a PostgreSQL service container (see .github/workflows/ci.yml). ' +
      'Set RLS_TEST_REQUIRED=0 only on a developer machine that genuinely has no PostgreSQL.',
  );
}

const SKIP = CONNECTION_STRING
  ? false
  : 'RLS_TEST_DATABASE_URL is not set — no PostgreSQL available. This proof is REQUIRED in CI and is enforced there.';

/** Unique per run so concurrent runs against one server cannot collide. */
const SUFFIX = randomBytes(4).toString('hex');
const SCHEMA = `rls_proof_${SUFFIX}`;
const APP_ROLE = `rls_proof_app_${SUFFIX}`;

const TENANT_A = 'user_aaaaaaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'user_bbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * The pool is deliberately capped at one connection. That is not a performance
 * choice — it is what makes reuse deterministic, so "the next request got the
 * previous request's connection" is the scenario under test rather than a race
 * that shows up once in a thousand runs. Production pools are larger and reuse
 * connections just as thoroughly; capping at one only removes the luck.
 */
let pool: Pool;
let admin: Client;

/**
 * Connection-level configuration, applied once per PHYSICAL connection.
 *
 * `pg` emits a `connect` event for new physical connections but does not await
 * its listeners, so an async listener races the first query. Tracking the
 * clients already configured is deterministic instead, and models what an
 * application actually does: role and search_path are connection-level setup,
 * tenancy is not — which is the whole distinction under test.
 */
const configured = new WeakSet<PoolClient>();

async function checkout(): Promise<{ client: PoolClient; pid: number }> {
  const client = await pool.connect();
  if (!configured.has(client)) {
    // The application connects as a limited role that also owns its tables,
    // which is the shape a managed Postgres produces: migrations and queries
    // run as the same non-superuser role. Test 8 depends on that being real.
    await client.query(`SET ROLE ${APP_ROLE}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    configured.add(client);
  }
  try {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return { client, pid: rows[0].pid };
  } catch (error) {
    // Without this, one failing query strands the only connection in a max:1
    // pool and every later test hangs instead of reporting.
    client.release();
    throw error;
  }
}

/**
 * `SET` and `SET LOCAL` are utility statements: PostgreSQL does not accept bind
 * parameters in them, so `SET LOCAL app.user_id = $1` is a syntax error and the
 * only way to write it literally is to interpolate the tenant id into SQL text.
 * `set_config(name, value, is_local)` is the parameterised equivalent — same
 * effect, and the tenant id stays a bound value rather than becoming an
 * injection site in the one place that decides who can see what.
 */
async function setTenant(client: PoolClient, tenant: string, isLocal: boolean): Promise<void> {
  await client.query('SELECT set_config($1, $2, $3)', ['app.user_id', tenant, isLocal]);
}

async function titlesVisible(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ title: string }>(
    'SELECT title FROM job_application ORDER BY title',
  );
  return rows.map((r) => r.title);
}

describe('ADR-0005 — PostgreSQL row-level security is a real tenancy backstop', { skip: SKIP }, () => {
  before(async () => {
    admin = new Client({ connectionString: CONNECTION_STRING });
    await admin.connect();

    // NOLOGIN is deliberate: the proof reaches this role with SET ROLE, so no
    // password has to be invented, stored or printed. RLS is evaluated against
    // `current_user`, which SET ROLE changes, so the enforcement path is the
    // same one a password login would take.
    await admin.query(`CREATE ROLE ${APP_ROLE} NOLOGIN`);
    await admin.query(`CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${APP_ROLE}`);

    await admin.query(`SET ROLE ${APP_ROLE}`);
    await admin.query(`SET search_path TO ${SCHEMA}`);

    await admin.query(`
      CREATE TABLE job_application (
        id      text PRIMARY KEY,
        user_id text NOT NULL,
        title   text NOT NULL
      )
    `);
    // Seeded BEFORE row-level security is turned on. Once it is on and forced,
    // this same statement is refused with SQLSTATE 42501 because the seeding
    // session has no tenant context — which is the fail-closed property working
    // as intended, and is asserted from the write side in tests 7 and 9.
    await admin.query(
      `INSERT INTO job_application (id, user_id, title) VALUES
         ('a1', $1, 'A — Senior Developer'),
         ('a2', $1, 'A — Staff Engineer'),
         ('b1', $2, 'B — Data Analyst')`,
      [TENANT_A, TENANT_B],
    );

    await admin.query('ALTER TABLE job_application ENABLE ROW LEVEL SECURITY');
    // Without this line every assertion below still passes for a non-owner and
    // silently fails open for the owner. Test 8 is what stops it being dropped.
    await admin.query('ALTER TABLE job_application FORCE ROW LEVEL SECURITY');

    // `current_setting(..., true)` does not raise when the setting is absent: it
    // returns NULL on a connection that has never seen it, and the empty string
    // on one where it has been set and cleared (test 4 proves both). Neither is
    // equal to any real tenant id, so a request that never established tenancy
    // matches no rows — under equality, and without a NULL test that would only
    // cover one of the two states.
    await admin.query(`
      CREATE POLICY tenant_isolation ON job_application
        USING      (user_id = current_setting('app.user_id', true))
        WITH CHECK (user_id = current_setting('app.user_id', true))
    `);

    await admin.query('RESET ROLE');

    pool = new Pool({ connectionString: CONNECTION_STRING, max: 1 });
  });

  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('RESET ROLE');
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await admin.end();
    }
  });

  it('1 — the application role is not superuser and cannot bypass RLS', async () => {
    const { client } = await checkout();
    try {
      const { rows } = await client.query<{
        who: string;
        is_super: boolean;
        can_bypass: boolean;
      }>(
        `SELECT current_user AS who,
                rolsuper     AS is_super,
                rolbypassrls AS can_bypass
           FROM pg_roles WHERE rolname = current_user`,
      );
      // A superuser, or any role with BYPASSRLS, ignores every policy in this
      // file. If that were true of the application role, every other assertion
      // here would be vacuous — so it is checked first.
      assert.equal(rows[0].who, APP_ROLE);
      assert.equal(rows[0].is_super, false, 'the application role must not be superuser');
      assert.equal(rows[0].can_bypass, false, 'the application role must not have BYPASSRLS');
    } finally {
      client.release();
    }
  });

  it('2 — THE DEFECT: a session-level SET leaks tenant context to the next request on the same connection', async () => {
    // Request one: establishes tenancy the obvious way, with a plain SET.
    const first = await checkout();
    try {
      await setTenant(first.client, TENANT_A, false);
      assert.deepEqual(await titlesVisible(first.client), [
        'A — Senior Developer',
        'A — Staff Engineer',
      ]);
    } finally {
      first.client.release();
    }

    // Request two: a different request, which establishes NO tenancy at all.
    // A correct system shows it nothing.
    const second = await checkout();
    try {
      assert.equal(
        second.pid,
        first.pid,
        'the pool must hand back the same backend for this scenario to be the one under test',
      );

      const leaked = await titlesVisible(second.client);

      // This is the finding. Not a hypothetical: an untenanted request reads
      // another tenant's rows, caused by nothing but connection reuse.
      assert.deepEqual(leaked, ['A — Senior Developer', 'A — Staff Engineer']);
      assert.ok(leaked.length > 0, 'session-level SET leaks across pooled requests');
    } finally {
      // Clean the leaked state so it cannot contaminate the tests below — which
      // is precisely the cleanup a real request handler would have to remember
      // to perform on every path, including every error path.
      await second.client.query('RESET app.user_id');
      second.client.release();
    }
  });

  it('3 — THE FIX: SET LOCAL confines tenant context to its transaction', async () => {
    const first = await checkout();
    try {
      await first.client.query('BEGIN');
      await setTenant(first.client, TENANT_A, true);
      assert.deepEqual(await titlesVisible(first.client), [
        'A — Senior Developer',
        'A — Staff Engineer',
      ]);
      await first.client.query('COMMIT');
    } finally {
      first.client.release();
    }

    const second = await checkout();
    try {
      assert.equal(second.pid, first.pid, 'same backend — the reuse scenario from test 2');
      // Same connection, same reuse, same absent tenancy — and now nothing.
      assert.deepEqual(await titlesVisible(second.client), []);
    } finally {
      second.client.release();
    }
  });

  it('4 — a request with no tenant context sees nothing, and "no context" is not always NULL', async () => {
    // A pristine connection has never heard of the setting, so it reads NULL.
    const pristine = new Client({ connectionString: CONNECTION_STRING });
    await pristine.connect();
    try {
      const { rows } = await pristine.query<{ ctx: string | null }>(
        `SELECT current_setting('app.user_id', true) AS ctx`,
      );
      assert.equal(rows[0].ctx, null, 'never set on this connection reads as NULL');
    } finally {
      await pristine.end();
    }

    // A RECYCLED connection does not. Once the setting has existed in a session
    // — as it has on the pooled connection, from the tests above — clearing it
    // leaves the empty string behind, not NULL.
    //
    // This matters beyond pedantry: a guard written as
    //   IF current_setting('app.user_id', true) IS NULL THEN RAISE ...
    // fires on the first request a connection ever serves and never again. Any
    // check for "no tenant context" must treat NULL and '' as the same state,
    // and the policy must reject both. That is why the policy is an equality
    // against a real tenant id rather than a NULL test.
    const { client } = await checkout();
    try {
      const { rows } = await client.query<{ ctx: string | null }>(
        `SELECT current_setting('app.user_id', true) AS ctx`,
      );
      assert.ok(
        rows[0].ctx === null || rows[0].ctx === '',
        `expected no tenant context, got ${JSON.stringify(rows[0].ctx)}`,
      );
      assert.equal(
        rows[0].ctx,
        '',
        'a recycled connection reports the empty string, not NULL — NULL alone is not a usable guard',
      );

      // Whichever of the two it is, the security property is identical.
      assert.deepEqual(await titlesVisible(client), []);
    } finally {
      client.release();
    }
  });

  it('5 — an empty or unknown tenant context sees nothing (fail closed)', async () => {
    for (const context of ['', 'not-a-real-user-id', '*']) {
      const { client } = await checkout();
      try {
        await client.query('BEGIN');
        await setTenant(client, context, true);
        assert.deepEqual(
          await titlesVisible(client),
          [],
          `context ${JSON.stringify(context)} must match no rows`,
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
  });

  it('6 — each tenant sees only its own rows, and switching context switches the result', async () => {
    const { client } = await checkout();
    try {
      await client.query('BEGIN');
      await setTenant(client, TENANT_B, true);
      assert.deepEqual(await titlesVisible(client), ['B — Data Analyst']);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await setTenant(client, TENANT_A, true);
      assert.deepEqual(await titlesVisible(client), [
        'A — Senior Developer',
        'A — Staff Engineer',
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('7 — writes cannot cross a tenant boundary', async () => {
    const { client } = await checkout();
    try {
      await client.query('BEGIN');
      await setTenant(client, TENANT_A, true);

      // Forging another tenant's id on insert is refused by WITH CHECK.
      await assert.rejects(
        client.query(
          `INSERT INTO job_application (id, user_id, title) VALUES ('x1', $1, 'forged')`,
          [TENANT_B],
        ),
        (error: { code?: string }) => error.code === '42501',
        'inserting a row owned by another tenant must be rejected',
      );
      await client.query('ROLLBACK');

      // Update and delete do not error — the other tenant's rows are simply not
      // visible, so they match nothing. Silence, not a permission failure, is
      // the correct behaviour and is easy to mistake for success.
      await client.query('BEGIN');
      await setTenant(client, TENANT_A, true);
      const updated = await client.query(
        `UPDATE job_application SET title = 'hijacked' WHERE id = 'b1'`,
      );
      assert.equal(updated.rowCount, 0, 'another tenant’s row must not be updatable');
      const deleted = await client.query(`DELETE FROM job_application WHERE id = 'b1'`);
      assert.equal(deleted.rowCount, 0, 'another tenant’s row must not be deletable');
      await client.query('COMMIT');

      // And it really is still there, seen from its owner.
      await client.query('BEGIN');
      await setTenant(client, TENANT_B, true);
      assert.deepEqual(await titlesVisible(client), ['B — Data Analyst']);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('8 — ENABLE without FORCE lets the table owner bypass its own policies', async () => {
    // The application role owns its tables, as it does on a managed Postgres
    // where migrations and queries run as the same role. For an owner, ENABLE
    // ROW LEVEL SECURITY is advisory: policies exist, are attached, and are not
    // applied. This is the failure mode that looks entirely correct in a schema
    // review and returns every tenant's rows in production.
    const { client } = await checkout();
    try {
      await client.query(`
        CREATE TABLE unforced (
          id      text PRIMARY KEY,
          user_id text NOT NULL
        )
      `);
      await client.query('ALTER TABLE unforced ENABLE ROW LEVEL SECURITY');
      await client.query(`
        CREATE POLICY tenant_isolation ON unforced
          USING (user_id = current_setting('app.user_id', true))
      `);
      await client.query(
        `INSERT INTO unforced (id, user_id) VALUES ('a', $1), ('b', $2)`,
        [TENANT_A, TENANT_B],
      );

      await client.query('BEGIN');
      await setTenant(client, TENANT_A, true);
      const bypassed = await client.query<{ id: string }>('SELECT id FROM unforced ORDER BY id');
      // Two rows, from two tenants, with a correct policy enabled.
      assert.deepEqual(
        bypassed.rows.map((r) => r.id),
        ['a', 'b'],
        'without FORCE the owner bypasses RLS entirely',
      );
      await client.query('COMMIT');

      await client.query('ALTER TABLE unforced FORCE ROW LEVEL SECURITY');

      await client.query('BEGIN');
      await setTenant(client, TENANT_A, true);
      const forced = await client.query<{ id: string }>('SELECT id FROM unforced ORDER BY id');
      assert.deepEqual(
        forced.rows.map((r) => r.id),
        ['a'],
        'FORCE ROW LEVEL SECURITY is what makes the policy bind the owner',
      );
      await client.query('COMMIT');
    } finally {
      await client.query('DROP TABLE IF EXISTS unforced');
      client.release();
    }
  });

  it('9 — a table with RLS enabled and no policy denies everything, rather than allowing it', async () => {
    // Relevant to the migration in ADR-0002: if a table is enabled and forced
    // but its policy is forgotten, the failure is a visible outage for that
    // table, not a silent cross-tenant read. That asymmetry is the reason
    // enabling RLS is safe to do first and add policies to second.
    const { client } = await checkout();
    try {
      await client.query('CREATE TABLE policyless (id text PRIMARY KEY)');
      // Seeded before RLS is enabled: with no policy, a forced table refuses
      // the INSERT as well, which is the same fail-closed behaviour seen from
      // the write side.
      await client.query(`INSERT INTO policyless (id) VALUES ('only-row')`);
      await client.query('ALTER TABLE policyless ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE policyless FORCE ROW LEVEL SECURITY');

      await assert.rejects(
        client.query(`INSERT INTO policyless (id) VALUES ('refused')`),
        (error: { code?: string }) => error.code === '42501',
        'a forced table with no policy must refuse writes',
      );

      const { rows } = await client.query('SELECT id FROM policyless');
      assert.deepEqual(rows, [], 'no policy must mean no rows, not all rows');
    } finally {
      await client.query('DROP TABLE IF EXISTS policyless');
      client.release();
    }
  });
  it('10 — a transaction-scoped set outside a transaction is discarded immediately', async () => {
    // The trap on the other side of test 3. `is_local` means "until the end of
    // the current transaction", and a query sent outside an explicit BEGIN is
    // its own transaction — so the context is gone before the next statement
    // runs. Code that sets tenancy this way and then queries outside the
    // transaction is not subtly wrong; it has no context at all.
    //
    // It fails closed, which is why this is a correctness bug that presents as
    // an outage rather than a leak. Asserting it keeps the requirement precise:
    // ADR-0005 needs the set and the query in ONE transaction, not merely a
    // `SET LOCAL`-shaped call somewhere in the request.
    const { client } = await checkout();
    try {
      await setTenant(client, TENANT_A, true);
      assert.deepEqual(
        await titlesVisible(client),
        [],
        'a local set outside a transaction must not carry into the next statement',
      );

      // The same call, inside a transaction, works — so the difference really
      // is the transaction and nothing else.
      await client.query('BEGIN');
      await setTenant(client, TENANT_A, true);
      assert.deepEqual(await titlesVisible(client), [
        'A — Senior Developer',
        'A — Staff Engineer',
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});

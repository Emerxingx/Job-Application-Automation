import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { GUC_ORGANIZATION_ID, GUC_USER_ID, TENANT_ROLE } from './rls-tables';

/**
 * Transaction-scoped tenant context — the ONLY way application code reaches
 * the tenant path.
 *
 * WHAT THIS DOES, AND WHY EACH PART IS THE WAY IT IS
 * --------------------------------------------------
 * `withTenant` opens ONE Prisma interactive transaction and, before the caller
 * runs a single query in it:
 *
 *   1. `SET LOCAL ROLE app_tenant` — switches the transaction to the role the
 *      RLS policies are written for. LOCAL, so it ends with the transaction;
 *      the pooled connection goes back as the system role it arrived as.
 *   2. `set_config('app.current_user_id', $1, TRUE)` — establishes who the
 *      request acts for. The third argument (`is_local = TRUE`) confines it to
 *      the transaction. This is the parameterised form; `SET LOCAL` takes no
 *      bind parameters and would force the id into SQL text.
 *   3. the same for the organisation, when there is one.
 *
 * Every query the callback issues on `tx` then runs on that same connection,
 * in that same transaction, so the policies see the context. A query issued
 * on `db` (the module-level client) from inside the callback does NOT — it
 * takes a different connection and runs as the system role. That is the one
 * mistake this design cannot prevent mechanically, which is why the callback
 * receives `tx` as its only argument and why code review looks for `db.` in
 * tenant handlers.
 *
 * This is the transaction-scoped approach the mechanism proof settled on
 * (tests/rls-isolation.test.ts, ADR-0005 amendment). It is the only shape that
 * is safe on a transaction-mode pooler: session-level context outlives the
 * request and binds to whoever gets the connection next.
 *
 * FAIL CLOSED, BEFORE THE DATABASE
 * --------------------------------
 * An empty, missing or malformed id is refused here with `TenantContextError`
 * rather than sent to PostgreSQL. The policies would match nothing anyway
 * (equality against a real id), but an exception is a better failure than an
 * empty result set that looks like "the user has no data".
 */

export interface TenantContext {
  /** The user the request acts for. Always required. */
  userId: string;
  /** The organisation the request acts within, when it acts within one. */
  organizationId?: string | null;
}

export type TenantTx = Prisma.TransactionClient;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * The shape of an identifier this application issues (Prisma cuid, or the
 * `org_personal_…` / `mem_personal_…` ids the backfill derives from one).
 * Anything else is refused before it becomes a setting value. Length-capped so
 * a hostile value cannot be used to pad the setting either.
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,96}$/;

export function assertTenantId(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !ID_SHAPE.test(value)) {
    throw new TenantContextError(`${what} is missing or malformed; refusing to establish tenant context`);
  }
}

export interface WithTenantOptions {
  /** Prisma interactive-transaction timeout, ms. Default 15 000. */
  timeout?: number;
  /** Time to wait for a connection from the pool, ms. Default 5 000. */
  maxWait?: number;
}

/**
 * Run `fn` inside a transaction that carries tenant context.
 *
 * The client instance is a parameter (defaulting to the application's) so the
 * negative-test suite can exercise this exact code against a pool capped at one
 * connection, where connection reuse between requests is deterministic rather
 * than lucky.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
  options: WithTenantOptions & { client?: typeof db } = {},
): Promise<T> {
  assertTenantId(ctx.userId, 'userId');
  const organizationId = ctx.organizationId ?? null;
  if (organizationId !== null) assertTenantId(organizationId, 'organizationId');

  const client = options.client ?? db;
  return client.$transaction(
    async (tx) => {
      // A constant, not user input: TENANT_ROLE is a compile-time string from
      // rls-tables.ts. SET ROLE cannot take a bind parameter.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${TENANT_ROLE}`);
      await tx.$queryRaw`SELECT set_config(${GUC_USER_ID}, ${ctx.userId}, TRUE)`;
      await tx.$queryRaw`SELECT set_config(${GUC_ORGANIZATION_ID}, ${organizationId ?? ''}, TRUE)`;
      return fn(tx);
    },
    { timeout: options.timeout ?? 15_000, maxWait: options.maxWait ?? 5_000 },
  );
}

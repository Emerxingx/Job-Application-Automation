import { PrismaClient } from '@prisma/client';
import { normalizeDatabaseUrl } from './db-url';

// Next.js dev mode hot-reloads modules; without this the process would open a
// new pool on every reload and exhaust connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * The SYSTEM client.
 *
 * Queries issued here run as the connection role, which owns the schema and
 * — on the managed deployment — bypasses row-level security. That is correct
 * for the paths that are genuinely cross-tenant (sign-in by email, webhook
 * processing, the staff console, rollups, migrations) and wrong for anything
 * acting on behalf of a signed-in user. Request handlers acting for a user go
 * through `src/lib/tenancy/context.ts`, which runs the same Prisma client
 * inside a transaction that establishes tenant context first, so the RLS
 * backstop (ADR-0005) actually applies to the query.
 *
 * The connection string is normalised so a password containing URL-reserved
 * characters is percent-encoded before the query engine parses it; see
 * src/lib/db-url.ts.
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: normalizeDatabaseUrl(process.env.DATABASE_URL),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

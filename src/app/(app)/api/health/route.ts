import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCache } from '@/lib/cache';
import { getStorageProvider } from '@/lib/storage';
import { clientAddress, rateLimit } from '@/lib/rate-limit';
import { MART_REGISTRY } from '@/lib/analytics/platform/dictionary';
import { martFreshness } from '@/lib/analytics/freshness';
import { rateLimitStoreName } from '@/lib/rate-limit';
import { workerHealth } from '@/lib/ops/scheduler';

/**
 * Stage 23 (ADR-0037) - the health check a load balancer, an uptime monitor
 * or an operator reads. Public (no session) by design, so it is rate-limited
 * by address and says NOTHING that helps an attacker: no host, no version,
 * no count, no backend name, no error text - each check is a boolean and a
 * short, fixed word (Stage 23 review, M3: the first version printed the
 * number of migrations and the storage and cache backends).
 *
 * `status` is `ok` when the application can serve a request (database
 * reachable, migrations complete), `degraded` when it can but something
 * operational is off (a mart past its SLA, no enabled job source), and the
 * response is 503 only when a request could not be served.
 *
 * COST. Every check is a database query, and the endpoint is public. Two
 * bounds (review M3): the result is memoised per instance for
 * `MEMO_MS`, so a burst costs one round of queries, not one per request;
 * and besides the per-address budget there is a per-instance budget across
 * ALL addresses, so a caller who can vary the forwarded address (no proxy in
 * front, or more hops than configured) still cannot make this instance run
 * the checks more than `GLOBAL_LIMIT` times a minute.
 */
export const dynamic = 'force-dynamic';

interface Check {
  ok: boolean;
  detail: string;
}

/** How long one computed answer is served to every caller of this instance. */
export const MEMO_MS = 10_000;
export const GLOBAL_LIMIT = { limit: 300, windowSeconds: 60 };

async function checkDatabase(): Promise<Check> {
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true, detail: 'reachable' };
  } catch {
    return { ok: false, detail: 'unreachable' };
  }
}

async function checkMigrations(): Promise<Check> {
  try {
    const rows = await db.$queryRaw<{ pending: bigint }[]>`SELECT count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS pending FROM "_prisma_migrations"`;
    return Number(rows[0]?.pending ?? 0) === 0 ? { ok: true, detail: 'applied' } : { ok: false, detail: 'pending' };
  } catch {
    return { ok: false, detail: 'unknown' };
  }
}

async function checkStorage(): Promise<Check> {
  try {
    await getStorageProvider();
    return { ok: true, detail: 'available' };
  } catch {
    return { ok: false, detail: 'unavailable' };
  }
}

async function checkJobSources(): Promise<Check> {
  try {
    const enabled = await db.jobSource.count({ where: { status: 'enabled' } });
    return enabled > 0 ? { ok: true, detail: 'enabled' } : { ok: false, detail: 'none enabled' };
  } catch {
    return { ok: false, detail: 'unknown' };
  }
}

async function checkMarts(): Promise<Check> {
  try {
    const marts = Object.keys(MART_REGISTRY) as (keyof typeof MART_REGISTRY)[];
    const freshness = await martFreshness(marts);
    return freshness.some((f) => f.stale) ? { ok: false, detail: 'stale' } : { ok: true, detail: 'fresh' };
  } catch {
    return { ok: false, detail: 'unknown' };
  }
}

// Stage 24: scheduled work. Overdue when a job has not succeeded inside twice
// its interval; a deployment whose worker has never run says so in two words.
async function checkWorker(): Promise<Check> {
  try {
    const health = await workerHealth();
    if (health.ok) return { ok: true, detail: 'current' };
    return { ok: false, detail: health.everRan ? 'overdue' : 'never ran' };
  } catch {
    return { ok: false, detail: 'unknown' };
  }
}

interface HealthBody {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: Record<string, Check>;
  checkedAt: string;
}

let memo: { at: number; body: HealthBody } | null = null;

/** Compute the answer, or serve the one computed inside the last MEMO_MS. Exported for the test. */
export async function healthBody(now = Date.now()): Promise<HealthBody> {
  if (memo && now >= memo.at && now - memo.at < MEMO_MS) return memo.body;
  const [database, migrations, storage, jobSources, marts, worker] = await Promise.all([checkDatabase(), checkMigrations(), checkStorage(), checkJobSources(), checkMarts(), checkWorker()]);
  const cache: Check = { ok: true, detail: getCache().backend === 'redis' ? 'shared' : 'local' };
  // Stage 24: which limiter store is configured - `local` is correct for one instance and wrong for two (R-16).
  const rateLimitStore: Check = { ok: true, detail: rateLimitStoreName() === 'postgres' ? 'shared' : 'local' };
  const serving = database.ok && migrations.ok;
  const operational = serving && storage.ok && jobSources.ok && marts.ok && worker.ok;
  const body: HealthBody = { status: !serving ? 'unavailable' : operational ? 'ok' : 'degraded', checks: { database, migrations, cache, rateLimitStore, storage, jobSources, marts, worker }, checkedAt: new Date(now).toISOString() };
  memo = { at: now, body };
  return body;
}

/** Test seam. */
export function resetHealthMemo(): void {
  memo = null;
}

export async function GET(request: Request) {
  const noStore = { 'Cache-Control': 'no-store' };
  const perAddress = await rateLimit('health', clientAddress(request), { limit: 60, windowSeconds: 60 });
  if (!perAddress.ok) return NextResponse.json({ status: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(perAddress.retryAfterSeconds), ...noStore } });
  const perInstance = await rateLimit('health:all', 'all', GLOBAL_LIMIT);
  if (!perInstance.ok) return NextResponse.json({ status: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(perInstance.retryAfterSeconds), ...noStore } });

  const body = await healthBody();
  return NextResponse.json(body, { status: body.status === 'unavailable' ? 503 : 200, headers: noStore });
}

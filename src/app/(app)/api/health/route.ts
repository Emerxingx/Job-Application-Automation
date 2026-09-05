import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCache } from '@/lib/cache';
import { getStorageProvider } from '@/lib/storage';
import { clientAddress, rateLimit } from '@/lib/rate-limit';
import { MART_REGISTRY } from '@/lib/analytics/platform/dictionary';
import { martFreshness } from '@/lib/analytics/freshness';

/**
 * Stage 23 (ADR-0037) - the health check a load balancer, an uptime monitor
 * or an operator reads. Public (no session) by design, so it is rate-limited
 * by address and says NOTHING that helps an attacker: no host, no version,
 * no error text - each check is a boolean and a short, fixed word.
 *
 * `status` is `ok` when the application can serve a request (database
 * reachable, migrations complete), `degraded` when it can but something
 * operational is off (a mart past its SLA, no enabled job source), and the
 * response is 503 only when a request could not be served.
 */
export const dynamic = 'force-dynamic';

interface Check {
  ok: boolean;
  detail: string;
}

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
    const rows = await db.$queryRaw<{ pending: bigint; applied: bigint }[]>`SELECT count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS pending, count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied FROM "_prisma_migrations"`;
    const pending = Number(rows[0]?.pending ?? 0);
    return pending === 0 ? { ok: true, detail: `${Number(rows[0]?.applied ?? 0)} applied` } : { ok: false, detail: `${pending} pending or failed` };
  } catch {
    return { ok: false, detail: 'unknown' };
  }
}

async function checkStorage(): Promise<Check> {
  try {
    const provider = await getStorageProvider();
    return { ok: true, detail: provider.name };
  } catch {
    return { ok: false, detail: 'unavailable' };
  }
}

async function checkJobSources(): Promise<Check> {
  try {
    const enabled = await db.jobSource.count({ where: { status: 'enabled' } });
    return enabled > 0 ? { ok: true, detail: `${enabled} enabled` } : { ok: false, detail: 'none enabled' };
  } catch {
    return { ok: false, detail: 'unknown' };
  }
}

async function checkMarts(): Promise<Check> {
  try {
    const marts = Object.keys(MART_REGISTRY) as (keyof typeof MART_REGISTRY)[];
    const freshness = await martFreshness(marts);
    const stale = freshness.filter((f) => f.stale).length;
    return stale === 0 ? { ok: true, detail: 'fresh' } : { ok: false, detail: `${stale} of ${marts.length} stale` };
  } catch {
    return { ok: false, detail: 'unknown' };
  }
}

export async function GET(request: Request) {
  const limit = rateLimit('health', clientAddress(request), { limit: 60, windowSeconds: 60 });
  if (!limit.ok) return NextResponse.json({ status: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds), 'Cache-Control': 'no-store' } });

  const [database, migrations, storage, jobSources, marts] = await Promise.all([checkDatabase(), checkMigrations(), checkStorage(), checkJobSources(), checkMarts()]);
  const cache: Check = { ok: true, detail: getCache().backend };
  const serving = database.ok && migrations.ok;
  const operational = serving && storage.ok && jobSources.ok && marts.ok;
  const body = { status: !serving ? 'unavailable' : operational ? 'ok' : 'degraded', checks: { database, migrations, cache, storage, jobSources, marts }, checkedAt: new Date().toISOString() };
  return NextResponse.json(body, { status: serving ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}

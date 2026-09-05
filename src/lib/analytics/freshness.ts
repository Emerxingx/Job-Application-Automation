import { db } from '@/lib/db';
import { MART_REGISTRY, type MartName } from './platform/dictionary';

/**
 * Stage 21 (ADR-0036) - refresh SLAs. Each mart names the rollup JOBS that
 * rebuild it; the mart's "as of" is the OLDEST of the latest SUCCEEDED
 * `RollupRun` per job (a mart two jobs write is only as fresh as the one that
 * ran least recently, and one that never ran leaves it never rebuilt). A page
 * shows that instant and says STALE when it is older than the mart's SLA - a
 * stale dashboard must say so rather than silently show old numbers. There is
 * ADR-0011's queue is not built; since Stage 24 the worker runs the rollups nightly, and staleness is the honest signal that
 * the operator's sweep has not run.
 */
export interface MartFreshness {
  mart: MartName;
  jobs: readonly string[];
  slaHours: number;
  /** When the mart was last rebuilt successfully by EVERY job that writes it, or null if any never has. */
  asOf: Date | null;
  stale: boolean;
  /** The most recent failure of any of its jobs that is newer than that job's last success. */
  lastError: string | null;
}

/** Pure: the mart's as-of across the jobs that write it - the OLDEST latest success, and null when ANY job has never succeeded (review M2). */
export function oldestSuccess(dates: readonly (Date | null)[]): Date | null {
  let out: Date | undefined;
  for (const d of dates) {
    if (d === null) return null;
    if (!out || d < out) out = d;
  }
  return out ?? null;
}

/** Pure: stale when never run or when the last success is older than the SLA. */
export function isStale(asOf: Date | null, slaHours: number, now = new Date()): boolean {
  if (!asOf) return true;
  return now.getTime() - asOf.getTime() > slaHours * 3_600_000;
}

export async function martFreshness(marts: readonly MartName[], now = new Date()): Promise<MartFreshness[]> {
  const jobs = [...new Set(marts.flatMap((m) => MART_REGISTRY[m].jobs))];
  const [successes, failures] = await Promise.all([
    Promise.all(jobs.map((job) => db.rollupRun.findFirst({ where: { job, status: 'succeeded' }, orderBy: { finishedAt: 'desc' }, select: { job: true, finishedAt: true } }))),
    Promise.all(jobs.map((job) => db.rollupRun.findFirst({ where: { job, status: 'failed' }, orderBy: { finishedAt: 'desc' }, select: { job: true, finishedAt: true, error: true } }))),
  ]);
  return marts.map((mart) => {
    const { jobs: martJobs, slaHours } = MART_REGISTRY[mart];
    let lastError: string | null = null;
    const latest: (Date | null)[] = [];
    for (const job of martJobs) {
      const ok = successes.find((r) => r?.job === job)?.finishedAt ?? null;
      const failed = failures.find((r) => r?.job === job) ?? null;
      latest.push(ok);
      if (failed && (!ok || (failed.finishedAt && failed.finishedAt > ok))) lastError = failed.error ?? 'failed';
    }
    const resolved = oldestSuccess(latest);
    return { mart, jobs: martJobs, slaHours, asOf: resolved, stale: isStale(resolved, slaHours, now), lastError };
  });
}

/** One line for a page header: "Data as of 2026-09-05 03:10 UTC" or "STALE: not rebuilt since ..." or "never rebuilt". */
export function describeFreshness(f: MartFreshness): string {
  if (!f.asOf) return `${f.mart}: never rebuilt - run npm run analytics:rollup`;
  const when = f.asOf.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return f.stale ? `${f.mart}: STALE - last rebuilt ${when} (SLA ${f.slaHours}h)` : `${f.mart}: data as of ${when}`;
}

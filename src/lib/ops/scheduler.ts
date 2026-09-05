import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { redactError } from '@/lib/log';

/**
 * Stage 24 (ADR-0038) - the scheduler.
 *
 * Until this stage every sweep was an operator's command and every
 * freshness line said "no scheduler exists". This is the scheduler: a
 * registry of jobs with an interval, and a `tick` that a long-running
 * worker process (`npm run worker`) calls every minute.
 *
 * LEASES, NOT LOCKS
 * -----------------
 * Each job's time is divided into windows of its interval (aligned to the
 * epoch, so every worker computes the same boundaries). A run is claimed
 * by INSERTING a `WorkerRun` row for (job, windowStart); the unique index
 * makes the insert the lease. Two workers, or a worker restarted mid-run,
 * cannot both claim the same window: the second insert fails with P2002
 * and that worker moves on. No `pg_advisory_lock`, because the
 * application's runtime connection is the transaction pooler, on which a
 * session lock is exactly the leak `DEPLOYMENT_ARCHITECTURE.md` warns
 * about.
 *
 * TIMEOUTS (Stage 24 review, H1)
 * ------------------------------
 * `job.run` is raced against the job's `timeoutMinutes`: a job that has
 * not returned by then is recorded `failed: timed out` and the tick moves
 * on, so one hung job (a dead pooled connection, a provider that never
 * answers) cannot stop every other job or hold the worker's shutdown. The
 * timed-out promise itself is not cancelled - JavaScript cannot - and may
 * still hold a connection until it settles; when it does, its late result
 * is DISCARDED: a run is finished with a conditional update on
 * `status = 'running'`, so a row already marked failed (by the timeout or
 * by `abandonStaleRuns` on another worker) is never overwritten with
 * `succeeded`. A run that outlives its window can therefore overlap the
 * next window's run; the jobs here are idempotent replace-sweeps, so the
 * overlap costs work, not correctness, and the rows record it.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a queue: there is no per-item work, no retry inside a window (a
 * failed window is retried at the NEXT window, or by the operator's
 * command), no dead-letter queue. Readiness gate G4 "Background
 * processing: queue + workers + DLQ" is PARTIAL with this, not PASS, and
 * the evidence says so. Nothing here applies to a job on anyone's behalf
 * (ADR-0016): the jobs are the sweeps that already existed as commands.
 * Daily windows start at 00:00 UTC (20:00 Eastern the evening before).
 */

export interface ScheduledJob {
  name: string;
  /** How often the job is due. Windows are aligned to the epoch. */
  intervalMinutes: number;
  /** A run older than this and still `running` is abandoned; a run still executing at this age is recorded as timed out. */
  timeoutMinutes: number;
  /** Runs the job for the window and returns a one-line summary of counts - never a value about a person. */
  run(now: Date): Promise<string>;
}

/** Stage 24: the jobs the worker runs. Each is the lib function the corresponding operator command calls. */
export const JOBS: ScheduledJob[] = [
  {
    name: 'freshness',
    intervalMinutes: 6 * 60,
    timeoutMinutes: 60,
    async run() {
      const { ensureSourceRegistry } = await import('@/lib/connectors/registry');
      const { runRefresh } = await import('@/lib/connectors/pipeline');
      await ensureSourceRegistry();
      const sources = await db.jobSource.findMany({ where: { status: { in: ['enabled', 'degraded'] } }, orderBy: { priority: 'asc' } });
      const parts: string[] = [];
      let failed = 0;
      for (const source of sources) {
        try {
          const run = await runRefresh(source.key, { staleAfterMs: 24 * 3_600_000 });
          parts.push(`${source.key}: ${run.status} (checked ${run.discovered}, closed ${run.closed})`);
          if (run.status !== 'ok') failed += 1;
        } catch (error) {
          failed += 1;
          parts.push(`${source.key}: refused (${redactError(error).message})`);
        }
      }
      if (failed > 0) throw new Error(`${failed} of ${sources.length} source(s) failed - ${parts.join('; ')}`);
      return sources.length === 0 ? 'no enabled source' : parts.join('; ');
    },
  },
  {
    name: 'analytics_rollup',
    intervalMinutes: 24 * 60,
    timeoutMinutes: 120,
    async run(now) {
      const { rollupAll } = await import('@/lib/analytics/rollups');
      const { rangeOfDays } = await import('@/lib/analytics/time');
      // Thirty days: the replace scopes converge, so a daily thirty-day window
      // keeps every mart current and repairs a late-arriving event; the
      // operator's 400-day command is for a rebuild. The snapshot metrics
      // ("at the end of the as-of day") are labelled with the day that just
      // ENDED - the window starts at midnight, and a snapshot taken then
      // describes the previous day's close, not this day's (review M6).
      const range = rangeOfDays(30, now);
      const asOf = new Date(windowStartFor(now, 24 * 60).getTime() - 1);
      const platform = await rollupAll(range, { asOf });
      const failed = platform.filter((r) => r.status === 'failed');
      const summary = `${platform.length} jobs, ${platform.reduce((n, r) => n + r.rowsWritten, 0)} rows written, snapshot day ${asOf.toISOString().slice(0, 10)}`;
      if (failed.length > 0) throw new Error(`${failed.map((r) => `${r.job}: ${r.error ?? 'failed'}`).join('; ')} - ${summary}`);
      return summary;
    },
  },
  {
    name: 'retention_sweep',
    intervalMinutes: 24 * 60,
    timeoutMinutes: 120,
    async run(now) {
      const { sweepRetention } = await import('@/lib/privacy/retention');
      const r = await sweepRetention(now);
      const summary = `sessions ${r.sessions}, ai runs ${r.aiRuns}, rollup runs ${r.rollupRuns}, worker runs ${r.workerRuns}, mailbox refs ${r.mailboxReferences}, mart rows ${r.martRows}, erasures ${r.erasures} of ${r.erasuresDue} due (${r.erasuresResumed} resumed), file purges retried ${r.filePurgesRetried}`;
      if (r.erasureErrors > 0) throw new Error(`${r.erasureErrors} erasure(s) failed - ${summary}`);
      return summary;
    },
  },
  {
    name: 'cases_retention',
    intervalMinutes: 24 * 60,
    timeoutMinutes: 60,
    async run(now) {
      const { purgeExpiredCaseRecords } = await import('@/lib/cases/service');
      const r = await purgeExpiredCaseRecords(now);
      return `${r.organizations} organisation(s) with a policy: ${r.notes} notes, ${r.assessments} assessments, ${r.cases} closed cases (${r.children} rows under them)`;
    },
  },
  {
    name: 'rate_limit_buckets',
    intervalMinutes: 60,
    timeoutMinutes: 10,
    async run(now) {
      const { sweepRateLimitBuckets } = await import('@/lib/rate-limit');
      return `${await sweepRateLimitBuckets(now)} expired bucket(s) removed`;
    },
  },
];

/** Pure: the start of the window containing `now` for a job of this interval, aligned to the epoch. */
export function windowStartFor(now: Date, intervalMinutes: number): Date {
  const ms = Math.max(1, intervalMinutes) * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export type TickOutcome = 'succeeded' | 'failed' | 'skipped';

export interface TickResult {
  job: string;
  windowStart: Date;
  outcome: TickOutcome;
  /** For `skipped`: why (already run, or claimed by another worker). For `failed`: the redacted error. */
  detail: string;
}

/** Marks runs that never finished inside their job's timeout as failed, so they stop counting as in progress. Returns how many. */
export async function abandonStaleRuns(now: Date, jobs: readonly ScheduledJob[] = JOBS): Promise<number> {
  let abandoned = 0;
  for (const job of jobs) {
    const cutoff = new Date(now.getTime() - job.timeoutMinutes * 60_000);
    const r = await db.workerRun.updateMany({ where: { job: job.name, status: 'running', startedAt: { lt: cutoff } }, data: { status: 'failed', finishedAt: now, error: 'abandoned: the worker did not finish inside the timeout' } });
    abandoned += r.count;
  }
  return abandoned;
}

class JobTimeout extends Error {
  constructor(minutes: number) {
    super(`timed out after ${minutes} minute(s); the job's promise was left to settle and its late result is discarded`);
    this.name = 'JobTimeout';
  }
}

/** Race the job against its timeout. The timer is cleared either way so a finished job never keeps the process alive. */
function runWithTimeout(job: ScheduledJob, now: Date): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeout(job.timeoutMinutes)), Math.max(1, job.timeoutMinutes * 60_000));
  });
  return Promise.race([job.run(now), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Finish a run ONLY if it is still `running`: a row the timeout or another
 * worker's abandon rule already marked failed keeps that verdict, and a late
 * success can never erase it (review H1). Returns whether the row took it.
 */
async function finishRun(runId: string, data: { status: 'succeeded' | 'failed'; summary?: string; error?: string }): Promise<boolean> {
  const r = await db.workerRun.updateMany({ where: { id: runId, status: 'running' }, data: { ...data, finishedAt: new Date() } });
  return r.count === 1;
}

/**
 * One tick: for every job whose current window has no run, claim it and run
 * it. Sequential on purpose (the worker is one process; two heavy sweeps at
 * once compete for the same database) and bounded per job by its timeout.
 * Never throws for a job's failure - the failure is a row and a result.
 */
export async function tick(now: Date, workerId: string, jobs: readonly ScheduledJob[] = JOBS): Promise<TickResult[]> {
  await abandonStaleRuns(now, jobs);
  const results: TickResult[] = [];
  for (const job of jobs) {
    const windowStart = windowStartFor(now, job.intervalMinutes);
    let runId: string;
    try {
      const run = await db.workerRun.create({ data: { job: job.name, windowStart, workerId, startedAt: now } });
      runId = run.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        results.push({ job: job.name, windowStart, outcome: 'skipped', detail: 'this window already has a run' });
        continue;
      }
      throw error;
    }
    try {
      const summary = (await runWithTimeout(job, now)).slice(0, 1000);
      const taken = await finishRun(runId, { status: 'succeeded', summary });
      results.push({ job: job.name, windowStart, outcome: taken ? 'succeeded' : 'failed', detail: taken ? summary : 'finished after being abandoned; the result was discarded' });
    } catch (error) {
      const message = redactError(error).message.slice(0, 1000);
      await finishRun(runId, { status: 'failed', error: message });
      results.push({ job: job.name, windowStart, outcome: 'failed', detail: message });
    }
  }
  return results;
}

/** Pure: which jobs have not succeeded inside twice their interval (one missed window is tolerated; a job that has never succeeded is overdue). */
export function overdueJobs(lastSuccess: ReadonlyMap<string, Date | null>, now: Date, jobs: readonly ScheduledJob[] = JOBS): string[] {
  return jobs.filter((job) => {
    const last = lastSuccess.get(job.name) ?? null;
    if (!last) return true;
    return now.getTime() - last.getTime() > 2 * job.intervalMinutes * 60_000;
  }).map((job) => job.name);
}

export interface WorkerHealth {
  ok: boolean;
  overdue: string[];
  /** Whether any run has ever been recorded - a deployment with no worker started yet says so. */
  everRan: boolean;
}

/** What the health check reports about scheduled work: never a summary, never an error text - names and a boolean. */
export async function workerHealth(now: Date = new Date(), jobs: readonly ScheduledJob[] = JOBS): Promise<WorkerHealth> {
  const latest = await db.workerRun.groupBy({ by: ['job'], where: { status: 'succeeded', job: { in: jobs.map((j) => j.name) } }, _max: { startedAt: true } });
  const lastSuccess = new Map<string, Date | null>(latest.map((row) => [row.job, row._max.startedAt]));
  const overdue = overdueJobs(lastSuccess, now, jobs);
  const everRan = (await db.workerRun.findFirst({ select: { id: true } })) !== null;
  return { ok: overdue.length === 0, overdue, everRan };
}

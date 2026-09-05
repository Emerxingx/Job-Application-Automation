/**
 * Stage 24 (ADR-0038) - the worker: `npm run worker`.
 *
 * One long-running process that ticks the scheduler every minute. It runs
 * the sweeps that were operator commands (freshness, the analytics
 * rollups, the retention sweep and due erasures, case retention, the
 * limiter's expired buckets) on leased windows, so a second worker or a
 * restart never doubles a window (two workers share the windows between
 * them; neither is idle). Every job is bounded by its own timeout. Stops on
 * SIGTERM/SIGINT after the current tick, or after a bounded drain if a job
 * is still running - then exits non-zero so the platform records it. Logs
 * one line per run with counts; never a value about a person.
 * `WORKER_TICK_SECONDS` (default 60, minimum 5) and `WORKER_ONCE=1` (one
 * tick, then exit; non-zero if any job failed - what a platform cron or a
 * test calls) are the only knobs.
 */
import { hostname } from 'node:os';
import { db } from '@/lib/db';
import { redactError } from '@/lib/log';
import { tick } from '@/lib/ops/scheduler';

const workerId = `${hostname()}:${process.pid}`;
const intervalMs = Math.max(5, Number(process.env.WORKER_TICK_SECONDS ?? '60') || 60) * 1000;
/** How long a stop waits for a tick in flight before exiting anyway. */
const DRAIN_MS = 30_000;
let stopping = false;
let inTick = false;

async function runTick(): Promise<number> {
  if (inTick) return 0;
  inTick = true;
  let failed = 0;
  try {
    const results = await tick(new Date(), workerId);
    for (const r of results) {
      if (r.outcome === 'skipped') continue;
      const line = `[worker] ${r.job} ${r.windowStart.toISOString()} ${r.outcome}: ${r.detail}`;
      if (r.outcome === 'failed') {
        failed += 1;
        console.error(line);
      } else console.log(line);
    }
  } catch (error) {
    // The scheduler itself could not reach the database: say so (redacted) and try again next tick.
    failed += 1;
    console.error(`[worker] tick failed: ${redactError(error).message}`);
  } finally {
    inTick = false;
  }
  return failed;
}

async function main() {
  console.log(`[worker] ${workerId} started; tick every ${intervalMs / 1000}s`);
  if (process.env.WORKER_ONCE === '1') {
    const failed = await runTick();
    await db.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
  await runTick();
  const timer = setInterval(() => void runTick(), intervalMs);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    // Let a tick in flight finish, but not forever: a job past its timeout
    // is already recorded as failed, and a hung one must not hold the
    // process open until the platform kills it (review H1).
    const deadline = Date.now() + DRAIN_MS;
    while (inTick && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const clean = !inTick;
    await db.$disconnect().catch(() => undefined);
    console.log(clean ? '[worker] stopped' : `[worker] stopped with a tick still in flight after ${DRAIN_MS / 1000}s; its run is recorded as abandoned by the next tick`);
    process.exit(clean ? 0 : 1);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((error) => {
  console.error(`[worker] ${redactError(error).message}`);
  process.exit(1);
});

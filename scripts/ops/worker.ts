/**
 * Stage 24 (ADR-0038) - the worker: `npm run worker`.
 *
 * One long-running process that ticks the scheduler every minute. It runs
 * the sweeps that were operator commands (freshness, the analytics
 * rollups, the retention sweep and due erasures, case retention, the
 * limiter's expired buckets) on leased windows, so a second worker or a
 * restart never doubles a run. Stops cleanly on SIGTERM/SIGINT after the
 * current tick. Logs one line per run with counts; never a value about a
 * person. `WORKER_TICK_SECONDS` (default 60) and `WORKER_ONCE=1` (one tick,
 * then exit - what a platform cron or a test calls) are the only knobs.
 */
import { hostname } from 'node:os';
import { db } from '@/lib/db';
import { tick } from '@/lib/ops/scheduler';

const workerId = `${hostname()}:${process.pid}`;
const intervalMs = Math.max(5, Number(process.env.WORKER_TICK_SECONDS ?? '60') || 60) * 1000;
let stopping = false;
let inTick = false;

async function runTick() {
  if (inTick) return;
  inTick = true;
  try {
    const results = await tick(new Date(), workerId);
    for (const r of results) {
      if (r.outcome === 'skipped') continue;
      const line = `[worker] ${r.job} ${r.windowStart.toISOString()} ${r.outcome}: ${r.detail}`;
      if (r.outcome === 'failed') console.error(line);
      else console.log(line);
    }
  } catch (error) {
    // The scheduler itself could not reach the database: say so and try again next tick.
    console.error(`[worker] tick failed: ${error instanceof Error ? error.message : 'error'}`);
  } finally {
    inTick = false;
  }
}

async function main() {
  console.log(`[worker] ${workerId} started; tick every ${intervalMs / 1000}s`);
  if (process.env.WORKER_ONCE === '1') {
    await runTick();
    await db.$disconnect();
    return;
  }
  await runTick();
  const timer = setInterval(runTick, intervalMs);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    // Let a tick in flight finish (a run half-done is marked abandoned later otherwise).
    while (inTick) await new Promise((r) => setTimeout(r, 200));
    await db.$disconnect();
    console.log('[worker] stopped');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

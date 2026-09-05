/**
 * Stage 24 (ADR-0038) - operations against the database: the shared
 * rate-limit store charges one counter for every instance and stays exact
 * under concurrency; the scheduler leases a window once however many
 * workers tick, records a failure as a row, abandons a run that never
 * finished, and the health check says when scheduled work is overdue; a
 * break-glass session is recorded before it opens.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type RateLimit = typeof import('../src/lib/rate-limit');
type Scheduler = typeof import('../src/lib/ops/scheduler');
type Health = typeof import('../src/app/(app)/api/health/route');

const S = randomBytes(4).toString('hex');
let db: Db;
let rl: RateLimit;
let scheduler: Scheduler;
let health: Health;

describe('Stage 24 - the shared rate-limit store, the scheduler and the health check against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    rl = await import('../src/lib/rate-limit');
    scheduler = await import('../src/lib/ops/scheduler');
    health = await import('../src/app/(app)/api/health/route');
  });

  after(async () => {
    delete process.env.RATE_LIMIT_STORE;
    rl.resetRateLimits();
    await db.rateLimitBucket.deleteMany({ where: { id: { startsWith: `ops${S}` } } });
    await db.workerRun.deleteMany({ where: { job: { startsWith: `ops_${S}` } } });
    await db.auditLog.deleteMany({ where: { entityType: 'BreakGlass', entityId: `INC-${S}` } });
    await db.$disconnect();
  });

  it('with RATE_LIMIT_STORE=postgres, N callers share ONE counter and exactly `limit` requests pass under concurrency', async () => {
    process.env.RATE_LIMIT_STORE = 'postgres';
    rl.resetRateLimits();
    const rule = { limit: 5, windowSeconds: 60 };
    const results = await Promise.all(Array.from({ length: 20 }, () => rl.rateLimit(`ops${S}:shared`, 'actor', rule)));
    assert.equal(results.filter((r) => r.ok).length, 5, 'twenty concurrent requests: five pass, whatever their order');
    assert.equal(results.filter((r) => !r.ok).length, 15);
    const row = await db.rateLimitBucket.findUniqueOrThrow({ where: { id: rl.bucketId(`ops${S}:shared`, 'actor') } });
    assert.equal(row.count, 20, 'every request charged the one row');
    const refused = await rl.rateLimit(`ops${S}:shared`, 'actor', rule);
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60);
    // A fresh window starts when the old one has ended.
    await db.rateLimitBucket.update({ where: { id: rl.bucketId(`ops${S}:shared`, 'actor') }, data: { resetAt: new Date(Date.now() - 1000) } });
    const again = await rl.rateLimit(`ops${S}:shared`, 'actor', rule);
    assert.equal(again.ok, true);
    assert.equal(again.remaining, 4);
    // Another actor is another row.
    assert.equal((await rl.rateLimit(`ops${S}:shared`, 'other', rule)).remaining, 4);
    delete process.env.RATE_LIMIT_STORE;
    rl.resetRateLimits();
  });

  it('the bucket sweep removes only buckets whose window ended more than a day ago', async () => {
    await db.rateLimitBucket.createMany({ data: [
      { id: `ops${S}:old`, count: 3, resetAt: new Date(Date.now() - 2 * 86_400_000) },
      { id: `ops${S}:recent`, count: 3, resetAt: new Date(Date.now() - 3_600_000) },
    ] });
    await rl.sweepRateLimitBuckets();
    assert.equal(await db.rateLimitBucket.count({ where: { id: `ops${S}:old` } }), 0);
    assert.equal(await db.rateLimitBucket.count({ where: { id: `ops${S}:recent` } }), 1);
  });

  it('a window is leased once: five concurrent ticks run the job exactly once, a second tick in the same window skips, the next window runs again', async () => {
    let runs = 0;
    const job = { name: `ops_${S}_once`, intervalMinutes: 60, timeoutMinutes: 5, run: async () => { runs += 1; return `ran ${runs}`; } };
    const now = new Date('2026-09-05T13:47:00Z');
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => scheduler.tick(now, `w${i}`, [job])));
    const flat = results.flat();
    assert.equal(flat.filter((r) => r.outcome === 'succeeded').length, 1);
    assert.equal(flat.filter((r) => r.outcome === 'skipped').length, 4);
    assert.equal(runs, 1);
    const later = await scheduler.tick(new Date('2026-09-05T13:59:00Z'), 'w9', [job]);
    assert.equal(later[0]!.outcome, 'skipped');
    const next = await scheduler.tick(new Date('2026-09-05T14:01:00Z'), 'w9', [job]);
    assert.equal(next[0]!.outcome, 'succeeded');
    assert.equal(runs, 2);
    const rows = await db.workerRun.findMany({ where: { job: job.name }, orderBy: { windowStart: 'asc' } });
    assert.deepEqual(rows.map((r) => [r.windowStart.toISOString(), r.status, r.summary]), [['2026-09-05T13:00:00.000Z', 'succeeded', 'ran 1'], ['2026-09-05T14:00:00.000Z', 'succeeded', 'ran 2']]);
  });

  it('a job that outlives its timeout is recorded as timed out, the tick moves on, and its late success is discarded (review H1)', async () => {
    let release: (() => void) | undefined;
    const slow = { name: `ops_${S}_slow`, intervalMinutes: 60, timeoutMinutes: 1 / 600, run: () => new Promise<string>((resolve) => { release = () => resolve('late'); }) }; // 100 ms timeout
    const after = { name: `ops_${S}_after`, intervalMinutes: 60, timeoutMinutes: 5, run: async () => 'ran after the slow one' };
    const now = new Date('2026-09-05T16:10:00Z');
    const results = await scheduler.tick(now, 'w1', [slow, after]);
    assert.equal(results[0]!.outcome, 'failed');
    assert.match(results[0]!.detail, /timed out after/);
    assert.equal(results[1]!.outcome, 'succeeded', 'the next job still ran');
    release!();
    await new Promise((r) => setTimeout(r, 50));
    const row = await db.workerRun.findFirstOrThrow({ where: { job: slow.name } });
    assert.equal(row.status, 'failed', 'the late success did not overwrite the timeout');
    assert.match(row.error ?? '', /timed out/);
  });

  it('a failing job is a failed row with the redacted error, never a thrown tick; an abandoned run is marked failed after its timeout', async () => {
    const job = { name: `ops_${S}_fail`, intervalMinutes: 60, timeoutMinutes: 5, run: async () => { throw new Error('provider said no for jane@example.com'); } };
    const now = new Date('2026-09-05T15:10:00Z');
    const [r] = await scheduler.tick(now, 'w1', [job]);
    assert.equal(r!.outcome, 'failed');
    assert.equal(r!.detail, 'provider said no for [redacted-email]');
    const row = await db.workerRun.findFirstOrThrow({ where: { job: job.name } });
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'provider said no for [redacted-email]');
    // A run that never finished (the worker died) is abandoned once it is older than the timeout.
    const stale = { name: `ops_${S}_stale`, intervalMinutes: 60, timeoutMinutes: 5, run: async () => 'never' };
    await db.workerRun.create({ data: { job: stale.name, windowStart: new Date('2026-09-05T15:00:00Z'), workerId: 'dead', startedAt: new Date('2026-09-05T15:01:00Z') } });
    assert.equal(await scheduler.abandonStaleRuns(new Date('2026-09-05T15:04:00Z'), [stale]), 0, 'inside the timeout it is still running');
    assert.equal(await scheduler.abandonStaleRuns(new Date('2026-09-05T15:07:00Z'), [stale]), 1);
    const abandoned = await db.workerRun.findFirstOrThrow({ where: { job: stale.name } });
    assert.equal(abandoned.status, 'failed');
    assert.match(abandoned.error ?? '', /abandoned/);
  });

  it('the health check reports scheduled work as overdue with a fixed word, and current once every job has succeeded recently', async () => {
    const jobs = [
      { name: `ops_${S}_h1`, intervalMinutes: 60, timeoutMinutes: 5, run: async () => 'ok' },
      { name: `ops_${S}_h2`, intervalMinutes: 60, timeoutMinutes: 5, run: async () => 'ok' },
    ];
    const now = new Date();
    let h = await scheduler.workerHealth(now, jobs);
    assert.equal(h.ok, false);
    assert.deepEqual(h.overdue, jobs.map((j) => j.name));
    await scheduler.tick(now, 'w1', jobs);
    h = await scheduler.workerHealth(new Date(now.getTime() + 60_000), jobs);
    assert.equal(h.ok, true);
    assert.deepEqual(h.overdue, []);
    h = await scheduler.workerHealth(new Date(now.getTime() + 3 * 3_600_000), jobs);
    assert.equal(h.ok, false, 'three hours later, both are overdue');
    // The public body: the worker check exists, with a fixed word and no name or count.
    health.resetHealthMemo();
    const res = await health.GET(new Request('http://localhost/api/health', { headers: { 'x-forwarded-for': '203.0.113.24' } }));
    const body = (await res.json()) as { checks: Record<string, { ok: boolean; detail: string }> };
    assert.ok(['current', 'overdue', 'never ran'].includes(body.checks.worker!.detail), body.checks.worker!.detail);
    assert.ok(['shared', 'local', 'degraded'].includes(body.checks.rateLimitStore!.detail));
    assert.ok(!JSON.stringify(body).includes(`ops_${S}`), 'no job name leaks');
  });

  it('a break-glass session is recorded before it opens and when it closes, by a staff address only, with the ticket on both rows and never a credential (review M5)', async () => {
    const { openBreakGlass, closeBreakGlass, BreakGlassError } = await import('../src/lib/ops/break-glass');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', STAFF_EMAILS: 'ops@example.ca' };
    await assert.rejects(openBreakGlass({ actor: 'someone@else.example', reason: 'x', ticket: `INC-${S}` }, env), BreakGlassError);
    await assert.rejects(openBreakGlass({ actor: 'ops@example.ca', reason: '', ticket: `INC-${S}` }, env), /required BEFORE/);
    const { id } = await openBreakGlass({ actor: 'OPS@example.ca', reason: 'database recovery\nsecond line', ticket: `INC-${S}` }, env);
    const opened = await db.auditLog.findUniqueOrThrow({ where: { id } });
    assert.equal(opened.actorType, 'staff');
    assert.equal(opened.actorEmail, 'ops@example.ca');
    assert.equal(opened.entityId, `INC-${S}`);
    assert.equal(opened.reason, 'database recovery second line', 'newlines cannot forge a second line');
    await assert.rejects(closeBreakGlass({ openedId: id, summary: '' }), /--summary is required/);
    const closed = await closeBreakGlass({ openedId: id, summary: 'Invoice restored from dump; 0 rows changed' });
    assert.equal(closed.ticket, `INC-${S}`);
    const rows = await db.auditLog.findMany({ where: { entityType: 'BreakGlass', entityId: `INC-${S}` }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(rows.map((r) => r.action), ['ops.break_glass.opened', 'ops.break_glass.closed'], 'one query by ticket returns the pair');
    assert.ok(rows.every((r) => !/postgres|DATABASE_URL/.test(r.after)));
  });
});

/**
 * Stage 24 (ADR-0038) - production readiness, statically and purely: the
 * configuration check judges shapes and never prints a value; the smoke
 * suite reads a deployment the way an anonymous client would; the
 * scheduler's windows and overdue rule are pure; every rate-limit call site
 * awaits the (now async) limiter; the health check reports the worker and
 * the limiter store; the operator commands exist; the CSP nonce reaches
 * every response.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkEnvironment } from '../src/lib/ops/env-check';
import { runSmoke } from '../src/lib/ops/smoke';
import { JOBS, overdueJobs, windowStartFor } from '../src/lib/ops/scheduler';
import { rateLimitStoreName } from '../src/lib/rate-limit';
import { v1Params } from '../src/lib/integrations/http';
import { CSP_BASE_DIRECTIVES, SECURITY_HEADERS, contentSecurityPolicy } from '../security-headers.mjs';

const root = path.join(__dirname, '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

const PRODUCTION: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'a'.repeat(20) + 'b'.repeat(20),
  PAYLOAD_SECRET: 'c'.repeat(20) + 'd'.repeat(20),
  NEXT_PUBLIC_APP_URL: 'https://app.example.ca',
  TRUSTED_PROXY_HOPS: '1',
  DATABASE_URL: 'postgresql://postgres.abc:password@aws-0-ca-central-1.pooler.example:6543/postgres?pgbouncer=true',
  DIRECT_URL: 'postgresql://postgres.abc:password@aws-0-ca-central-1.pooler.example:5432/postgres',
  PAYLOAD_DATABASE_URI: 'postgresql://postgres.abc:password@aws-0-ca-central-1.pooler.example:5432/payload',
  STORAGE_PROVIDER: 's3',
  STORAGE_S3_ENDPOINT: 'https://s3.ca-central-1.amazonaws.com',
  STORAGE_S3_REGION: 'ca-central-1',
  STORAGE_S3_BUCKET: 'b',
  STORAGE_S3_ACCESS_KEY_ID: 'k',
  STORAGE_S3_SECRET_ACCESS_KEY: 's',
  STAFF_EMAILS: 'ops@example.ca',
  RATE_LIMIT_STORE: 'postgres',
  JOB_PROVIDER: 'adzuna',
};

describe('Stage 24 - the configuration check', () => {
  it('passes a production-shaped environment and prints no value', () => {
    const report = checkEnvironment(PRODUCTION);
    const fails = report.findings.filter((f) => f.status === 'FAIL');
    assert.deepEqual(fails, [], JSON.stringify(fails));
    assert.equal(report.ok, true);
    const text = JSON.stringify(report);
    for (const secret of ['password@', 'aaaaaaaaaa', 'cccccccccc', 'STORAGE_S3_SECRET_ACCESS_KEY: s', 'pooler.example']) assert.ok(!text.includes(secret), `a value leaked: ${secret}`);
  });

  it('fails the shapes that would break or expose production, each with a reason in words', () => {
    const cases: [string, Partial<NodeJS.ProcessEnv>, RegExp][] = [
      ['NODE_ENV', { NODE_ENV: 'development' }, /guards/],
      ['AUTH_SECRET', { AUTH_SECRET: 'dev-only-secret-change-me-in-production-0123456789' }, /placeholder/],
      ['AUTH_SECRET ≠ PAYLOAD_SECRET', { PAYLOAD_SECRET: PRODUCTION.AUTH_SECRET }, /same value/],
      ['NEXT_PUBLIC_APP_URL', { NEXT_PUBLIC_APP_URL: 'http://app.example.ca' }, /https/],
      ['NEXT_PUBLIC_APP_URL', { NEXT_PUBLIC_APP_URL: 'https://localhost:3000' }, /loopback/],
      ['DIRECT_URL', { DIRECT_URL: PRODUCTION.DATABASE_URL }, /transaction pooler/],
      ['DATABASE_URL and DIRECT_URL role', { DIRECT_URL: 'postgresql://other:password@aws-0-ca-central-1.pooler.example:5432/postgres' }, /different roles/],
      ['PAYLOAD_DATABASE_URI', { PAYLOAD_DATABASE_URI: 'file:./payload.db' }, /SQLite/],
      ['PAYLOAD_DATABASE_URI', { PAYLOAD_DATABASE_URI: PRODUCTION.DIRECT_URL }, /same database/],
      ['STORAGE_S3_REGION', { STORAGE_S3_REGION: 'us-east-1' }, /residency/],
      ['STORAGE_PROVIDER=s3', { STORAGE_S3_BUCKET: '' }, /incomplete/],
      ['STAFF_EMAILS', { STAFF_EMAILS: 'ops@example.ca, demo@jobpilot.ai' }, /demo account/],
      ['MAILBOX_CONNECTOR', { MAILBOX_CONNECTOR: 'mock' }, /refused/],
      ['RATE_LIMIT_STORE', { RATE_LIMIT_STORE: 'redis' }, /not "memory" or "postgres"/],
      ['TRUSTED_PROXY_HOPS', { TRUSTED_PROXY_HOPS: 'two' }, /whole number/],
      ['MAILBOX_ENCRYPTION_KEY', { MAILBOX_ENCRYPTION_KEY: 'short' }, /32/],
      ['PAYMENT_PROVIDER=stripe', { PAYMENT_PROVIDER: 'stripe' }, /unset/],
    ];
    for (const [name, override, reason] of cases) {
      const report = checkEnvironment({ ...PRODUCTION, ...override });
      const finding = report.findings.find((f) => f.name === name && f.status === 'FAIL');
      assert.ok(finding, `${name} should FAIL for ${JSON.stringify(override)}: ${JSON.stringify(report.findings.filter((f) => f.name === name))}`);
      assert.match(finding.detail, reason);
      assert.equal(report.ok, false);
    }
  });

  it('warns, never fails, on the single-instance shapes', () => {
    const report = checkEnvironment({ ...PRODUCTION, RATE_LIMIT_STORE: '', REDIS_URL: '', STORAGE_PROVIDER: 'local', JOB_PROVIDER: 'mock' });
    assert.equal(report.ok, true);
    for (const name of ['RATE_LIMIT_STORE', 'REDIS_URL', 'STORAGE_PROVIDER', 'JOB_PROVIDER']) assert.equal(report.findings.find((f) => f.name === name)?.status, 'WARN', name);
    assert.equal(rateLimitStoreName({ NODE_ENV: 'test', RATE_LIMIT_STORE: 'Postgres ' }), 'postgres');
    assert.equal(rateLimitStoreName({ NODE_ENV: 'test' }), 'memory');
  });
});

describe('Stage 24 - the smoke suite', () => {
  const csp = contentSecurityPolicy('AbCdEfGhIjKlMnOpQrStUv==', false);
  const headers = () => ({ 'content-security-policy': csp, 'cache-control': 'no-store', ...Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value])) });
  const good = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const h = headers();
    if (url.pathname === '/api/health') return new Response(JSON.stringify({ status: 'degraded', checks: { database: { ok: true, detail: 'reachable' }, marts: { ok: false, detail: 'stale' } } }), { status: 200, headers: h });
    if (url.pathname === '/login') return new Response('<html><body><main>sign in</main></body></html>', { status: 200, headers: h });
    if (url.pathname === '/dashboard') return new Response(null, { status: 307, headers: { ...h, location: 'http://x/login?next=%2Fdashboard' } });
    if (url.pathname === '/api/agents' || url.pathname === '/api/definitely-not-a-route') return new Response(JSON.stringify({ error: 'Authentication required.' }), { status: 401, headers: h });
    if (url.pathname === '/api/v1/recommendations') return new Response(JSON.stringify({ error: { type: 'authentication_error', code: 'unauthorized', message: 'x' } }), { status: 401, headers: h });
    if (url.pathname === '/api/auth/logout' && init?.method === 'POST') return new Response(JSON.stringify({ error: 'Cross-site request refused.' }), { status: 403, headers: h });
    if (url.pathname === '/admin') return new Response('<html></html>', { status: 200, headers: h });
    if (url.pathname.startsWith('/definitely-not-a-page-')) return new Response(null, { status: 307, headers: { ...h, location: `http://x/login?next=${encodeURIComponent(url.pathname)}` } });
    return new Response('<html>not found</html>', { status: 404, headers: h });
  }) as unknown as typeof fetch;

  it('passes a deployment that behaves', async () => {
    const checks = await runSmoke('https://app.example.ca/', good);
    const failed = checks.filter((c) => !c.ok);
    assert.deepEqual(failed, [], JSON.stringify(failed));
    assert.equal(checks.length, 9 + SECURITY_HEADERS.length + 2);
    assert.match(checks.find((c) => c.name === 'health')!.detail, /degraded \(marts: stale\)/);
  });

  it('fails a deployment that is open, unpoliced, or down, and says which check', async () => {
    const open = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/api/agents') return new Response('[]', { status: 200 });
      if (url.pathname === '/api/auth/logout' && init?.method === 'POST') return new Response('{}', { status: 200 });
      if (url.pathname === '/login') return new Response('<main></main>', { status: 200, headers: { 'content-security-policy': "script-src 'unsafe-inline'" } });
      return good(input, init);
    }) as unknown as typeof fetch;
    const checks = await runSmoke('https://app.example.ca', open);
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.includes('unauthenticated API answers 401'));
    assert.ok(failed.includes('cross-site write refused'));
    assert.ok(failed.includes('header Content-Security-Policy'));
    assert.ok(failed.includes('header Strict-Transport-Security'));
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const dark = await runSmoke('https://app.example.ca', down);
    assert.ok(dark.every((c) => !c.ok) && dark.some((c) => c.detail === 'no answer inside 10 s'));
  });
});

describe('Stage 24 - the scheduler, purely', () => {
  it('aligns windows to the epoch so every worker computes the same lease key', () => {
    assert.equal(windowStartFor(new Date('2026-09-05T13:47:12Z'), 60).toISOString(), '2026-09-05T13:00:00.000Z');
    assert.equal(windowStartFor(new Date('2026-09-05T13:47:12Z'), 6 * 60).toISOString(), '2026-09-05T12:00:00.000Z');
    assert.equal(windowStartFor(new Date('2026-09-05T13:47:12Z'), 24 * 60).toISOString(), '2026-09-05T00:00:00.000Z');
    assert.equal(windowStartFor(new Date('2026-09-05T13:47:12Z'), 0).toISOString(), '2026-09-05T13:47:00.000Z', 'a zero interval is treated as one minute');
  });

  it('a job is overdue when it never succeeded or when its last success is older than twice its interval', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const jobs = [
      { name: 'a', intervalMinutes: 60, timeoutMinutes: 5, run: async () => '' },
      { name: 'b', intervalMinutes: 60, timeoutMinutes: 5, run: async () => '' },
      { name: 'c', intervalMinutes: 60, timeoutMinutes: 5, run: async () => '' },
    ];
    const last = new Map<string, Date | null>([
      ['a', new Date('2026-09-05T10:30:00Z')], // 90 minutes: one missed window, tolerated
      ['b', new Date('2026-09-05T09:30:00Z')], // 150 minutes: overdue
    ]);
    assert.deepEqual(overdueJobs(last, now, jobs), ['b', 'c']);
  });

  it('every registered job has a name, a positive interval, a timeout shorter than a day, and a run function', () => {
    const names = new Set<string>();
    for (const job of JOBS) {
      assert.ok(job.name && !names.has(job.name));
      names.add(job.name);
      assert.ok(job.intervalMinutes >= 60 && job.timeoutMinutes > 0 && job.timeoutMinutes <= 24 * 60, job.name);
      assert.equal(typeof job.run, 'function');
    }
    for (const expected of ['freshness', 'analytics_rollup', 'retention_sweep', 'cases_retention', 'rate_limit_buckets']) assert.ok(names.has(expected), expected);
  });
});

describe('Stage 24 - what the live smoke run found', () => {
  it('a static v1 route whose params promise resolves to undefined (Next 16 production) is not a 500', async () => {
    assert.deepEqual(await v1Params({ params: Promise.resolve(undefined as unknown as Record<string, string>) }), {});
    assert.deepEqual(await v1Params(undefined), {});
    assert.deepEqual(await v1Params({ params: Promise.resolve({ applicationId: 'a%20b' }) }), { applicationId: 'a b' });
  });
});

describe('Stage 24 - wiring', () => {
  it('every rate-limit call site awaits the limiter (a forgotten await would read `.ok` off a Promise)', () => {
    const files = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f) && f !== 'src/lib/rate-limit.ts');
    const offenders: string[] = [];
    for (const f of files) {
      read(f).split('\n').forEach((line, i) => {
        if (/\brateLimit\(/.test(line) && !/await rateLimit\(|import |return rateLimit\(/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
    assert.match(read('src', 'lib', 'rate-limit.ts'), /export async function rateLimit\(/);
    assert.match(read('src', 'lib', 'rate-limit.ts'), /ON CONFLICT \("id"\) DO UPDATE/, 'the shared store is one atomic upsert');
  });

  it('the health check reports the worker and the limiter store with fixed words, and the operator commands exist', () => {
    const route = read('src', 'app', '(app)', 'api', 'health', 'route.ts');
    assert.match(route, /workerHealth\(\)/);
    assert.match(route, /checks: \{ database, migrations, cache, rateLimitStore, storage, jobSources, marts, worker \}/);
    assert.match(route, /operational = serving && storage\.ok && jobSources\.ok && marts\.ok && worker\.ok/);
    assert.ok(!/detail: `\$\{/.test(route));
    const pkg = read('package.json');
    for (const script of ['"worker"', '"env:check"', '"smoke"', '"ops:break-glass"']) assert.match(pkg, new RegExp(script));
    assert.match(read('scripts', 'ops', 'worker.ts'), /tick\(new Date\(\), workerId\)/);
    assert.match(read('scripts', 'ops', 'break-glass.ts'), /ops\.break_glass\.opened/);
    assert.ok(!/DATABASE_URL|DIRECT_URL/.test(read('scripts', 'ops', 'break-glass.ts')), 'the command holds no credential');
  });

  it('the two operations tables are system-only under RLS and in a manifest', () => {
    const rls = read('src', 'lib', 'tenancy', 'rls-tables.ts');
    assert.match(rls, /RateLimitBucket: \{ kind: 'system' \}/);
    assert.match(rls, /WorkerRun: \{ kind: 'system' \}/);
    assert.match(rls, /migration: '20260905220100_rls_operations', preamble: false, tables: STAGE_24_TABLES/);
  });

  it('the policy is per request and the CSP spec runs in the browser', () => {
    assert.ok(CSP_BASE_DIRECTIVES.length === 4);
    assert.match(read('a11y', 'csp.spec.ts'), /Content Security Policy|Refused to/);
    assert.match(read('.github', 'workflows', 'ci.yml'), /npm run smoke -- http:\/\/127\.0\.0\.1:3000/, 'CI runs the smoke suite against the built app');
  });
});

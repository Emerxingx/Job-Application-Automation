/**
 * Stage 23 (ADR-0037) - the load measurement: `npm run perf:load`.
 *
 * Fires a fixed concurrency of requests at a RUNNING application for a
 * fixed duration per route, signs in once for the authenticated routes, and
 * reports p50 / p95 / p99 / max latency, throughput and the error rate,
 * then compares each route with its budget in
 * `docs/operations/PERFORMANCE_BUDGETS.md` (mirrored in BUDGETS below) and
 * exits 1 when a budget is missed.
 *
 * What this is: a repeatable measurement of THIS build on THIS machine, so
 * a regression shows as a number. What it is not: a statement about
 * production - the numbers in the evidence are labelled local-only, and the
 * managed database, the object store and the network are not in the loop.
 *
 *   PERF_BASE_URL=http://127.0.0.1:3000 PERF_CONCURRENCY=8 PERF_SECONDS=10 npm run perf:load
 */
import { performance } from 'node:perf_hooks';

interface Route {
  path: string;
  auth: boolean;
  /** p95 latency budget in milliseconds, local build. */
  p95Ms: number;
  /** The route is rate-limited by design (the health check: 60/min per address); a 429 is a correct refusal, counted apart from errors. */
  limited?: boolean;
}

/** Keep in step with docs/operations/PERFORMANCE_BUDGETS.md. */
export const BUDGETS: Route[] = [
  { path: '/api/health', auth: false, p95Ms: 300, limited: true },
  { path: '/', auth: false, p95Ms: 500 },
  { path: '/login', auth: false, p95Ms: 500 },
  { path: '/dashboard', auth: true, p95Ms: 1500 },
  { path: '/dashboard/jobs', auth: true, p95Ms: 1500 },
  { path: '/dashboard/applications', auth: true, p95Ms: 1500 },
  { path: '/dashboard/analytics', auth: true, p95Ms: 1500 },
  { path: '/api/agents', auth: true, p95Ms: 500 },
  { path: '/api/account/erasure', auth: true, p95Ms: 300 },
  { path: '/console', auth: true, p95Ms: 2000 },
  { path: '/console/revenue', auth: true, p95Ms: 2000 },
];

const base = process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3000';
const concurrency = Math.max(1, Number.parseInt(process.env.PERF_CONCURRENCY ?? '8', 10) || 8);
const seconds = Math.max(2, Number.parseInt(process.env.PERF_SECONDS ?? '10', 10) || 10);
const email = process.env.PERF_EMAIL ?? 'demo@jobpilot.ai';
const password = process.env.PERF_PASSWORD ?? 'demo1234';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie') ?? '';
  const m = /jobpilot_session=([^;]+)/.exec(cookie);
  if (!m) throw new Error('sign-in returned no session cookie');
  return `jobpilot_session=${m[1]}`;
}

async function hammer(route: Route, cookie: string | null) {
  const latencies: number[] = [];
  let errors = 0;
  let limited = 0;
  let requests = 0;
  const deadline = performance.now() + seconds * 1000;
  const worker = async () => {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      try {
        const res = await fetch(`${base}${route.path}`, { headers: cookie && route.auth ? { cookie, 'sec-fetch-site': 'same-origin' } : {}, redirect: 'manual' });
        await res.arrayBuffer();
        requests += 1;
        if (res.status === 429 && route.limited) limited += 1;
        else if (res.status >= 400 || (route.auth && res.status >= 300)) errors += 1;
      } catch {
        requests += 1;
        errors += 1;
      }
      latencies.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  return { requests, errors, limited, rps: requests / seconds, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies[latencies.length - 1] ?? 0 };
}

async function main() {
  const cookie = BUDGETS.some((r) => r.auth) ? await signIn() : null;
  console.log(`[perf] ${base} · concurrency ${concurrency} · ${seconds}s per route · local build, not production`);
  console.log('route'.padEnd(28), 'req'.padStart(6), 'err'.padStart(5), '429'.padStart(5), 'rps'.padStart(7), 'p50'.padStart(7), 'p95'.padStart(7), 'p99'.padStart(7), 'max'.padStart(7), 'budget'.padStart(8), 'result');
  let failed = 0;
  const rows: Record<string, unknown>[] = [];
  for (const route of BUDGETS) {
    const r = await hammer(route, cookie);
    const ok = r.p95 <= route.p95Ms && r.errors === 0;
    if (!ok) failed += 1;
    rows.push({ ...route, ...r, ok });
    console.log(route.path.padEnd(28), String(r.requests).padStart(6), String(r.errors).padStart(5), String(r.limited).padStart(5), r.rps.toFixed(1).padStart(7), r.p50.toFixed(0).padStart(7), r.p95.toFixed(0).padStart(7), r.p99.toFixed(0).padStart(7), r.max.toFixed(0).padStart(7), `${route.p95Ms}ms`.padStart(8), ok ? 'within budget' : 'OVER BUDGET');
  }
  if (process.env.PERF_JSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.PERF_JSON, JSON.stringify({ base, concurrency, seconds, measuredAt: new Date().toISOString(), rows }, null, 2));
  }
  if (failed > 0) {
    console.error(`[perf] ${failed} route(s) over budget`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

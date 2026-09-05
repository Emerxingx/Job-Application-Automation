# Stage 24 - Production deployment and readiness - evidence

Recorded 2026-09-05 on branch `claude/stage-24-production-readiness` (draft
PR, stacked on Stage 23 (PR #35) - 22 (#34) - 21 (#33) - 20 (#32) - 19
(#31) - 18 (#30) - 17 (#29) - 16 (#28) - 15 (#27) - 14 (#26) - 13 (#25) -
12 (#24) - 11 (#23) - 10 (#22) - 09 (#21) - 08 (#20) - 07 (#19) - 06 (#18)
- 05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) - 01 (#13, PARTIAL)). Every
line was run or read; nothing is PASS on the strength of a mock, a skipped
test or a document. This stage's honest centre: **"go live deliberately"
is code, procedure and measurement wherever it can be, and a named action
for a person wherever it cannot - and no production environment exists, so
the exit gate ("live, monitored, rollback-rehearsed") is NOT MET.** Decision
record: ADR-0038. Consolidated verdict: `RELEASE_VERDICT.md`.

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 24: production infrastructure per ADR-0015;
blue/green or canary; runbooks; on-call; monitoring, alerting, SLOs; status
page; support process; production smoke suite; production secret
management; least-privilege access; audited break-glass; rollback
rehearsal. Acceptance: every gate in `PRODUCTION_READINESS_GATES.md`
passes. Exit: live, monitored, rollback-rehearsed.

## 2. What was built - `PASS` (engineering)

| Item | Where | Proof |
| --- | --- | --- |
| Scheduler with leased runs | `src/lib/ops/scheduler.ts`, `scripts/ops/worker.ts` (`npm run worker`), `WorkerRun` (system-only) | database test: five concurrent ticks run a window once, the same window skips, the next runs; a failing job is a failed row with the redacted error; an abandoned run is marked after its timeout; `workerHealth` overdue → current → overdue. **Live:** one tick against the seeded database ran all five jobs (§5) |
| Shared rate-limit store | `src/lib/rate-limit.ts` (async; `RATE_LIMIT_STORE=postgres` → `RateLimitBucket`, one atomic upsert), every call site awaited | database test: twenty concurrent callers, exactly five pass, one row charged twenty; a fresh window; another actor another row; the hourly bucket sweep. Static test: no call site without `await` |
| Per-request script policy | `src/proxy.ts` (nonce on the request and every response), `security-headers.mjs` (`CSP_BASE_DIRECTIVES`, `contentSecurityPolicy`) | static test (production never gets an unsafe source; five responses carry it); **live:** `curl -D - /login` shows `script-src 'nonce-…' 'strict-dynamic'`; the browser proof in §4 |
| Configuration check | `src/lib/ops/env-check.ts`, `npm run env:check` | 21 shapes; static test: a production shape passes and prints no value, seventeen broken shapes fail each with a reason, single-instance shapes warn; **live:** §3 |
| Smoke suite | `src/lib/ops/smoke.ts`, `npm run smoke -- <origin>`; CI `accessibility` job runs it against the built app | fake-fetch tests (a behaving deployment passes; an open, unpoliced or dark one fails by name); **live:** §3 - and it found two real defects on its first run |
| Break-glass | `scripts/ops/break-glass.ts`, `npm run ops:break-glass`, `ops.break_glass.opened|closed` | database test: the row before, the row after, the ticket and reason, no credential |
| Runbooks | `DEPLOYMENT.md` (rewritten: the deploy sequence), `docs/operations/RUNBOOKS.md`, `SLOS.md`, `ROLLBACK.md`, `BREAK_GLASS.md`, `SUPPORT.md`; `DEPLOYMENT_ARCHITECTURE.md` updated | each says what is rehearsed; rollback rehearsed (§6) |
| Migrations | `20260905220000_operations`, `20260905220100_rls_operations` (generated) | CI applies to an empty database; coverage and determinism tests |

## 3. The smoke suite and the configuration check, live

`npm run smoke -- http://127.0.0.1:3000` against the BUILT, STARTED Stage
24 application on the seeded local database:

| Run | Result | What it found |
| --- | --- | --- |
| 1 | 16 / 18 | **`/api/v1/recommendations` answered 500 to an anonymous request**: under Next 16's production server a static route's `params` promise resolves to `undefined`, and `v1Params` called `Object.entries` on it. Every anonymous v1 request was a 500. The in-process contract suite builds its own `args` and could not see it. Fixed (`?? {}`), tested. **An unknown page answered 307 to sign-in**, which is deny-by-default working before routing; the check had expected 404 and was corrected |
| 2 | **18 / 18** | health `degraded (worker: never ran)` before the first tick, `ok` after; every header; the nonce policy with no unsafe source; the page redirect; 401 on an API and on an unknown API path; the v1 envelope; the CSRF refusal; the CMS up; an unknown page gated |

`npm run env:check` on the local development shape: 8 FAIL, 9 WARN, exit
1, no value printed. On a production-shaped configuration of placeholder
values: 21 checks, 0 FAIL, 6 WARN (the two optional keys, the three mock
providers, the cache), exit 0, no value printed. Both outputs are in the
build log; neither contains a connection string or a secret.

## 4. The browser proof: WCAG and the nonce policy

`npm run a11y` (Playwright + axe-core, Chromium) against the running app,
with `a11y/csp.spec.ts` added: 15 pages (public, candidate, console and the
CMS admin) loaded with the browser console watched for any
`Content Security Policy` report.

| Run | Result | What it found |
| --- | --- | --- |
| 1 | 57 / 58 | every CSP page clean - the public pages, the candidate pages, the console AND the Payload admin at `/admin` run under `script-src 'nonce-…' 'strict-dynamic'` with no violation reported; **one WCAG failure on `/console/revenue`**: the cohort-retention grid's strongest tint (`bg-success/25` under `text-success`, 3.83:1). The Stage 23 run had passed this page because the mart was empty; the worker's first tick (§5) filled it. A defect that depends on data, found because the run followed a real tick |
| 2 | **58 / 58** | tints capped at 10 % (4.8:1 measured) and the strongest band of each colour bold, so the scale does not rely on colour alone |

Fifteen pages carry the nonce policy in the browser without a single
`Content Security Policy` console report. NOT covered: the dark theme,
interactions axe cannot drive, a page that adds an inline script in the
future (it must read `x-nonce`).

## 5. The worker, live

`WORKER_ONCE=1 npm run worker` against the seeded database, one tick:

```
[worker] freshness 2026-09-05T18:00:00.000Z succeeded: employer: ok (checked 0, closed 0); mock: ok (checked 0, closed 0)
[worker] analytics_rollup 2026-09-05T00:00:00.000Z succeeded: 7 platform jobs (612 rows), candidates: 0 rows
[worker] retention_sweep 2026-09-05T00:00:00.000Z succeeded: sessions 0, ai runs 0, rollup runs 0, mailbox refs 0, mart rows 0, erasures 0, file purges retried 0
[worker] cases_retention 2026-09-05T00:00:00.000Z succeeded: 0 organisation(s) with a policy: 0 notes, 0 assessments, 0 closed cases (0 rows under them)
[worker] rate_limit_buckets 2026-09-05T20:00:00.000Z succeeded: 0 expired bucket(s) removed
```

`/api/health` before: `degraded`, `worker: never ran`. After: `ok`,
`worker: current`, `marts: fresh`. Five `WorkerRun` rows, all `succeeded`,
each with a summary of counts and no error.

## 6. Rollback, rehearsed locally

`ROLLBACK.md`: the pre-migration dump (56 migrations) restored into a
fresh database with grants and the tenant and sensitive paths proven; the
new code's `migrate status` names exactly the two Stage 24 migrations as
pending; the previous version's tenant-path suites pass against the
rolled-back database (17 / 17). NOT rehearsed: on the provider, with PITR,
at production size.

## 7. Performance - the health row re-measured

`npm run perf:load` (concurrency 8, 8 s per route, local build, local
database) after the Stage 23 review fix that keeps a 429 out of the
percentiles. The health row now measures the sixty answers per minute the
limiter admits, served from the ten-second memo:

| Route | req | err | 429 | rps | p50 ms | p95 ms | p99 ms | budget p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/health` | 3999 | 0 | 3939 | 500 | 16 | 60 | 69 | 300 |
| `/` | 891 | 0 | 0 | 111 | 70 | 88 | 107 | 500 |
| `/login` | 1720 | 0 | 0 | 215 | 37 | 46 | 55 | 500 |
| `/dashboard` | 634 | 0 | 0 | 79 | 101 | 118 | 128 | 1500 |
| `/dashboard/jobs` | 734 | 0 | 0 | 92 | 87 | 102 | 132 | 1500 |
| `/dashboard/applications` | 788 | 0 | 0 | 99 | 81 | 94 | 102 | 1500 |
| `/dashboard/analytics` | 347 | 0 | 0 | 43 | 184 | 208 | 268 | 1500 |
| `/api/agents` | 2027 | 0 | 0 | 253 | 31 | 39 | 44 | 500 |
| `/api/account/erasure` | 2849 | 0 | 0 | 356 | 22 | 29 | 36 | 300 |
| `/console` | 459 | 0 | 0 | 57 | 139 | 173 | 190 | 2000 |
| `/console/revenue` | 319 | 0 | 0 | 40 | 200 | 241 | 320 | 2000 |

11 / 11 within budget, 0 errors, with the per-request nonce policy and the
async limiter in the path. **Local numbers**; production is NOT measured.

## 8. Gates

| Gate | Result |
| --- | --- |
| `npm run lint:ci` | 0 errors, 8 warnings (baseline 8) |
| `npx tsc --noEmit` | 0 errors |
| `npm test` (CI=true, both URLs on `jobpilot_test23`, 58 migrations) | 1322 / 1322, 0 skipped (20 new: 12 static and pure in `operations-static`, 6 database in `operations`, 1 on `v1Params`, 1 in the storage paging) |
| `npm run build` | exit 0 (worktree with its own dependencies) |
| `npm run smoke` | 18 / 18 |
| `npm run a11y` | 58 / 58 (42 WCAG pages + 15 CSP pages + the sign-in setup) |
| `npm run env:check` | production shape: 0 FAIL; development shape: 8 FAIL, exit 1 |
| Migration rehearsal | 58 on an empty database in CI; rollback to 56 rehearsed locally |

## 9. The readiness gates, re-measured

`PRODUCTION_READINESS_GATES.md`: response headers PARTIAL → PASS (nonce
policy, browser-verified); rate limiting PARTIAL → PASS (shared store,
opt-in); background processing FAIL → PARTIAL (a scheduler, not a queue);
monitoring & alerting FAIL → PARTIAL (rules defined, nothing connected);
SLOs FAIL → PARTIAL (proposed); rollback FAIL → PARTIAL (local); DR plan
PARTIAL (two scenarios rehearsed); health checks PARTIAL (worker and store
added; no queue); runbooks PARTIAL (indexed; no on-call). **G4 has no FAIL
left. The overall bar is not met**, and every reason is named.

## 10. What is NOT done, stated

- No production environment, no deploy, no canary, no CDN, no monitor, no
  alert, no status page, no on-call, no support address: the founder's
  actions in `RELEASE_VERDICT.md`.
- The provider's PITR; a production-size restore; production latency and
  Core Web Vitals; the mobile app on a device.
- A queue with retries and a dead-letter queue (ADR-0011); the audit hash
  chain (unwired columns).
- The staging rehearsal (R-34); the Supavisor isolation proof.
- The penetration test (PEN-TEST); the consent wording (L-5); the
  jurisdiction answers (L-4); the taxonomy licences (L-2); every live
  integration.

## 11. Independent review

Pending; recorded here and in `AUTONOMOUS_STATUS.json` when processed.

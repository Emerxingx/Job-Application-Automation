# ADR-0038 — Production readiness: a scheduler with leased runs, a shared rate-limit store, a per-request script policy, a configuration check, a smoke suite, runbooks and rehearsed rollback — and no production environment

**Status:** Accepted (Stage 24, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 24; readiness gates G1–G7 re-measured; R-16 closed as a mechanism · **Depends on:** ADR-0005 (RLS: the two new tables are system-only), ADR-0011 (background processing — this is the minimum of it, not the queue it describes), ADR-0015 (residency, checked by `env:check`), ADR-0017 (the Next 16 edge gate carries the policy), ADR-0037 (every hardening control this stage operates) · **Does not decide:** where to deploy, who is on call, the RPO/RTO, the status-page provider — founder decisions, listed in `RELEASE_VERDICT.md`

## Context

The plan's last stage is "go live deliberately": production infrastructure,
blue/green or canary, runbooks, on-call, monitoring, alerting, SLOs, a
status page, a support process, a production smoke suite, production
secret management, least-privilege access, audited break-glass, a rollback
rehearsal. Its exit gate is "live, monitored, rollback-rehearsed".

This programme cannot reach a production environment: none has been
provisioned, the staging project is unreachable from the build environment
(`CLAUDE.md` item 8), no credential for any external service exists here,
and nobody is on call. So this stage builds every part of "go live
deliberately" that is code, procedure or measurement, rehearses what can be
rehearsed locally, and states the rest as the founder's actions. It does
not go live, and the consolidated verdict says so.

## Decision

1. **A scheduler exists, and it leases windows rather than locking.**
   `src/lib/ops/scheduler.ts` registers the sweeps that were operator
   commands (job-source freshness every six hours; the analytics rollups,
   the retention sweep with due erasures, and case retention daily; the
   limiter's expired buckets hourly) and `npm run worker` ticks it every
   minute. A run is claimed by inserting a `WorkerRun` row for
   (job, window start aligned to the epoch): the unique index is the lease,
   so N workers or a restart can never run one window twice; a run that
   never finished is marked abandoned after its job's timeout and the next
   window runs normally. No `pg_advisory_lock`: the runtime connection is
   the transaction pooler, where a session lock is exactly the leak
   `DEPLOYMENT_ARCHITECTURE.md` warns about. It is NOT a queue: no per-item
   work, no retry policy beyond the next window, no dead-letter queue.
   Gate G4 "background processing" is PARTIAL, not PASS. `/api/health`
   reports `worker` as `current`, `overdue` or `never ran`.

2. **The rate limiter has a shared store, opt-in.** `rateLimit` is async;
   with `RATE_LIMIT_STORE=postgres` every instance charges one row per
   bucket × actor in `RateLimitBucket` through one atomic upsert, so the
   ceiling is the platform's (R-16). Unset, the in-process map applies,
   correct for one instance. If the shared store cannot be reached the
   request is limited per instance and the degradation is logged once —
   never failing open, never refusing everyone because a counter table
   blinked. A static test refuses a call site that forgot the `await`.

3. **`script-src` is a per-request nonce, set by the edge gate.**
   `src/proxy.ts` draws 128 random bits per request, puts the full policy
   (the Stage 23 base directives plus `script-src 'nonce-…' 'strict-dynamic'`)
   on the REQUEST so Next stamps the nonce on every script it emits, and on
   every RESPONSE the gate returns (page, redirect, 401, 403). The policy
   left the static header list because a static header cannot carry a
   per-request value; `security-headers.mjs` now exports the base
   directives and the builder, and the static test, the smoke suite and
   the proxy read the same module. Production never gets `'unsafe-eval'`
   or `'unsafe-inline'`. A Playwright spec loads the public, candidate,
   console AND CMS-admin pages with the browser console watched and fails
   on any policy report — that is the only proof a script policy can have.

4. **The configuration is checked before every deploy, and no value is
   ever printed.** `npm run env:check` (`src/lib/ops/env-check.ts`) judges
   shapes: production `NODE_ENV`; both secrets generated and distinct; the
   encryption keys 32 bytes and distinct; an https origin; the pooler and
   session URLs of the same role and database; a separate PostgreSQL
   database for the CMS; S3 in a residency region with a complete
   configuration; no demo account among staff; no mock mailbox connector;
   the limiter and cache stores. Every finding is a name, PASS/WARN/FAIL
   and a sentence. It is the first step of the deploy sequence
   (`DEPLOYMENT.md` §0), which is now written against the code as it is.

5. **A smoke suite proves a deployment is serving and safe, without a
   credential.** `npm run smoke -- <origin>` (`src/lib/ops/smoke.ts`)
   reads the health words, every security header and the nonce policy, the
   deny-by-default gate (a page redirects, an API answers 401, an unknown
   API path is 401 not 404), the two error envelopes, the CSRF refusal, the
   CMS being up, and that an unknown page is a 404 without a stack trace.
   CI runs it against the built app on every push.

6. **Runbooks are written and rehearsed where they can be.**
   `docs/operations/RUNBOOKS.md` indexes them; `ROLLBACK.md` records a
   local rehearsal (a pre-migration dump restored, the new code seeing
   exactly the two migrations pending, the previous version's tenant path
   green on the rolled-back database); `SLOS.md` proposes objectives and
   states eleven alert rules a hosted monitor can implement from
   `/api/health` and the request log; `BREAK_GLASS.md` with
   `npm run ops:break-glass` writing an audit row before and after a direct
   session; `SUPPORT.md` with tiers and rules. No monitor is connected, no
   alert has fired, no status page exists, nobody is on call.

7. **The seed and the readiness gates say what production means.** The
   seed never creates the demo account in production (Stage 23 review);
   `PRODUCTION_READINESS_GATES.md` is re-measured row by row; the
   consolidated release verdict (`docs/programme/RELEASE_VERDICT.md`)
   lists every external action and answers the founder's question in one
   line.

## Consequences

- Two operator commands become scheduled work; the operator commands stay
  for a worker that is down.
- Every `rateLimit` caller awaits; a new route that forgets is a red build.
- `security-headers.mjs` no longer ships a CSP header statically;
  the proxy is the one place the policy exists. A page that adds an inline
  script must read the nonce from the `x-nonce` request header.
- Two system-only tables (`RateLimitBucket`, `WorkerRun`) and two
  migrations (57, 58).
- Readiness gates: G2 response headers PARTIAL → PASS (nonce policy,
  browser-verified); G2/G4 rate limiting PARTIAL → PASS (mechanism; opt-in);
  G4 background processing FAIL → PARTIAL; monitoring and SLOs FAIL →
  PARTIAL (defined, not connected); rollback FAIL → PARTIAL (local); G7
  runbooks PARTIAL (on-call still absent). Nothing moves to PASS on the
  strength of a document.

## Not done, stated

- No production environment, no deploy, no canary, no CDN, no monitor, no
  status page, no on-call, no support address: founder actions.
- The provider's PITR, a production-size restore, production latency and
  Core Web Vitals: NOT MEASURED.
- A queue with retries and a dead-letter queue (ADR-0011); the audit hash
  chain (columns exist, unwired).
- The staging rehearsal (R-34) and the Supavisor isolation proof.
- The penetration test (external), the consent wording (L-5), the
  jurisdiction answers (L-4), every live integration.

## Alternatives considered

- **`pg_advisory_lock` for the scheduler** — rejected: a session lock
  through the transaction pooler binds to whichever backend the pool hands
  out next (the Stage 01 finding); a lease row is pooler-safe.
- **A Redis-backed limiter** — rejected for now: `ioredis` is deliberately
  not a dependency and the database the deployment already has gives an
  atomic counter; the interface admits a Redis store later.
- **`'unsafe-inline'` with hashes instead of a nonce** — rejected: Next's
  bootstrap changes per build and per page; hashes would be a moving
  allow-list nobody maintains.
- **Declaring the stage BLOCKED and building nothing** — rejected: most of
  "go live deliberately" is code and procedure that must exist before any
  environment can be used deliberately; the parts that need the
  environment are named, not simulated.

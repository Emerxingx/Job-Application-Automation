# Deployment Architecture

**Residency:** `../adr/ADR-0015-data-residency.md` · **CI:** `../adr/ADR-0018-ci-quality-gates.md`

## Current state
`DEPLOYMENT.md` is the deploy sequence against the code as it is (Stage 24,
ADR-0038): `env:check` → backup → `db:migrate:deploy` → roll → `smoke` →
worker. Measured reality: CI on every push (verify, mobile, generated files,
line endings, accessibility with the smoke suite and the CSP browser proof,
SBOM); runbooks indexed in `../operations/RUNBOOKS.md` and rehearsed locally
where they can be; **no production environment, no monitor, no on-call, no
status page** - the founder's actions in `../programme/RELEASE_VERDICT.md`.

## Target topology (founder stage)
```
        ┌──────────────┐
        │   CDN/Edge   │
        └──────┬───────┘
        ┌──────▼────────────────────────────┐
        │  Next.js app (web + API + CMS)    │  ← one deployable
        └──────┬─────────────────┬──────────┘
               │                 │
     ┌─────────▼──────┐   ┌──────▼─────────┐
     │ Worker process │   │ Managed Redis  │
     │ (same codebase)│   │ (cache + rate  │
     └─────────┬──────┘   │  limiting)     │
               │          └────────────────┘
     ┌─────────▼──────────────────────────┐
     │  Managed PostgreSQL — CANADA        │
     │  app schemas · payload db · pgvector│
     └─────────┬───────────────────────────┘
     ┌─────────▼───────────────────────────┐
     │  S3-compatible object storage — CA  │
     └─────────────────────────────────────┘
```

Deliberately **not** in scope: Kubernetes, service mesh, multi-region active-active,
per-product databases.

## Connection pooling — recorded decision, with tenancy implications

The pooling mode is an architectural decision because it determines whether RLS
tenancy context can leak between requests (`ADR-0005`).

| Mode | Tenancy-context semantics | Position |
| --- | --- | --- |
| **Direct connection** | Session-level `SET` is safe; connection count does not scale | Migrations and workers only |
| **Session-mode pooler** | A connection is held for the client's session; a session-level `SET` persists and **can bind to a later user** if the client is reused | Not used for request traffic without transaction-scoped context |
| **Transaction-mode pooler** | A connection is returned to the pool per transaction; only `SET LOCAL` **inside the transaction** is safe | **Intended default for request traffic**, with transaction-scoped context mandatory |

**Selection — recorded in Stage 01 (2026-09-03).** The application runs against
the **transaction-mode pooler** (`DATABASE_URL`, port 6543, `?pgbouncer=true`);
migrations run against the **session-mode endpoint** (`DIRECT_URL`, port 5432).
Both endpoints of the staging project were verified by shape from the
provisioned credentials without reading their values: the pooler host is in
`ca-central-1`, the ports and the `pgbouncer=true` parameter match the modes
above. Tenant context is established only with `set_config(name, value, TRUE)`
inside the query's own transaction, plus `SET LOCAL ROLE app_tenant`
(`src/lib/tenancy/context.ts`).

Evidence for the pooled runtime, honestly bounded:

| Proof | Pooler | Result |
| --- | --- | --- |
| `tests/tenancy-isolation.test.ts` (real Prisma client, migrated schema, filters removed, connection reuse asserted by backend PID, 40 concurrent cross-tenant requests) | Direct PostgreSQL 16 (CI service) | pass, every push |
| Same suite plus the membership and session suites | **PgBouncer 1.22, `pool_mode = transaction`, `default_pool_size = 4`** (local, 2026-09-03) | 28/28 pass |
| Same, followed by the raw mechanism proof, all through the same pooler | PgBouncer transaction mode | 22/22 pass |
| Same suite through **Supavisor on the staging project** | — | **NOT RUN** — the build environment cannot open a TCP connection to the pooler (egress policy). This remains the open half of the `ADR-0005` gate |

A finding from the pooled run, recorded because it is exactly the leak class
`ADR-0005` warns about: the raw mechanism proof (which deliberately uses
session-level `SET ROLE` and `SET search_path` on its own connection) leaked
that session state **across processes** through the transaction pooler into a
concurrently running test, whose unqualified raw query then resolved the wrong
schema. Prisma's own queries are schema-qualified and unaffected; the one raw
query in the suite was qualified in response. The application never sets
session-level state.

Consequences carried into implementation:
- Every request path sets tenancy context with `SET LOCAL` inside the transaction
  that runs the query, via a Prisma interactive transaction.
- Workers and migrations use a direct connection under a narrow, audited
  RLS-bypassing role, unreachable from any request path.
- Changing the pool mode, the pooler, or the Prisma major version **re-runs the
  Stage 01 pooled-runtime isolation proof** before deployment.

## Environments
`local` (PostgreSQL 16, mocks) → `preview` (per-PR, seeded) → `staging`
(Supabase `job-application-automation-staging`, Canada Central, real sandbox
credentials) → `production`. SQLite is no longer an option for the
transactional store at any tier.

## Deployment requirements
- Migrations run as a **separate, gated step** before the application rolls —
  never implicitly at boot.
- Blue/green or canary with a rehearsed rollback.
- Secrets from a managed secret store; never in the repository.
  `AUTH_SECRET` and `PAYLOAD_SECRET` must be distinct generated values, and the
  application already refuses the `.env.example` placeholder in production.
- Health endpoints for app, database, cache, queue depth and each connector.

## Scale limits to remove before production
| Limit | Impact | Stage |
| --- | --- | --- |
| SQLite | No RLS, no concurrent writes | 01 |
| No migrations | No reproducible schema | 01 |
| In-process rate limiting | Ceiling × instance count | **Removed in 24** (`RATE_LIMIT_STORE=postgres`, opt-in) |
| In-process cache | Invalidation does not propagate | 01 (Redis, optional; not shared until `REDIS_URL` is set) |
| Local filesystem storage | Artefacts lost on restart | 05 (S3 provider; `env:check` warns on `local`) |
| No workers | Everything on the request path | **Reduced in 24** (`npm run worker`: the sweeps on leased windows; scans are still synchronous) |

## Operational readiness (Stage 24)
Runbooks (written, indexed) · on-call (NONE) · monitoring and alerting
(rules defined, no monitor connected) · SLOs (proposed) · status page (NONE)
· incident response (written, never exercised) · restore from backup
(rehearsed locally, twice) · rollback (rehearsed locally) · RPO/RTO
(proposed) · production smoke suite (built, runs in CI against the built
app). Each is a gate in `../programme/PRODUCTION_READINESS_GATES.md` with
its honest status.

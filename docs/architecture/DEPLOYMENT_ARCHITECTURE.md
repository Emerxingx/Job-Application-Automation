# Deployment Architecture

**Residency:** `../adr/ADR-0015-data-residency.md` · **CI:** `../adr/ADR-0018-ci-quality-gates.md`

## Current state
`DEPLOYMENT.md` documents the intended deployment. Measured reality: **no CI, no
production environment, no runbooks, no on-call, no status page.** The
application builds cleanly (exit 0, ~79 routes) and boots with zero configuration.

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

## Environments
`local` (SQLite acceptable, mocks) → `preview` (per-PR, seeded) → `staging`
(production-like, real sandbox credentials) → `production`.

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
| In-process rate limiting | Ceiling × instance count | 01 |
| In-process cache | Invalidation does not propagate | 01 (Redis) |
| Local filesystem storage | Artefacts lost on restart | 05 |
| No workers | Everything on the request path | 01/05 |

## Operational readiness (Stage 24)
Runbooks · on-call · monitoring and alerting · SLOs · status page · incident
response · **rehearsed restore from backup** · documented RPO/RTO · production
smoke suite. None exists today; each is a gate in
`../programme/PRODUCTION_READINESS_GATES.md`.

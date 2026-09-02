# ADR-0002 — Operational database: PostgreSQL with versioned migrations

**Status:** Proposed · **Date:** 2026-09-02

## Context
Measured at `35d3491`:
- `datasource db { provider = "sqlite" }` — the transactional store is SQLite.
- **`prisma/migrations/` does not exist.** The workflow is `prisma db push`.
- Payload's CMS uses a **second, separate SQLite file**.
- A source comment says to change the provider for production. Prisma's
  `provider` is **not** env-switchable, so this is an unversioned manual edit.

Consequences today: no schema history, no rollback, no deterministic
reproduction of a schema state, no concurrent-write story, and no RLS — SQLite
has none, which blocks `ADR-0005` outright.

## Options
- **A. Stay on SQLite.** Zero cost. Cannot support RLS, concurrent writes,
  pgvector, or multi-tenant isolation. Disqualifying.
- **B. PostgreSQL, self-managed.** Full capability, full operational burden.
- **C. PostgreSQL, managed (Supabase, Canada Central).** Full capability, managed
  backups, PITR, connection pooling, RLS, pgvector.

## Decision
**Option C.** PostgreSQL as the single transactional system of record, managed,
in a Canadian region (`ADR-0015`), with **versioned Prisma migrations** replacing
`db push`.

The existing schema is baselined as migration `0001` — it is not rewritten. The
68 existing models and 670 passing tests are preserved.

Payload keeps its **own logical database** on the same managed PostgreSQL
instance, preserving the separation of lifecycles the current design chose
deliberately.

## Consequences
- `prisma db push` and `db:reset` are removed from the production path and
  restricted to local development.
- SQLite-specific assumptions must be audited during the port — chiefly implicit
  type coercion and the absence of native `Json`/array types. Prisma abstracts
  most of this; the JSON-as-text columns (`scoreBreakdown`, `matchedKeywords`,
  `modelParameters`) become real `Json` columns.
- pgvector becomes available, unblocking semantic retrieval (`ADR-0006`) without
  a separate vector database.
- RLS becomes available, unblocking `ADR-0005`.
- Every future schema change ships as a reviewable, reversible migration.
- **Do not create multiple physical databases prematurely.** Logical schemas
  inside one PostgreSQL instance are the boundary mechanism.

## Revisit when
Write throughput or dataset size exceeds a single managed instance — expected
first in `job_postings` and `job_snapshots`, addressed by partitioning before
sharding.

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
- Every future schema change ships as a **versioned, reviewed migration with a
  deterministic history**. That is not the same as a reversible one — see the
  standard below.
- **Do not create multiple physical databases prematurely.** Logical schemas
  inside one PostgreSQL instance are the boundary mechanism.

## Production migration standard — versioned is not the same as reversible

**Prisma does not generate down migrations, and a forward migration is not
automatically reversible.** A migration that drops a column or transforms data
cannot be undone by re-running anything; the data is gone. Any wording that
implies otherwise is wrong and must not appear in this repository.

Two distinct properties, never conflated:

| Property | What it means | How it is obtained |
| --- | --- | --- |
| **Versioned / reproducible** | The schema at any commit can be rebuilt deterministically from an ordered, immutable migration history | Prisma migration files, committed and reviewed |
| **Rollback / recovery** | Production can be returned to its prior state after a bad migration | Backup + restore point, tested restore, and a written recovery plan — **never** an assumed down migration |

Every production migration requires:

1. A **versioned** migration file in a deterministic history.
2. **Reviewed migration SQL** — the generated SQL is read by a human, not just the schema diff.
3. A **pre-migration backup or restore point**, taken and verified immediately before execution.
4. A **tested restore procedure** — restore is rehearsed, not assumed (Stage 23).
5. A **forward-fix strategy** as the default remediation path.
6. An **explicit rollback runbook for high-risk migrations**, written before execution.
7. **Data-migration verification** — row counts and integrity checks before and after.
8. **Migration observability** — duration, lock behaviour, and failure surfaced.
9. **Staging rehearsal** for any destructive or high-risk migration, against production-shaped data.

**A migration that destroys or transforms data may not run in production until its
specific recovery strategy is written and its restore path tested.** Expand-and-
contract (add, backfill, verify, then drop in a later migration) is the preferred
pattern precisely because it keeps a recovery window open.

## Revisit when
Write throughput or dataset size exceeds a single managed instance — expected
first in `job_postings` and `job_snapshots`, addressed by partitioning before
sharding.

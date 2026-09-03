# Database migrations — workflow, review standard, recovery

Stage 01 replaced `prisma db push` with a versioned Prisma migration history
(`ADR-0002`). This page is the operating procedure. It states what is
rehearsed and what is not; nothing here is a claim of having been performed
against the staging project until the evidence section says so.

## The history

| Migration | What it does | Reversible? |
| --- | --- | --- |
| `20260903071600_baseline` | The 67 tables of the pre-Stage-01 schema, generated with `prisma migrate diff --from-empty`, **unchanged in semantics**: same columns, defaults, nullability, uniques, indexes and foreign-key actions as the SQLite schema declared. JSON-as-text columns stay text (see "deliberately not done") | Additive on an empty database. Not reversible once data exists (drop = data loss) |
| `20260903071914_tenancy_identity` | `Organization.type` and `Organization.aiProcessingPolicy` (default `EXTERNAL_AI_PROHIBITED`), `User.emailVerifiedAt` / `passwordChangedAt`, new `Session`, `UserIdentity`, `ConsentRecord` tables, and a hand-written, idempotent **backfill** giving every existing user a personal organisation and owner membership | Additive. Forward-fix: delete the backfilled rows by id prefix (`org_personal_`, `mem_personal_`) |
| `20260903073000_row_level_security` | **Generated** from `src/lib/tenancy/rls-tables.ts` by `scripts/rls/generate-migration.ts`: the `app_tenant` role, context accessor functions, `ENABLE` + `FORCE ROW LEVEL SECURITY` on all 70 tables, one named `system_full_access` policy per table for the migration role, tenant policies per classification, and revocation of Supabase's REST-gateway grants where those roles exist | Reversible by design (policies and role can be dropped without touching data). A test proves the file matches the generator |

| `20260903081338_candidate_digital_twin` | Eleven Digital Twin tables with classification comments, and a hand-written PL/pgSQL **backfill** from `Resume.content` (idempotent, tolerant, reports counts as a NOTICE). Expand phase: the JSON column stays as a projection | Additive. Forward-fix: `DELETE FROM "CandidateProfile" WHERE source = 'resume_backfill'` and re-run |
| `20260903081500_sensitive_schema` | `sensitive` schema, `app_sensitive` role, `sensitive.self_identification` (RESTRICTED), forced RLS, grants to the sensitive role only (ADR-0007). **No Prisma model** — Prisma's drift check ignores this schema by design. **Written idempotently**: a SQL-only migration outside `public` must be, because the shadow-database reset clears only the schemas Prisma manages | Reversible (drop schema) — destroys the answers; export first |
| `20260903081400_rls_candidate_tables` | Generated policies for the Stage 02 tables (manifest `RLS_MANIFESTS[1]`); deliberately ordered BEFORE the sensitive schema so the new tables are never granted-but-unpolicied across a migration boundary | Reversible |
| `20260903090000_career_evidence_vault` | `CareerEvidence` (versioned, provenance-keyed claims), `ApplicationQuestion`, `AiRun` (references only), `PromptVersion`; classification comments; an idempotent **seed** of the three prompts lifted from `anthropic.ts` at `approved / pending` — never `default` (`AI_GOVERNANCE.md`: no version serves before an evaluation passes) | Additive. Forward-fix for the seed: `DELETE FROM "PromptVersion" WHERE id LIKE 'prompt_%_v1'` |
| `20260903090100_rls_evidence_tables` | Generated policies for the Stage 03 tables (manifest `RLS_MANIFESTS[2]`); `AiRun` is SELECT-only for its subject; `PromptVersion` is `system` kind — the tenant role cannot read prompts | Reversible |
| `20260903090200_evidence_immutability` | `BEFORE UPDATE` trigger on `CareerEvidence`: an approved / superseded / revoked row's claim, facts, kind, source, version, lineage, owner and approval time cannot change; status only moves forward. Idempotent (`CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`) | Reversible (drop trigger + function) |
| `20260903100000_occupational_spine` | Ten `INTERNAL` reference tables for the occupational spine (ADR-0009) and `Job.occupationId` / `occupationSource`; classification comments. No data: loading is a licence-gated operator action, never a migration | Additive. Reversible (drop tables; `Job` columns nullable) |
| `20260903100100_rls_taxonomy_tables` | Generated policies (manifest `RLS_MANIFESTS[3]`): nine `reference` tables (SELECT for every tenant, no write policy); `TaxonomyDataset` is `system` — the register carries who recorded a licence | Reversible |
| `20260903100200_taxonomy_normalised_labels` | `OccupationLabel.normalizedTitle` / `normalizedAlternates` (classifier compares normalised to normalised) and `TaxonomyDataset.publisherTerms` (the publisher's unconfirmed statement, apart from governance notes) | Additive, nullable-by-default; reversible |
| `20260903083000_profile_ownership_keys` | `(id, userId)` unique on `CandidateProfile` and composite `(profileId, userId)` foreign keys on the nine child tables, so a child row cannot carry another user's profile. Generated with `migrate diff --from-migrations` because `migrate dev` refuses unique-constraint warnings non-interactively | Reversible (constraints only) |

`prisma/migrations/migration_lock.toml` pins the provider to PostgreSQL. There
is no SQLite path left: Prisma's provider is not switchable at runtime, and the
tenancy backstop needs RLS, which SQLite does not have.

## Workflow

```bash
# Local development (any PostgreSQL 16; the URLs are in .env.example)
npm run db:migrate           # prisma migrate dev — creates AND applies; needs CREATEDB for the shadow db
npm run db:migrate -- --create-only --name <change>   # generate, then REVIEW the SQL before applying
npm run db:migrate:deploy    # prisma migrate deploy — applies pending migrations, never generates
npm run db:migrate:status    # what is applied / pending / failed
npm run db:reset             # prisma migrate reset --force — LOCAL ONLY: drops and recreates
npm run db:push              # LOCAL ONLY prototyping; never against staging or production
```

Production and staging use **only** `npm run db:migrate:deploy`, run against
`DIRECT_URL` (the session-mode endpoint — migrations need a connection that
survives across statements; the transaction pooler does not guarantee that).
The application itself uses `DATABASE_URL` (transaction pooler, port 6543).

The `db:*` scripts wrap the Prisma CLI in `scripts/db/with-encoded-env.mjs`,
which percent-encodes the password in both variables for the child process
(the CLI reads `DIRECT_URL` raw and rejects a reserved character with "invalid
port number"). `npx prisma …` called directly is not wrapped.

**Role constraint.** The RLS migration creates each table's
`system_full_access` policy `TO current_user` — the role that runs the
migration. `DATABASE_URL` must therefore log in as that same role; a different
application role would have no policy on any forced table and every system
query would return nothing. `tests/tenancy-isolation.test.ts` asserts this
against whichever database it runs on. On Supabase both URLs use
`postgres.<ref>`.

CI (`.github/workflows/ci.yml`) applies the whole history to an empty
PostgreSQL, then fails if the result differs from `prisma/schema.prisma`
(`migrate diff --exit-code`) or if `migrate status` reports anything pending or
failed. That is the "reviewed, reproducible history" property enforced on
every push, not asserted in a document.

## Review standard for every new migration

From `ADR-0002`, restated as the checklist a reviewer works through:

1. **Read the SQL**, not the Prisma diff. Prisma's generated statements are
   usually right and occasionally destructive in ways the diff summary hides
   (a column rename is a DROP and an ADD).
2. **Classify it**: additive (new table/column/index), transforming (backfill,
   type change), or destructive (drop, narrow). Anything but additive needs a
   written recovery note in the migration file itself, as the backfill in
   `tenancy_identity` has.
3. **Prefer expand-and-contract** for anything transforming: add, backfill,
   verify, switch reads, drop later in a separate migration. This keeps a
   recovery window open.
4. **Every new table is classified in `src/lib/tenancy/rls-tables.ts`** and
   listed in a manifest (`RLS_MANIFESTS`) — a new manifest for a new migration,
   rendered with `npx tsx scripts/rls/generate-migration.ts --manifest <dir>`.
   Reclassifying a shipped table means listing it in a NEW manifest (the DDL is
   idempotent), never editing the applied file. The coverage and determinism
   tests fail until this is done, on purpose. Declare the classification as a
   `COMMENT ON TABLE` in the migration.
5. **Lock behaviour**: `ALTER TABLE … ADD COLUMN` with a default is cheap on
   PostgreSQL 11+; adding a `NOT NULL` column without a default, or rewriting
   a type, rewrites the table. Say so in the PR if the table is large.
6. **Restore point before deploy** (below), always.
7. **A migration that creates objects outside `public`** (another schema, a
   role) must be idempotent (`IF NOT EXISTS`, `DROP … IF EXISTS` before
   `CREATE`): Prisma's shadow database is reset by dropping the managed
   schemas only, so such a file can run twice against one shadow database.
8. **`migrate dev` is interactive** and refuses to create a migration that
   adds a unique constraint without a prompt. From a non-interactive shell,
   generate the SQL with
   `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <empty db> --script`
   into a new migration directory, review it, then `db:migrate:deploy`.

## Recovery and forward-fix plan

Prisma has no down migrations; a forward migration is not automatically
reversible. Recovery therefore means one of:

| Situation | Action |
| --- | --- |
| Migration failed part-way (`db:migrate:status` shows a failed migration) | Read the error. If the failing statement is safe to re-run, fix the SQL and `prisma migrate resolve --rolled-back <name>` then deploy again. Prisma wraps each migration in a transaction on PostgreSQL, so a failed migration leaves the schema as it was — verify with `migrate diff` before assuming |
| Migration applied but wrong (bad backfill, wrong default) | **Forward-fix**: a new migration that corrects the data or schema. Never edit an applied migration file; Prisma checksums them and a changed file is a failed history |
| Migration applied and destroyed data | Restore from the pre-migration restore point (Supabase: point-in-time recovery to the timestamp taken immediately before `migrate deploy`), then forward-fix the migration before re-running |
| Need to reproduce a past schema state | `prisma migrate deploy` up to that migration on an empty database — the history is deterministic; the RLS migration is additionally reproducible from its generator |

**Before every staging or production deploy:**
1. Take a restore point and record its timestamp in the deploy note (Supabase
   PITR; on self-managed PostgreSQL, `pg_dump` the database).
2. `prisma migrate status` — nothing failed.
3. `npm run db:migrate:deploy` against `DIRECT_URL`.
4. `npm run db:migrate:check` — no drift.
5. Run `tests/tenancy-isolation.test.ts` against the deployed database
   (`TENANCY_TEST_DATABASE_URL`) — RLS coverage and isolation on the real
   schema.

A **restore rehearsal** — actually restoring a Supabase project to a point in
time and verifying the result — is a Stage 23 gate and has **not** been
performed. It cannot be performed from this build environment (see below).

## Rehearsal record

| Rehearsal | Where | Result |
| --- | --- | --- |
| Full history applied to an empty PostgreSQL 16.13 | Local cluster (`jobpilot_dev`, `jobpilot_test`), 2026-09-03 | Applied; `migrate diff` in both directions reports no difference; `migrate status` clean |
| Backfill exercised with a pre-existing user | Local, 2026-09-03 | A user created before `tenancy_identity` received `org_personal_<id>` / `mem_personal_<id>` with role `owner`, policy `EXTERNAL_AI_PROHIBITED`; re-running is a no-op |
| RLS coverage after the history | Local, 2026-09-03 | 70/70 tables enabled and forced; 128 policies (70 system + 58 tenant); `app_tenant` is NOLOGIN, NOBYPASSRLS, NOSUPERUSER |
| Same history in CI | GitHub Actions `postgres:16` service | Enforced by the three migration-validation steps in `ci.yml` on every push |
| **Against the Supabase staging project** | — | **NOT PERFORMED.** The build environment's egress policy does not relay raw TCP, so neither pooler port (6543, 5432) is reachable; the HTTPS endpoint is policy-denied (403). Recorded in `AUTONOMOUS_STATUS.json` as a blocker with the exact requirement |

**Stage 03 (2026-09-03), local PostgreSQL 16 only.** The three Stage 03
migrations applied to a fresh database (`migrate deploy`, full history) and
incrementally to a Stage-02 database; `migrate diff --from-url … --exit-code`
reports "No difference detected" after both; 85/85 public tables
`ENABLE`+`FORCE`, 157 policies; the trigger is present and
`tests/evidence-vault.test.ts` proves it refuses an edit from the migration
role itself. `20260903090200` was replayed twice into one shadow database
with no error (idempotent). **Not rehearsed on Supabase** (R-34).

**Stage 04 (2026-09-03), local PostgreSQL 16 only.** The two Stage 04
migrations applied fresh and incrementally; drift clean; 95/95 forced. No
data migration: the tables start empty by design. **Not rehearsed on
Supabase** (R-34).

## Deliberately not done in the baseline

`ADR-0002` anticipated converting the JSON-as-text columns (`scoreBreakdown`,
`matchedKeywords`, `modelParameters`, …) to native `Json`. The baseline keeps
them as `TEXT` on purpose: the ADR's own rule is that the existing schema is
baselined *unchanged*, and the conversion changes the Prisma client's types for
every reader of those columns (which all go through `parseJson` today). It is
an expand-and-contract change for a later migration, not a baseline edit.

Likewise, `DateTime` columns are `TIMESTAMP(3)` without time zone — Prisma's
default mapping, storing UTC. Changing to `timestamptz` is a rewrite of 232
columns and is not a Stage 01 concern; it is noted so nobody mistakes the
current mapping for an oversight.

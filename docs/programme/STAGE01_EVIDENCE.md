# Stage 01 — evidence

Every line here is something that was run or read, with where and when. Where
a thing could not be done, it says so. Vocabulary: `PASS` · `PARTIAL` · `FAIL`
· `NOT IMPLEMENTED` · `NOT VERIFIED` · `BLOCKED`.

Recorded 2026-09-03 on branch `claude/stage-01-security-identity-tenancy`
(PR #13). Machine-readable state: `AUTONOMOUS_STATUS.json`.

## 1. The Supabase staging environment — verified by shape, unreachable by network

Read from the environment without printing a value (`node`, regex over the
variable, only structure reported):

| Variable | Present | Scheme | User | Host | Port | Database | Params | Mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | yes | `postgresql` | `postgres.<project ref>` | `aws-0-ca-central-1.pooler.supabase.com` | **6543** | `postgres` | `pgbouncer=true` | **transaction pooler** ✔ |
| `DIRECT_URL` | yes | `postgresql` | `postgres.<project ref>` | `aws-0-ca-central-1.pooler.supabase.com` | **5432** | `postgres` | — | **session pooler** ✔ |
| `SUPABASE_REGION`, `SUPABASE_PROJECT_NAME` | **absent** | | | | | | | the brief listed them; they are not set in this environment |

- Region: the endpoint hostname carries `ca-central-1`. This satisfies the
  "from the connection endpoint" reading of `AUTH_DECISION_GATE.md` §6.5; a
  live `SELECT` from the project was not possible (below). **PARTIAL.**
- Both passwords contain one URL-reserved character, so the values as issued
  are unparseable by Node's `URL`, `pg` and Prisma. `src/lib/db-url.ts`
  percent-encodes them idempotently; `tests/db-url.test.ts` covers it. Not a
  credential defect; recorded so the next person does not lose an hour to it.

**Connectivity — `BLOCKED` (network egress policy):**

| Attempt | Result |
| --- | --- |
| Direct TCP to the pooler host, 5432 and 6543 | timeout (DNS resolves) |
| HTTPS `CONNECT` via the environment's egress proxy to the pooler host, 5432 / 6543 | proxy answers `200 Connection Established`; a PostgreSQL `SSLRequest` never receives a reply (tunnel closed after 36 s); a plain startup message gets `ECONNRESET` |
| Same proxy to `github.com:80` / `:22` | the gateway answers HTTP 400 itself / nothing — it does not relay non-443 TCP at all |
| HTTPS to `<ref>.supabase.co`, `supabase.com`, `api.supabase.com` | `403` on `CONNECT` — organisation egress policy denial |

The proxy's own README lists "raw-TCP databases" under *not supported through
the proxy — report, do not work around*. This was reported, not worked around.
Exact unblock: allow TCP egress from the build environment to
`aws-0-ca-central-1.pooler.supabase.com` on 5432 and 6543 (and HTTPS to the
project host for Auth), **or** run the commands in §8 from a network that has
it, **or** add the two connection strings as GitHub Actions secrets so the
suites run against staging in CI.

## 2. PostgreSQL migration — `PASS` locally and in CI, `NOT VERIFIED` on Supabase

| Item | Evidence |
| --- | --- |
| Provider | `prisma/schema.prisma`: `postgresql`, `url = env("DATABASE_URL")`, `directUrl = env("DIRECT_URL")`; `migration_lock.toml` pins `postgresql` |
| Baseline `20260903071600_baseline` | Generated from the unchanged model set: 67 tables, 148 indexes (47 unique), 86 foreign keys (54 CASCADE, 21 SET NULL, 11 RESTRICT), 232 `TIMESTAMP(3)`, 593 `TEXT`, 160 `INTEGER`, 26 `BOOLEAN`; defaults reviewed (81 `CURRENT_TIMESTAMP`, the string/int defaults the schema declares). No semantic change from the SQLite schema |
| `20260903071914_tenancy_identity` | Reviewed SQL (additive) + hand-written idempotent backfill; exercised with a pre-existing user — received `org_personal_<id>` / `mem_personal_<id>`, role `owner`, `EXTERNAL_AI_PROHIBITED` |
| `20260903073000_row_level_security` | Generated; `tests/rls-migration-determinism.test.ts` proves the committed file equals the generator output |
| Applied to empty PostgreSQL 16.13 | local `jobpilot_dev` and `jobpilot_test`, 2026-09-03 |
| Drift | `migrate diff --from-url … --to-schema-datamodel … --exit-code` → *No difference detected*; `--from-migrations` via shadow database → *No difference detected*; `migrate status` → up to date |
| CI | `ci.yml`: `migrate deploy` → `migrate diff --exit-code` → `migrate status` before lint/typecheck/test/build; the `postgres:16` service is the database for every gate |
| Recovery / forward-fix plan | `docs/operations/DATABASE_MIGRATIONS.md` |
| **On the Supabase project** | **NOT VERIFIED** — §1 |

SQLite-dependent behaviour removed: case-insensitive `contains` on two search
sites now says `mode: 'insensitive'`; six `DESC` sorts on nullable dates got
`nulls: 'last'` (PostgreSQL sorts NULLs first on DESC — drafts would have
crowded the top of the invoice queue); five stale SQLite comments corrected;
Payload's adapter is chosen from `PAYLOAD_DATABASE_URI`'s scheme.

## 3. Schema verification on the migrated database

Checked on the applied schema (local, and asserted by `tests/tenancy-isolation.test.ts` test 1 wherever the suite runs):

| Property | Result |
| --- | --- |
| Tables | 70 in `public` (+ `_prisma_migrations`), all classified in `src/lib/tenancy/rls-tables.ts`; a table missing from the classification, or classified but absent, fails the test |
| Constraints / FKs / indexes / defaults / nullability | identical to the Prisma model (drift check both directions); FK actions as declared |
| Enums | none — the schema uses string columns with documented vocabularies (unchanged from the baseline) |
| Timestamps | `TIMESTAMP(3)` UTC-naive (Prisma default); recorded, not changed |
| RLS | 70/70 `relrowsecurity` and `relforcerowsecurity`; 128 policies (70 `system_full_access` + 58 tenant) |
| Roles | `app_tenant`: `NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER`; granted to the migration role so `SET LOCAL ROLE` works |
| Data compatibility | the backfill ran over pre-existing rows; the seed runs unchanged apart from adding the workspace and consent |

## 4. Tenancy — `Organization` / `Membership` wired

- Every user owns a **personal organisation** (`type = personal`) with an owner
  membership: created at signup inside the same transaction as the user, and
  backfilled for existing users by migration.
- `Organization.type` (closed list) and `Organization.aiProcessingPolicy`
  (default **`EXTERNAL_AI_PROHIBITED`** — the fail-closed state `ADR-0015`
  requires) are on the schema; the Stage 03 gateway reads the latter.
- Membership service (`src/lib/tenancy/organizations.ts`): create, invite,
  accept, change role, remove, `requireMembership()` failing closed. Routes:
  `GET/POST /api/organizations`, `GET/POST/PATCH/DELETE /api/organizations/:id/members`,
  `POST /api/organizations/:id/invitation`.
- Negative tests (`tests/organizations.test.ts`, 12): non-member → 404 (no
  existence disclosure); pending invitation confers nothing; only the invitee
  accepts; member cannot invite; admin cannot grant above own role (no
  self-escalation); only owner changes roles, never own; unknown role refused;
  admin cannot remove admin/owner; last owner cannot be removed; removed member
  loses access at once; personal workspace cannot gain members or lose its
  owner; `personal`/`platform` cannot be created via the API; a stored role
  this code does not recognise satisfies nothing.

## 5. Row-level security — `PASS` on PostgreSQL 16 and through PgBouncer; `NOT VERIFIED` through Supavisor

Policies, generated from the classification (`user` equality, `userOrOrg`,
`org` via a `SECURITY DEFINER` membership accessor, `viaParent` EXISTS,
`custom`, `reference` read-only, `system` deny): see
`prisma/migrations/20260903073000_row_level_security/migration.sql`.

`tests/tenancy-isolation.test.ts` — through the **real Prisma client** on the
**migrated schema** with **application filters removed**, connection pool
capped at one so reuse is deterministic and asserted by `pg_backend_pid()`:

| # | Case | Result |
| --- | --- | --- |
| 1 | every table classified, exists, ENABLE+FORCE | pass |
| 2 | `app_tenant` not superuser, no BYPASSRLS, no LOGIN | pass |
| 3 | cross-tenant **read**: `findMany()` no filter, by primary key, via relation | only own rows / null / own only |
| 4 | cross-tenant **write**: forge insert refused (`row-level security`), update/delete of the other tenant's row match 0, re-parenting own row refused | pass |
| 5 | **missing / malformed** context (`''`, space, quote, `; DROP`, non-ASCII, over-long, undefined, null, number) | refused before the database (`TenantContextError`) |
| 6 | unknown but well-formed context | 0 rows |
| 7 | **connection reuse**: same backend PID, tenant role assumed, no context → 0 rows; B on A's previous connection sees only B; role reverted after the transaction | pass |
| 8 | **parallel**: 40 interleaved A/B requests on a 4-connection pool | each sees only its own rows |
| 9 | **organisation scope**: accepted membership grants, a pending invitation does not, owner of X reads nothing of B's personal data, B cannot write X's roster | pass |
| 10 | reference tables readable, not writable; `AuditLog` / `WebhookEvent` invisible and unwritable | pass |
| 11 | a tenant cannot read or revoke another's `User` row or `Session` | pass |
| 12 | background/system execution is the connection role, with a **named** `system_full_access` policy per table | pass |

Runs:

| Where | Suites | Result |
| --- | --- | --- |
| Local PostgreSQL 16.13, direct | full `npm test` | **754 / 754, 0 skipped** |
| **PgBouncer 1.22, `pool_mode = transaction`, `default_pool_size = 4`**, Prisma URL with `pgbouncer=true` | tenancy + organizations + sessions | **28 / 28** |
| Same pooler, sequentially, then the raw mechanism proof through the same pooler | tenancy + rls-isolation | **22 / 22** |
| CI (`postgres:16` service), head `26813d2` | full `npm test` after `migrate deploy` | **success** — run `33730207735` |
| **Supavisor on the staging project** | — | **NOT VERIFIED** (§1) |

Finding from the pooled run, kept on record: the raw mechanism proof
deliberately uses session-level `SET ROLE` / `SET search_path`; through the
transaction pooler that state leaked **across processes** into a concurrently
running suite and made an unqualified raw query resolve the wrong schema.
That is R-33 §1 observed in the wild. Prisma's queries are schema-qualified and
were unaffected; the suite's one raw query was qualified. The application
never sets session-level state.

## 6. Sessions, identity, consent, audit

| Requirement | Status | Evidence |
| --- | --- | --- |
| Server-side revocable sessions | **PASS** | `Session` rows; cookie JWT carries `sid`; `requireUser()` refuses revoked / expired / password-epoch-stale / missing rows; pre-Stage-01 tokens refused. `tests/session-liveness.test.ts` (7), `tests/sessions.test.ts` (4) |
| Session list and revoke, "sign out everywhere else" | **PASS** | `GET/DELETE /api/auth/sessions`, `DELETE /api/auth/sessions/:id` |
| Password change revokes other sessions | **PASS** | `POST /api/auth/password` re-authenticates, sets `passwordChangedAt`, revokes others |
| User identity linkage to Supabase Auth | **IMPLEMENTED-NOT-VALIDATED** | `UserIdentity`, `src/lib/identity/{supabase,link}.ts`, `POST /api/auth/exchange`; `tests/supabase-identity.test.ts` (11) with locally minted tokens. Refuses unverified-email linkage; 503 when unconfigured |
| Email verification, account recovery, MFA, OAuth | **BLOCKED (CREDENTIAL + EXTERNAL_SERVICE)** | Delivered by Supabase Auth per the ratified decision. Needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_JWT_SECRET`, and HTTPS egress to the project host. The platform carries `assuranceLevel` per session and `emailVerifiedAt` per user so enforcement can be added without a schema change |
| RLS identity context | **PASS (platform)** | Policies key on the platform user id set per transaction; a Supabase subject resolves to that user through `UserIdentity` |
| Consent | **PASS (capture)**, wording **pending counsel** (R-36) | Required checkbox with accessible label; refused server-side without it; `ConsentRecord` per purpose and version; revocable |
| Security audit events | **PASS** | `src/lib/security-audit.ts`: signup, login success/failure (email digest only), logout, session revoke(s), password change, identity linked, consent, organisation events. No secret, token or body ever written |

## 7. Tenant-path adoption in request handlers

`requireTenant()` → `run(tx => …)` is the only way a handler reaches the
`app_tenant` role. Adoption status is in the table below; what is not on the
tenant path is protected by its application filter exactly as before.

**On the tenant path (27 request handlers / pages)** — every direct Prisma
query runs inside `run(tx => …)`; library calls stay outside the transaction;
external calls (AI, payment provider, filesystem, outbound HTTP) are never
held inside one:

| Area | Files |
| --- | --- |
| API — candidate data | `api/resume`, `api/agents`, `api/agents/[id]`, `api/applications/[id]`, `api/applications/[id]/files/[name]`, `api/interview-prep`, `api/profile` |
| API — billing / integrations | `api/billing/checkout` (plan read; provider call outside; activity write), `api/integrations/webhooks`, `api/integrations/webhooks/[id]`, `api/integrations/webhooks/[id]/test`, `api/integrations/deliveries` (GET) |
| Dashboard pages | `dashboard`, `dashboard/jobs`, `dashboard/jobs/[id]`, `dashboard/resume`, `dashboard/agents`, `dashboard/agents/new`, `dashboard/invoices`, `dashboard/billing`, `dashboard/integrations`, `dashboard/applications`, `dashboard/applications/[id]`, `dashboard/interview-prep`, `dashboard/interview-prep/[id]`, `dashboard/documents`, `dashboard/analytics` |

**Still on the system client (application filter only, as before Stage 01):**

| Handler | Why | Path to the backstop |
| --- | --- | --- |
| `api/apply`, `api/applications/[id]/confirm` | go through `applyToJobs` / `confirmAssistedSubmission` (`src/lib/services`) | Stage 12 rework of the apply engine takes a `tx` |
| `api/scan` | scanner service | Stage 05/06 rework |
| `api/integrations/keys`, `keys/[id]`, `connectors`, `connectors/[provider]`, `deliveries` (POST) | `src/lib/integrations/*` service functions | thread a client parameter through the service (Stage 02 housekeeping) |
| `api/invoices`, `invoices/[id]`, `invoices/[id]/pdf` | `src/lib/billing/invoice.ts` | Stage 15 |
| `api/exports/*` | `src/lib/exports/builders.ts` | Stage 13 |
| `onboarding` page | optional user (`getCurrentUser()`) | convert with the Stage 02 profile work |
| `console/**` | staff console — system path **by design** (reads other people's data behind the two-lock gate) | none; stays system |
| `api/webhooks/*`, `api/v1/*`, `api/auth/*`, `api/organizations/*` | signature / API-key / pre-session / membership-service paths — system by design | none |

Net: **27 on the tenant path, 14 user-facing handlers still filter-only, 0
regressions** (every filter kept verbatim; typecheck and lint unchanged).

## 8. Commands to run against the staging project, once reachable

From a network that can open TCP to the pooler (values from the environment;
never paste them):

```bash
npx prisma migrate status                      # DIRECT_URL — expect three pending on a fresh project
npx prisma migrate deploy                      # DIRECT_URL — take a restore point first
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
TENANCY_TEST_DATABASE_URL="$DATABASE_URL" RLS_TEST_DATABASE_URL="$DIRECT_URL" \
  node --import tsx --test tests/tenancy-isolation.test.ts tests/organizations.test.ts tests/sessions.test.ts tests/rls-isolation.test.ts
psql "$DIRECT_URL" -Atc "select current_setting('server_version'), inet_server_addr()"   # region / version, redacted in the record
```

## 9. Regression at the recorded head

| Gate | Result |
| --- | --- |
| `npm run lint:ci` | 0 errors, 8 warnings (baseline) |
| `npx tsc --noEmit` | exit 0 |
| `npm test` (with both database URLs) | 754 / 754, 0 skipped |
| `npm run build` | exit 0, 89 routes |
| `npm audit` | 8 (1 low, 7 moderate, **0 high**) |
| CI on PR #13, head `26813d2` | run [`33730207735`](https://github.com/Emerxingx/Job-Application-Automation/actions/runs/33730207735): **Verify (migrate deploy → drift check → status → lint → typecheck → test → build) success**, Generated-file determinism success, Line-ending policy success; [`33730207748`](https://github.com/Emerxingx/Job-Application-Automation/actions/runs/33730207748) npm audit success |

## 10. Stage 01 exit gate — verdict

| Gate item | Status |
| --- | --- |
| PostgreSQL in use with versioned migrations | **PASS** (local + CI); **NOT VERIFIED** on Supabase |
| Tested restore path | **NOT VERIFIED** — needs the project; Stage 23 rehearsal |
| RLS on every tenant table, proven against the deployed pooled runtime | **PASS** on every table through a transaction-mode pooler locally; **NOT VERIFIED** through Supavisor |
| Authentication decision gate recorded | **PASS** (ratified 2026-09-02) |
| Per-tenant AI policy in the schema | **PASS** (`Organization.aiProcessingPolicy`, fail-closed default) |
| Zero high advisories deployed | **PASS** |
| MFA available | **BLOCKED** (Supabase Auth credentials + egress) |
| Revoked session is dead immediately | **PASS** |
| Cross-tenant read impossible with filters removed in the harness | **PASS** |

**Stage 01: PARTIAL.** Everything that can be built and proven without the
staging project is built and proven. The four items marked `NOT VERIFIED` /
`BLOCKED` all reduce to one cause (§1) and are not closable from this
environment. No item is marked PASS on the strength of a mock, a skipped test
or a document.

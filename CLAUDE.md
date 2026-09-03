# CLAUDE.md — Working guidance for this repository

Read this before changing anything. It records how this codebase actually
behaves, not how it appears to behave.

## What this is
Today: **JobPilot AI**, a Next.js job-application product for the Canadian and US
markets.
Target: a **Career & Employment Intelligence Operating System** — four products
on one governed platform core. See `docs/product/PRODUCT_VISION.md`.

The architecture baseline is in `docs/`. **It is proposed, not approved. No
remediation has begun.**

## Start here
| You want | Read |
| --- | --- |
| Measured state of the code | `docs/programme/CURRENT_BASELINE.md` |
| What is missing and why | `docs/programme/GAP_ANALYSIS.md` |
| What to build, in order | `docs/programme/MASTER_BUILD_PLAN.md` |
| Why a decision was made | `docs/adr/` |
| Prior engineering handoff | `HANDOFF.md` |

## Commands
```bash
npm ci                # install from the lockfile
npm run dev           # http://localhost:3000
npx tsc --noEmit      # typecheck  — PASSES
npm test              # 867 tests  — PASSES with the two database URLs below set; the
                      #   database suites skip WITH A REASON without them and THROW
                      #   when CI=true, so CI cannot pass by skipping them
npm run build         # production — PASSES
npm run lint          # eslint directly — 0 errors, 8 warnings (baseline)
npm run lint:ci       # blocking variant: --max-warnings=8
npm run verify        # lint:ci + typecheck + test + build (the CI gate set)

# The database is PostgreSQL 16 (no SQLite path exists any more). Point both
# at a database that has had `npm run db:migrate:deploy` run against it:
#   tests/rls-isolation.test.ts     — raw mechanism proof (creates its own schema)
#   tests/tenancy-isolation.test.ts — the migrated schema through the real Prisma client
#   tests/organizations.test.ts, tests/sessions.test.ts
RLS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test \
TENANCY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test npm test

npm run db:migrate:deploy  # apply the versioned history (the ONLY production path)
npm run db:migrate         # local: create + apply a migration (needs CREATEDB for the shadow db)
npm run db:migrate:status
npm run db:seed            # plans + demo account (+ its personal workspace and consent)
npm run db:push            # LOCAL prototyping only — never staging or production
npm run cms:importmap      # regenerate the tracked Payload import map
npm run cms:types          # regenerate payload-types.ts
```

## Things that will surprise you

1. **The database is PostgreSQL with a versioned migration history** since
   Stage 01 (`ADR-0002`). Three migrations under `prisma/migrations/`; CI applies
   them to an empty database and fails on drift. `DATABASE_URL` is the
   transaction pooler, `DIRECT_URL` the session endpoint for migrations. The RLS
   migration is **generated** from `src/lib/tenancy/rls-tables.ts` — regenerate
   it, never hand-edit it (a test compares the two). Procedure and recovery:
   `docs/operations/DATABASE_MIGRATIONS.md`.

2. **ESLint was never installed until Stage 00.** The
   `eslint: { ignoreDuringBuilds: true }` leftover in `next.config.mjs` is gone —
   it stopped meaning anything once CI gained a blocking lint job, and Next 16
   warned on it. Lint is configured as **flat config invoking
   `eslint` directly**, never `next lint` (deprecated in Next 15, removed in
   16). Baseline is **0 errors, 8 warnings**, locked by `--max-warnings=8`. The
   one rule exemption — `no-require-imports` for `src/lib/providers/**` — is the
   deliberate lazy-`require` pattern, not debt. The baseline rose from 2 to 8
   when Next 16 brought a stricter ruleset that surfaced six **pre-existing**
   `set-state-in-effect` sites; each was analysed and none is a defect. See
   `docs/programme/LINT_BASELINE.md`.

3. **Many Prisma models still have no application code references.** Some are
   nested-write models genuinely in use (`InvoiceLine`, `PaymentAllocation`,
   `DocumentSequence`). Others are designed-but-unwired — `AgentSchedule` (a
   complete scheduler with no scheduler) is the clearest. Stage 01 wired
   `Organization` / `Membership` (every user owns a personal workspace) and
   `WebhookEvent` (replay and ordering). Check before assuming a model does
   something.

4. **Nothing applies autonomously, and the UI now says so.** `scanner.ts` reads
   `autoApplyThreshold` only to increment a counter, and no scheduler exists
   (`AgentSchedule` has no code that reads it). Stage 00 disabled the auto-apply
   control and corrected the README. **Do not re-enable it** — autonomous
   submission is Stage 22 and is gated on lawfulness review plus an explicit
   founder decision (`ADR-0016`).

5. **There are two databases.** Prisma owns transactional data; Payload owns
   content, in its **own** database (`PAYLOAD_DATABASE_URI`). Deliberate.
   Nothing in the CMS reads or writes a Prisma table. Keep it that way.

6. **Tenant isolation is application filters PLUS row-level security, and the
   backstop only covers the tenant path.** Every table is `ENABLE`+`FORCE` RLS
   with policies for the `app_tenant` role. Request handlers reach that role only
   through `requireTenant()` → `run(tx => …)` (`src/lib/tenancy/request.ts`);
   anything still on the module-level `db` client runs as the system role and
   is protected by its `where: { userId }` filter alone. So: **keep the filter on
   every query, and put user-facing queries inside `run`.** A query on `db` from
   inside a `run` callback silently escapes the transaction — the one mistake
   the design cannot catch mechanically. Never set session-level `SET`; only
   `set_config(…, TRUE)` inside the transaction (R-33).

7. **Sessions are rows.** The cookie is a signed JWT whose `sid` names a
   `Session` row; `requireUser()` refuses a revoked, expired or password-epoch-
   stale row on every request, with no cache. `src/proxy.ts` checks only the
   signature (it cannot reach the database) — it is a gate, not the authority.
   A signature-valid token without `sid` (pre-Stage-01) is refused.

8. **The Supabase staging project is NOT reachable from the Claude build
   environment.** `DATABASE_URL`/`DIRECT_URL` are present and correctly shaped
   (verified without printing them), but the egress proxy relays only HTTPS and
   the pooler needs raw TCP. Never print those variables. Everything that needs
   the real project is tracked as a blocker in `AUTONOMOUS_STATUS.json`; do not
   mark it done on the strength of local PostgreSQL or PgBouncer runs.

9. **Demographic self-identification lives in the `sensitive` PostgreSQL schema
   with NO Prisma model** (ADR-0007, Stage 02). Only `src/lib/sensitive/` may touch
   it, through the `app_sensitive` role; a static test fails if any matching, AI,
   apply, document, analytics or export module references it. Do not add a
   sensitive field to a Prisma model — add it to the SQL migration for that schema.

10. **The career profile is structured** (`CandidateProfile` and ten child
    tables). `Resume.content` is a derived projection during the expand phase:
    write through `src/lib/candidate/profile.ts`, never to the JSON directly.

11. **`npm run cms:*` temporarily rewrites `package.json`.** `scripts/payload-cli.mjs`
   flips `"type": "module"` for the duration of the call and restores it, including
   on Ctrl-C. If a crash leaves it set, `git checkout package.json`.

12. **No integration has been validated against a live service.** Stripe, Adzuna,
    Anthropic, PayPal, ATS submission, **Supabase Auth and the managed PostgreSQL
    itself** are all `IMPLEMENTED-NOT-VALIDATED`. Code existing is not evidence of
    working.

13. **Every model-backed task goes through `src/lib/ai/gateway.ts`** (Stage 03).
    It resolves the tenant's `aiProcessingPolicy` before dispatch (missing →
    `EXTERNAL_AI_PROHIBITED`), refuses payloads carrying a `RESTRICTED` key,
    always runs the deterministic engine, grounds every generated section in
    code against the résumé + approved evidence, and writes an `AiRun` row
    with the exact prompt version. Prompts live in `PromptVersion`
    (`/console/prompts`), not in code and not in the CMS; **no version is
    `default` yet**, so every task is served by the deterministic engine and
    recorded as `deterministic` / `degraded` — that is the fail-closed design,
    not a bug. A static test fails if anything outside the gateway touches
    the SDK or the provider.

14. **Approved evidence is immutable** (`CareerEvidence`): the service refuses
    edits and a database trigger refuses them independently. A correction is
    a new version with `supersedesId`.

15. **The occupational spine is empty until a licence is recorded** (Stage 04,
    ADR-0009). `Occupation` / `OccupationCode` / labels exist, the NOC loader
    and the NOC↔SOC crosswalk are proven on a fixture, but every
    `TaxonomyDataset` is `unrecorded` and `requireIngestible()` refuses to
    load until an admin records the licence and attribution at
    `/console/taxonomy` (L-2). Classification falls back to the old regex
    table and records `regex_fallback` — a low-confidence method, not a match.

## Conventions worth preserving

- **The provider pattern** (`src/lib/providers/`): interface, mock default, lazy
  `require` of real adapters, warn-and-degrade on missing credentials. This is
  why a clean clone boots with no configuration. Extend it; do not replace it.
- **Two error envelopes, deliberately.** Internal routes return
  `{ error: string }`. `/api/v1` returns `{ error: { type, code, message, param } }`
  because a third-party client cannot branch on English. Do not unify them.
- **No CORS on `/api/v1`, deliberately.** An API key is a bearer credential and
  must never reach browser JavaScript.
- **The console two-lock gate**: `STAFF_EMAILS` allowlist **and** `User.role`,
  failing closed, unknown role degrading to the *weakest* staff level. Reuse this
  pattern for any new admin surface.
- **Scrub-in-place erasure.** Personal data is nulled; invoices, payments and
  audit rows are retained and carry their own bill-to snapshot.
- **Security events go to `AuditLog` through `src/lib/security-audit.ts`**, never
  with a secret, a token or a request body; a failed sign-in stores only a digest
  of the address. Match that when adding events.
- **Every new table is classified in `src/lib/tenancy/rls-tables.ts`** before it
  ships; the coverage test fails until it is.
- **In-source commentary explains *why*.** Match that standard.

## Hard rules

1. **Never claim a mock is production.** Update
   `docs/governance/INTEGRATION_REGISTER.md` instead.
2. **No autonomous application submission** (`ADR-0016`).
3. **No unlawful data acquisition** — no CAPTCHA bypass, no access-control
   circumvention, no fingerprint evasion (`docs/governance/SOURCE_ACCESS_POLICY.md`).
4. **No sensitive demographic attribute may reach a matching, scoring, ranking or
   recommendation path** (`ADR-0007`).
5. **Never skip, disable or delete a test to get a green run.** A failing test is
   a finding.
6. **Never run `npm audit fix --force`.** It installs `next@15.5.25`, which is
   outside Payload's peer range. Follow `ADR-0017`.
7. `importMap.js`, `payload-types.ts` and the `row_level_security` migration are
   **generated**. Regenerate them; never hand-edit.
8. **Never print, log or commit `DATABASE_URL` / `DIRECT_URL`.** Diagnostics use
   `describeDatabaseUrl()` (redacted host, port, mode) and nothing else.

9. **Never call a model provider outside `src/lib/ai/gateway.ts`, and never set
   `PromptVersion.deploymentStatus = 'default'` by hand.** Promotion goes through
   `promotePromptVersion`, which refuses until an evaluation has passed
   (`docs/governance/AI_GOVERNANCE.md`).

10. **Never load a taxonomy dataset except through `requireIngestible()`**, and
    never set `TaxonomyDataset.licenceStatus` / `ingestionApproved` by hand
    (`docs/governance/SOURCE_ACCESS_POLICY.md`, ADR-0009).

## Dependency constraint you must know
`@payloadcms/next@3.88.0` declares:
```
next: ">=15.2.9 <15.3.0 || >=15.3.9 <15.4.0 || >=15.4.11 <15.5.0 || >=16.2.6 <17.0.0"
```
Installed: **`next@16.3.4`** — inside the `>=16.2.6 <17.0.0` window. Stage 01
performed this upgrade under `ADR-0017`; it removed every **deployed**
high-severity advisory (14 advisories → 11, high 6 → 3, and the remaining three
are dev-only Prisma chain). **Check this range before any further Next upgrade** —
17.x is outside it.

Two consequences of being on 16.x:
- The edge gate is **`src/proxy.ts`**, not `middleware.ts`. Next 16 deprecated
  the old convention; the handler export is `proxy`. Verified against Next's own
  loader (`(isProxy ? mod.proxy : mod.middleware) || mod.default`).
- `eslint-config-next` is **native flat config**. Do not reintroduce
  `FlatCompat` — passing flat config through it throws a circular-structure error.

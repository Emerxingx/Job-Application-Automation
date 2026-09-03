# Test Strategy

## Current state (measured)

Re-measured 2026-09-03, end of Stage 01. The baseline this document was written
against — 670 tests, no CI, lint never run — is superseded.

| | At the audit | Now |
| --- | --- | --- |
| Tests | 670 | **800+** with a migrated PostgreSQL available (the database suites skip with a reason without one, and throw in CI) |
| Suites | 158 | 180+ |
| Files / lines | 16 / 7,668 | 19 / 8,533 |
| CI | none | 3 jobs, all required (`.github/workflows/ci.yml`) |
| Lint | never run | 0 errors, 8 warnings, blocking at `--max-warnings=8` |

Runner: `node --test` with `tsx`. Added since the audit: webhook replay and
ordering (12), the deny-by-default edge gate (7), and the `ADR-0005` RLS
isolation proof (10, below).

- Coverage is still concentrated in **billing, analytics, integrations and CRM** —
  matching where the code is, not where the product is.
- Thin or absent: auth, matching, applications, jobs, storage.
- **No E2E tests.**

The suite is a genuine asset and the regression guard for the PostgreSQL
migration. It is not evidence that the product works — most of it tests the
commercial layer.

## Layers

| Layer | Scope | Runner | Introduced |
| --- | --- | --- | --- |
| Unit | Pure logic, scoring, tax, dunning, interpolation | `node --test` | **Exists** |
| Component | React components, states, a11y roles | Testing Library | Stage 00 |
| API | Route handlers: auth, validation, error envelopes | `node --test` + fetch | Stage 01 |
| Database | Migrations up/down, constraints, cascades | Postgres service container | Stage 01 |
| **Authorization / RLS** | **Cross-tenant denial per table** | Distinct DB roles | **Stage 01** |
| Integration | Module interactions with real Postgres/Redis | Service containers | Stage 01 |
| Contract | Public API vs OpenAPI | Schema validation | Stage 14 |
| Connector | Every adapter against one shared contract suite | Recorded fixtures + live smoke | Stage 05 |
| **AI evaluation** | Truthfulness, grounding, schema, regression, leakage, consistency | Golden sets | **Stage 03** |
| Document regression | Résumé/cover-letter goldens; ATS parse | Snapshot + parser | Stage 09 |
| E2E | Critical candidate journeys | Playwright | Stage 12 |
| Browser automation | Assisted apply, extension | Playwright | Stage 12 |
| Mobile | Device matrix, offline | Detox / Maestro | Stage 14 |
| Security | Authn/authz, injection, SSRF, upload safety | Automated + manual | Stage 23 |
| Accessibility | WCAG 2.2 AA | axe + manual | Stage 23 |
| Performance | Budgets, load, query plans | k6 | Stage 23 |
| **Backup / restore** | **Rehearsed restore from backup** | Runbook | Stage 23 |
| DR | Failover game day | Runbook | Stage 23 |
| Production smoke | Post-deploy critical paths | CI | Stage 24 |

## The two non-negotiable suites

**1. Negative authorization (Stage 01).** For every tenant-scoped table: prove
user A cannot read user B's row — **with application filters removed in the
harness**, so the test exercises RLS specifically. Without this, tenant isolation
is an assertion rather than a property.

*Progress:* **both halves are done.** The mechanism: `tests/rls-isolation.test.ts`,
10 assertions against a real PostgreSQL in CI. The per-table half:
`tests/tenancy-isolation.test.ts` runs through the real Prisma client on the
migrated schema with application filters removed — every table classified and
forced, cross-tenant read and write, missing/malformed context, connection
reuse asserted by backend PID, 40 parallel requests, organisation scope, and
the tenant role's write surface (own-row column privileges; no writes to the
roster or the organisation record). Membership authorisation negatives are in
`tests/organizations.test.ts`, identity linkage in `tests/identity-link.test.ts`,
sessions in `tests/sessions.test.ts`. What is NOT done: the same suite through
the staging project's pooler (R-34).

**2. AI truthfulness (Stage 03).** Given a fixed profile and evidence vault,
assert that no generated document contains an employer, technology, date,
credential or metric absent from the vault. Runs against both the deterministic
engine and the live-model path. Also asserts: every material claim has a
resolvable evidence reference; no prompt payload contains a `RESTRICTED` field;
identical inputs produce identical scores; and an injection attempt in a job
description cannot redirect a system prompt.

## Lint: measure, then ratchet

Done in Stage 00 and re-baselined in Stage 01. ESLint is installed, configured as
native flat config, and blocking in CI at `--max-warnings=8`; the count and the
justification for every warning are in `LINT_BASELINE.md`. The last step —
removing `eslint: { ignoreDuringBuilds: true }` from `next.config.mjs` — is
done: it stopped meaning anything once lint became its own gate, and Next 16
warned on the key. The plan is complete.

## The database suites

Since Stage 01 the transactional store is PostgreSQL, and these files need a
real one: `rls-isolation` (mechanism; creates its own schema and role),
`tenancy-isolation`, `organizations`, `sessions`, `identity-link`,
`sensitive-segregation`, `digital-twin-backfill` (Stage 02), and
`ai-gateway`, `evidence-vault`, `question-bank`, `prompt-registry` (Stage 03),
`taxonomy` (Stage 04), `connector-pipeline`, `ats-rulesets` (Stage 05) — all run
through the migrated schema (apply the history with
`npm run db:migrate:deploy` first).

**The connector contract suite (Stage 05).** `tests/connector-contract.ts` is
the admission gate ADR-0008 requires: seven cases every adapter runs
unchanged, from a `describe` per adapter in `tests/connectors.test.ts`. A
real source is wired to a recorded-shape fixture through a stubbed fetch —
rule 4 again: the fixture is written to the documented field names, and the
register says the live API has never been called.

**The AI suites (Stage 03).** `ai-grounding` is pure and runs everywhere: a
fixed profile, a posting carrying a prompt injection, adversarial "model
output" with an invented employer, degree, metric, technology and role, and
the deterministic engine's own output as the false-positive check.
`ai-gateway` runs the same fabrications through the real gateway with a
**fake external provider** against the database, and proves the per-tenant
policy routing, the `RESTRICTED`-payload refusal and the `AiRun` record. The
fake is the boundary rule 4 below describes: what a real model returns has
never been observed from this codebase, and the register says so.

**Running them.** Set `RLS_TEST_DATABASE_URL` (any PostgreSQL 14+ the test may
create and drop a schema and a role in) and `TENANCY_TEST_DATABASE_URL` (a
database the migrations have been applied to; the same one is fine):

```bash
RLS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test \
TENANCY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test npm test
```

A suite that touches the database through the shared client must import
`tests/helpers/database-env.ts` **as its first import**: `src/lib/db`
instantiates the Prisma client from `DATABASE_URL` the moment it is
evaluated, so a static import chain that reaches it (a registry module, a
loader) binds the client before any `before()` hook can override the
variable. The helper points `DATABASE_URL` at `TENANCY_TEST_DATABASE_URL`
before anything under `src/` loads. Stage 05's review found three suites
that silently ran against the shell's `DATABASE_URL` without it (H2).

Without them, those files skip with an explicit reason and the rest of the
suite runs normally — a developer without PostgreSQL is not blocked.

**They cannot be skipped where it matters.** Each file throws when its URL is
absent and `CI=true` (or `RLS_TEST_REQUIRED=1`). CI
supplies a `postgres:16` service container, so deleting that service fails the
job rather than quietly turning the proof off. This is rule 1 below applied to a
test that is *conditional* by nature: conditional must not become optional.

**What it proves, and what it does not.** It proves the mechanism on a stock
PostgreSQL: transaction-scoped context, fail-closed behaviour, write containment,
`FORCE ROW LEVEL SECURITY`, and three specific ways RLS can be present and inert
(`../governance/RISK_REGISTER.md` R-33). It does **not** prove the deployed
configuration — the same assertions through the real connection pooler in its
configured pool mode are a separate, still-outstanding Stage 01 exit condition.
Nor does it prove any application table is protected: no policy exists on any
real table yet.

Connection reuse is asserted rather than assumed — the pooled tests compare
`pg_backend_pid()` across checkouts — so a green run cannot mean the scenario
never occurred.

## Rules
1. **No test may be skipped, disabled or deleted to obtain a green run.** A
   failing test is a finding.
2. A bug fix ships with the test that would have caught it.
3. Tests assert behaviour, not implementation.
4. External services are faked at the boundary; **live validation is a separate,
   recorded activity** — that distinction is what keeps
   `IMPLEMENTED-NOT-VALIDATED` honest.
5. Every stage's exit gate names its required evidence.

## Stage 06 — canonical job

- `tests/canonical-jobs.test.ts` (pure): every canonical field of fifteen
  fixture postings asserted exactly (`tests/fixtures/canonical-postings.json`);
  dedup precision and recall computed over every pair of the labelled set on
  every run and asserted at 1.0 / 1.0, so a change to the identity rule is a
  visible decision; unit cases for title, company, region, years,
  authorisation and sponsorship. A golden is changed by review, never
  regenerated.
- `tests/connector-pipeline.test.ts` (database): the acceptance case (one
  job, two provenance rows, a snapshot per capture), primary-source column
  ownership, the no-merge case, per-source closure and doubt, sweep
  progress, closed-job non-revival, primacy adoption, the job page's
  tenant-path include, and tenant read-only access to provenance.

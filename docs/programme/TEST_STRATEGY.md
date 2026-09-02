# Test Strategy

## Current state (measured)

Re-measured 2026-09-02, mid-Stage 01. The baseline this document was written
against — 670 tests, no CI, lint never run — is superseded.

| | At the audit | Now |
| --- | --- | --- |
| Tests | 670 | **699** with PostgreSQL available, 689 without |
| Suites | 158 | 164 |
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

*Progress:* the **mechanism** half is done — `tests/rls-isolation.test.ts`, 10
assertions against a real PostgreSQL in CI. The **per-table** half is not, and
cannot be until the tables exist in PostgreSQL. See below.

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

## The RLS isolation proof (`tests/rls-isolation.test.ts`)

The only test in the suite that requires a real database. SQLite has no
row-level security, so the guarantee simply cannot be exercised against the file
the rest of the suite uses.

**Running it.** Set `RLS_TEST_DATABASE_URL` to any PostgreSQL 14+ the test may
create and drop a schema and a role in:

```bash
RLS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test
```

Without it, the suite skips this file with an explicit reason and the other 689
tests run normally — a developer without PostgreSQL is not blocked.

**It cannot be skipped where it matters.** The file throws when
`RLS_TEST_DATABASE_URL` is absent and `CI=true` (or `RLS_TEST_REQUIRED=1`). CI
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

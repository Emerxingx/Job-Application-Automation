# Test Strategy

## Current state (measured)
- **670 tests, 0 failures, 158 suites**, 16 files, 7,668 lines. Runner:
  `node --test` with `tsx`.
- Coverage is concentrated in **billing, analytics, integrations and CRM** —
  matching where the code is, not where the product is.
- Thin or absent: auth, matching, applications, jobs, storage.
- **No E2E tests.** **No CI.** **Lint has never run.**

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

**2. AI truthfulness (Stage 03).** Given a fixed profile and evidence vault,
assert that no generated document contains an employer, technology, date,
credential or metric absent from the vault. Runs against both the deterministic
engine and the live-model path. Also asserts: every material claim has a
resolvable evidence reference; no prompt payload contains a `RESTRICTED` field;
identical inputs produce identical scores; and an injection attempt in a job
description cannot redirect a system prompt.

## Lint: measure, then ratchet
ESLint is neither installed nor configured, so `npm run lint` prompts
interactively and exits 1. The path is:

1. Install ESLint; configure `next/core-web-vitals`.
2. Run in CI with `continue-on-error` and **publish the violation count**.
3. Plan remediation by rule class against that measured number.
4. Flip each cleaned rule to `error`. **Never a blanket enable.**
5. Remove `eslint: { ignoreDuringBuilds: true }` once the backlog is clear.

## Rules
1. **No test may be skipped, disabled or deleted to obtain a green run.** A
   failing test is a finding.
2. A bug fix ships with the test that would have caught it.
3. Tests assert behaviour, not implementation.
4. External services are faked at the boundary; **live validation is a separate,
   recorded activity** — that distinction is what keeps
   `IMPLEMENTED-NOT-VALIDATED` honest.
5. Every stage's exit gate names its required evidence.

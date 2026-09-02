# Stage Status

Live tracker. **A stage is only advanced when its exit-gate evidence is linked.**
Status: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `COMPLETE`.

**As of 2026-09-02, no stage is complete.** The architecture baseline awaits
founder approval; no remediation has begun.

| Stage | Name | Status | Existing coverage | Evidence |
| --- | --- | --- | --- | --- |
| 00 | Repository, governance, evidence baseline | **COMPLETE** | — | Merged to main as `d6ae8b3` (PR #4). CI green on `565012b`; see Stage 00 evidence below |
| 01 | Security, identity, orgs, multi-tenancy | **IN PROGRESS** | bcrypt+JWT, console two-lock gate, API key handling, SSRF guard, rate limiting | Branch `claude/stage-01-security-identity-tenancy`. Done: webhook replay+ordering, deny-by-default middleware, **authentication decision gate**. See `AUTH_DECISION_GATE.md` and `AUTONOMOUS_STATUS.json` |
| 02 | Candidate Digital Twin | NOT STARTED | ~12 flat `User` fields; `Resume` JSON | — |
| 03 | Career Evidence Vault, question architecture | NOT STARTED | Prompt registry; safe interpolation | — · **required here: `PromptRegistry` → governed admin; per-tenant AI policy enforced in the gateway** |
| 04 | Canada occupation / skills / LMI | NOT STARTED | 9-entry NOC regex in the Adzuna adapter | — |
| 05 | Job source connector framework | NOT STARTED | `JobProvider` (2 methods); Adzuna adapter; ATS detection | — · **required here: `AtsRulesets` → governed admin** |
| 06 | Normalization, dedup, freshness | NOT STARTED | ~15-field `Job`; skill extraction | — |
| 07 | Eligibility engine | NOT STARTED | None | — |
| 08 | Compatibility & recommendation | NOT STARTED | **Deterministic explainable scorer — preserve** | — |
| 09 | Document engine | NOT STARTED | Text + PDF; tailoring report | — |
| 10 | Job Folder / Application CRM | NOT STARTED | Folder generation, ~15 of ~30 fields | — |
| 11 | Email & calendar intelligence | NOT STARTED | None | — |
| 12 | Application preparation (assisted) | NOT STARTED | **Apply providers + assisted posture — preserve** | — · **required before production use: `FieldMappings` → governed admin** |
| 13 | Candidate dashboards & analytics | NOT STARTED | Rollups, revenue analytics, exports | — |
| 14 | Candidate mobile | NOT STARTED | None; blocked on the API contract | — |
| 15 | Payments, subscriptions, entitlements | NOT STARTED | **Deep invoicing/tax/dunning — preserve**; Stripe unvalidated | — |
| 16 | Career Change / Learning OS | NOT STARTED | CMS content collections only | — |
| 17 | Employment Services / WorkBC OS | NOT STARTED | None (correctly — no fake integration) | — |
| 18 | Corporate / Talent Acquisition OS | NOT STARTED | None | — |
| 19 | Staffing / Placement OS | NOT STARTED | None | — |
| 20 | Enterprise controls, SSO, admin OS | NOT STARTED | Payload admin + `/console`; the three config migrations already done in Stages 03/05/12 | — |
| 21 | Advanced reporting & warehouse readiness | NOT STARTED | Rollup models; revenue analytics | — |
| 22 | Controlled autonomous application | **BLOCKED** | Deliberately none | Blocked by design (`ADR-0016`) |
| 23 | Security / performance / a11y / ops hardening | NOT STARTED | Rate limiting, SSRF guard, secret hygiene | — |
| 24 | Production deployment & readiness | NOT STARTED | `DEPLOYMENT.md` | — |

## Stage 00 evidence (branch `claude/stage-00-governance-remediation`)

| Item | State |
| --- | --- |
| `.gitattributes` + LF policy | Added. `git add --renormalize .` is a **no-op** — every tracked file was already LF, and zero tracked files contain CRLF. The Windows dirty-tree churn was checkout-time conversion, now prevented |
| Generated-file determinism | CI regenerates `importMap.js` and `payload-types.ts` and fails on drift; also fails if `scripts/payload-cli.mjs` leaves `package.json` modified |
| CI | `.github/workflows/ci.yml` — lint · typecheck · test · build, plus generated-file and line-ending jobs. **First run executed and fully green** (see below) |
| Dependency audit | `.github/workflows/dependency-review.yml` — **reporting only**, deliberately: it would fail day one on the known Next advisories that `ADR-0017` schedules for Stage 01 |
| Dependabot | `.github/dependabot.yml`, grouped monthly; `next`, `payload`, `@payloadcms/*` and `eslint >=10` ignored so automation cannot leave a supported peer range |
| ESLint | Installed and configured (flat config). **`next lint` is not used** — deprecated in Next 15, removed in Next 16 |
| Lint baseline | **0 errors, 2 warnings** across 241 files. `npm run lint:ci` locks it with `--max-warnings=2` as a **blocking** gate. Full disposition in `LINT_BASELINE.md` |
| `npm run verify` | Reproduces the CI gate set locally |
| CODEOWNERS · PR template · SECURITY.md | Added |
| UI claim correction | Auto-apply control disabled and labelled "Not available"; the false sub-label removed; agents-list badge corrected; README headline corrected |

### Actual GitHub Actions run — Stage 00, commit `572d6ee`

Run [`33640134568`](https://github.com/Emerxingx/Job-Application-Automation/actions/runs/33640134568) (workflow `CI`, event `pull_request`, PR #4) — **all jobs success**:

| Job | Step | Result |
| --- | --- | --- |
| Verify | Install (from the lockfile) | success (37s) |
| Verify | **Lint** | **success** (6s) — the interactive-prompt defect is fixed and proven on a real runner |
| Verify | **Typecheck** | **success** (17s) |
| Verify | **Tests** | **success** (4s) |
| Verify | **Build** | **success** (91s) |
| Generated-file determinism | Regenerate import map + types, fail on drift | **success — no drift** |
| Generated-file determinism | Fail if `package.json` left modified by the Payload CLI | **success** |
| Line-ending policy | Fail if renormalisation would change anything | **success** |

Run [`33640134601`](https://github.com/Emerxingx/Job-Application-Automation/actions/runs/33640134601) (workflow `Dependency audit`) — **success**, reporting-only as designed.

This is a real, observed run, not an inference from local results.

## Measured gate status at `35d3491`

| Gate | Result | Status |
| --- | --- | --- |
| `npm ci` | exit 0 | PASS |
| `npx tsc --noEmit` | exit 0 | PASS |
| `npm test` | 670 pass / 0 fail, 158 suites | PASS |
| `npm run build` | exit 0, ~79 routes | PASS |
| `npm run lint` | exit 1 — interactive prompt; ESLint not installed or configured | **FAIL** |
| `npm audit` | 14 advisories (1 low, 7 moderate, 6 high) | **FAIL** |

## Blocking gates introduced by architecture review

| Gate | Stage | Source |
| --- | --- | --- |
| Authentication decision gate — written, evidence-based comparison before any auth implementation | **01** | `../adr/ADR-0004-authentication.md` |
| Pooled-runtime tenant-isolation proof on the real Supabase deployment, pool mode and Prisma runtime | **01** | `../adr/ADR-0005-multitenancy-rls.md` |
| `PromptRegistry` → governed platform administration; per-tenant AI policy enforced in the gateway | **03** | `../adr/ADR-0003-headless-cms.md`, `../adr/ADR-0015-data-residency.md` |
| `AtsRulesets` → governed platform administration | **05** | `../adr/ADR-0003-headless-cms.md` |
| `FieldMappings` → governed platform administration | **12** | `../adr/ADR-0003-headless-cms.md` |

## Immediate blockers to any production deployment
1. Next.js advisories — upgrade to 16.2.6+ (`ADR-0017`).
2. SQLite + no migrations (`ADR-0002`).
3. No RLS; isolation by hand-written filters alone (`ADR-0005`).
4. Stripe unvalidated and non-idempotent.
5. No CI.
6. Auto-apply UI promising unimplemented behaviour.

## Open legal / compliance decisions gating stage exits

Five questions are **OPEN** and owned by the founder and counsel, not by
engineering — see `../governance/COMPLIANCE_REGISTER.md` (L-1…L-5) and
`../governance/RISK_REGISTER.md` (R-25…R-29).

| Ref | Gates the exit of | Decision owner |
| --- | --- | --- |
| L-3 / R-27 | **Stage 03** (re-confirmed at 11 and 17) | Founder + privacy counsel |
| L-2 / R-26 | **Stage 04** | Founder + IP / data-licensing counsel |
| L-1 / R-25 | **Stage 17** (input needed by Stage 01) | Founder + BC public-sector privacy counsel |
| L-5 / R-29 | **Stage 18**, and Stage 19 for representation | Founder + employment / privacy counsel |
| L-4 / R-28 | **Stage 19** | Founder + employment / regulatory counsel |

None of the five blocks completion of the architecture baseline. A stage that
reaches its exit gate with its question still open is **BLOCKED** at that gate
rather than proceeding on an assumption.

## Stage 01 — in progress

Machine-readable state: [`AUTONOMOUS_STATUS.json`](AUTONOMOUS_STATUS.json). That
file is authoritative over any chat transcript.

| Item | State |
| --- | --- |
| Webhook replay **and ordering** | **DONE** — `src/lib/billing/webhook-events.ts`, wired into the Stripe route, 12 tests. Closes S-03/R-06 |
| Deny-by-default route gate | **DONE** — `src/middleware.ts`, 7 negative tests. Closes S-02/R-08 |
| Authentication decision gate | **DONE** — [`AUTH_DECISION_GATE.md`](AUTH_DECISION_GATE.md). Decision: **Supabase Auth**, **not ratified** pending residency verification |
| RLS mechanism proof | **PROVEN LOCALLY** on PostgreSQL 16.13 — see below. Not yet a committed CI test |
| PostgreSQL migration · RLS policies · tenancy wiring · session revocation · MFA/OAuth · Next 16 | **NOT STARTED** |

### RLS pooled-connection proof — measured, not asserted

Run against a real PostgreSQL 16.13 with a non-owner role and
`FORCE ROW LEVEL SECURITY`. Policy:
`USING (organization_id = current_setting('app.current_organization_id', true))`.

| Case | Expected | Observed |
| --- | --- | --- |
| Org A reads own rows | own only | own only |
| Org B reads own rows | own only | own only |
| Org A reads Org B row by id | 0 | 0 |
| **Missing** tenant context | 0 (fail closed) | **0** |
| **Invalid** tenant context | 0 (fail closed) | **0** |
| **Session-level `SET`, connection reused, next request has no context** | — | **read the previous tenant's row** |
| **`SET LOCAL` in transaction, same reuse** | 0 | **0** |

The sixth row is the finding `ADR-0005` demanded be proven: with a session-level
`SET`, a request carrying **no tenant context at all** read another tenant's data
on a reused connection, and every isolated policy test still passed. The seventh
shows transaction-scoped `SET LOCAL` closes it.

**Implementation consequence:** tenancy context must be set with `SET LOCAL`
inside the same transaction as the query. A session-level `SET` is a cross-tenant
leak on any pooled deployment.

The deployment-specific half of the `ADR-0005` gate — the *actual* Supabase
project and pool mode — remains **BLOCKED** on a Supabase project existing.

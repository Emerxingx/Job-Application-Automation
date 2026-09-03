# Stage Status

Live tracker. **A stage is only advanced when its exit-gate evidence is linked.**
Status: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `COMPLETE`.

**As of 2026-09-03:** Stage 00 complete; Stage 01 PARTIAL (`STAGE01_EVIDENCE.md`);
Stage 02 PASS on every reachable engineering gate, pending merge (`STAGE02_EVIDENCE.md`);
Stage 03 PASS on every reachable engineering gate, **exit BLOCKED on L-3** (`STAGE03_EVIDENCE.md`);
Stage 04 PASS on every reachable engineering gate, **exit BLOCKED on L-2** (`STAGE04_EVIDENCE.md`);
Stage 05 PASS on every reachable engineering gate, **exit PARTIAL** — Adzuna live validation BLOCKED on credentials (`STAGE05_EVIDENCE.md`).

| Stage | Name | Status | Existing coverage | Evidence |
| --- | --- | --- | --- | --- |
| 00 | Repository, governance, evidence baseline | **COMPLETE** | — | Merged to main as `d6ae8b3` (PR #4). CI green on `565012b`; see Stage 00 evidence below |
| 01 | Security, identity, orgs, multi-tenancy | **PARTIAL** | PostgreSQL + 3-migration history; RLS on all 70 tables; transaction-scoped tenant context; orgs/memberships; revocable sessions; consent + security audit; Supabase identity (unvalidated) | Branch `claude/stage-01-security-identity-tenancy`, PR #13. Full evidence: [`STAGE01_EVIDENCE.md`](STAGE01_EVIDENCE.md). **Not PASS**: the staging project is unreachable from the build environment, so the Supavisor pooled proof, the staging migration rehearsal, a live region read and the Supabase Auth flows are `NOT VERIFIED` / `BLOCKED` (R-34); tenant-path adoption is partial (R-35) |
| 02 | Candidate Digital Twin | **PASS (engineering) — pending merge** | 11 structured tables + `sensitive` schema; editor/scanner/applicator/interview prep on the structured profile; preferences + work authorization UI | Branch `claude/stage-02-candidate-digital-twin` (stacked on Stage 01). [`STAGE02_EVIDENCE.md`](STAGE02_EVIDENCE.md). Inherits R-34 for the staging rehearsal; assistive-technology review deferred to Stage 23 |
| 03 | Career Evidence Vault, question architecture | **PASS (engineering) — exit BLOCKED on L-3** | Versioned evidence vault (immutable once approved, trigger-enforced); question bank with policy floors (`NEVER_AUTOMATE` pinned for sensitive); `PromptRegistry` moved out of the CMS into `PromptVersion` with admin-only, step-up, approval, evaluation-gated promotion, rollback and audit; AI gateway resolves the tenant policy before dispatch, fails closed, records every run, grounds every section in code | Branch `claude/stage-03-career-evidence-vault` (stacked on Stage 02). [`STAGE03_EVIDENCE.md`](STAGE03_EVIDENCE.md). Live-model path proven with a fake provider only (no key); L-3 open, so external generation stays off by construction |
| 04 | Canada occupation / skills / LMI | **PASS (engineering) — exit BLOCKED on L-2** | Canonical `Occupation` + per-scheme codes (NOC 2021 with TEER, SOC 2018), bilingual label records, skills/career-path/region tables, licence gate (`TaxonomyDataset` + `requireIngestible`), NOC loader, crosswalk, classifier with recorded method, `/console/taxonomy` | Branch `claude/stage-04-occupation-skills-spine` (stacked on Stage 03). [`STAGE04_EVIDENCE.md`](STAGE04_EVIDENCE.md). **No real dataset ingested**: every licence is `unrecorded` and the loaders refuse until an admin records it |
| 05 | Job source connector framework | **PASS (engineering) — exit PARTIAL** | `JobSourceConnector` (8 methods) behind a register with a per-connector policy record and enablement gate; pipeline with first/last-seen, immutable snapshots, run audit, refresh / closure; contract suite on mock + Adzuna (recorded-shape fixture); `AtsRulesets` → governed admin (no evasion setting); storage provider with a residency-checked S3 adapter | Branch `claude/stage-05-job-source-connectors` (stacked on Stage 04), [PR #17](https://github.com/Emerxingx/Job-Application-Automation/pull/17) (draft). [`STAGE05_EVIDENCE.md`](STAGE05_EVIDENCE.md). **Adzuna never called live** (no credentials); one source (mock) enabled |
| 06 | Job normalisation, deduplication and freshness | **PASS (engineering) — exit PARTIAL** | Canonical job (fifteen derived fields, `canonicalHash`), `JobProvenance` (one job, every source that carries it), dedup measured on a labelled set (precision 1.000 / recall 1.000, 105 pairs), weak identities never merge, per-source closure and doubt never inferred from silence, closed jobs leave the feeds, sweep with progress on demand and by command; review: 2 HIGH / 7 MEDIUM / 9 LOW all closed | Branch `claude/stage-06-normalization-dedup-freshness` (stacked on Stage 05), [PR #18](https://github.com/Emerxingx/Job-Application-Automation/pull/18) (draft). [`STAGE06_EVIDENCE.md`](STAGE06_EVIDENCE.md). **No real traffic measured** (no credentialed source); **no scheduler** (Stage 24) |
| 07 | Eligibility engine | **PASS (engineering) — exit PARTIAL** | Six deterministic, jurisdiction-aware rules (work authorisation, sponsorship, clearance, location, licensure, language) evaluated BEFORE scoring; `EligibilityResult` per (user, job) with every rule's status and reason, never a number; an ineligible posting never becomes a match (tested end to end on the synthetic source); exclusions listed with reasons; facts read on the tenant path, audit-first | Branch `claude/stage-07-eligibility-engine` (stacked on Stage 06), [PR #19](https://github.com/Emerxingx/Job-Application-Automation/pull/19) (draft). [`STAGE07_EVIDENCE.md`](STAGE07_EVIDENCE.md). **Certification and language are advisory** until Stage 08 separates required from preferred; **no radius**; clearance unknown-only |
| 08 | Compatibility and recommendation engine | **PASS (engineering) — exit PARTIAL** | The preserved deterministic engine inside the mandated pipeline: requirement extraction (Stage 06), evidence retrieval (Stage 03), deterministic compare through the gateway, a deterministic semantic stage (equivalence map; pgvector BLOCKED), governed versioned weights (`MatchWeightVersion`, built-in baseline until one is active), one cited `MatchDimension` row per dimension, every match recording its weight and pipeline versions | Branch `claude/stage-08-compatibility-engine` (stacked on Stage 07), [PR #20](https://github.com/Emerxingx/Job-Application-Automation/pull/20) (draft). [`STAGE08_EVIDENCE.md`](STAGE08_EVIDENCE.md). **No embeddings** (extension unavailable); consistency and regression tested; no real traffic |
| 09 | Resume, cover letter and document engine | **PASS (engineering) — exit PARTIAL** | One ATS-safe model rendered to TXT, PDF and DOCX (deterministic, parse-back checked); every document a hashed `DocumentVersion`, verified on every read; a submitted version immutable by a database trigger (UPDATE and direct DELETE refused; the owner's erasure cascades); signed 10-minute links as the only path to a file; structural upload scan; five message kinds through the gateway, grounded | Branch `claude/stage-09-document-engine` (stacked on Stage 08), [PR #21](https://github.com/Emerxingx/Job-Application-Automation/pull/21) (draft). [`STAGE09_EVIDENCE.md`](STAGE09_EVIDENCE.md). **No antivirus engine**; S3 store not validated (durability across deploys NOT VERIFIED); no real traffic |
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

Updated 2026-09-02. Three of the original six are closed; the wording of the
remaining three is tightened to what is actually still true.

| # | Blocker | State |
| --- | --- | --- |
| 1 | Next.js advisories (`ADR-0017`) | **CLOSED** — on `next@16.3.4`; no deployed high-severity advisory remains |
| 2 | SQLite + no migrations (`ADR-0002`) | **CLOSED in code** — PostgreSQL, versioned history, CI-validated; the staging rehearsal is outstanding (R-34) |
| 3 | No RLS on any real table (`ADR-0005`) | **CLOSED in code** — every table policied and forced, proven through Prisma and a transaction-mode pooler; the Supavisor run is outstanding (R-34) |
| 4 | Stripe unvalidated and non-idempotent | **HALF CLOSED** — replay *and* ordering are closed in code and tested; live validation still outstanding (Stage 15) |
| 5 | No CI | **CLOSED** in Stage 00 — three jobs, all required |
| 6 | Auto-apply UI promising unimplemented behaviour | **CLOSED** in Stage 00 — control disabled and labelled |

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
| Deny-by-default route gate | **DONE** — `src/proxy.ts`, 9 negative tests. Closes S-02/R-08 |
| Next 16 upgrade (`ADR-0017`) | **DONE** — `next@16.3.4`, inside Payload's peer range. Every **deployed** high-severity advisory cleared (14→11 total, high 6→3, remaining three dev-only). Closes R-03 |
| Authentication decision gate | **DONE** — [`AUTH_DECISION_GATE.md`](AUTH_DECISION_GATE.md). Decision: **Supabase Auth**, **RATIFIED 2026-09-02** on founder attestation that the project is in `ca-central-1`. Provenance recorded: attestation, not an agent measurement |
| RLS mechanism proof | **DONE** — `tests/rls-isolation.test.ts`, 10 assertions against a real PostgreSQL in CI (`postgres:16` service). Corrected `ADR-0005` and produced R-33. See below |
| PostgreSQL migration (3 migrations, CI-validated) | **DONE** locally + CI; **NOT VERIFIED** on Supabase (R-34). Procedure: `../operations/DATABASE_MIGRATIONS.md` |
| RLS on every table, generated + determinism-tested; transaction-scoped context | **DONE**; proven through Prisma on PostgreSQL 16 and PgBouncer transaction mode; **NOT VERIFIED** through Supavisor |
| `Organization` / `Membership` wiring, personal workspaces, AI policy on the schema | **DONE** — 12 negative tests |
| Server-side session revocation, session list, password-change revocation | **DONE** |
| Consent capture + security audit events | **DONE** — wording pending counsel (R-36) |
| Supabase Auth identity linkage | **IMPLEMENTED-NOT-VALIDATED** |
| MFA / email verification / recovery / OAuth | **BLOCKED** — Supabase Auth credentials + egress |
| Tenant-path adoption across all handlers | **PARTIAL** (R-35) — list in `STAGE01_EVIDENCE.md` §7 |
| Supabase staging environment | `DATABASE_URL`/`DIRECT_URL` **present, correctly shaped, ca-central-1** (verified without printing); **unreachable** from the build environment — see `AUTONOMOUS_STATUS.json` → `blockers[SUPABASE-NETWORK]` |

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

### The proof is now a committed test, and it found three more defects

The table above was a one-off local run. It is now
[`tests/rls-isolation.test.ts`](../../tests/rls-isolation.test.ts): 10 assertions
run on every CI job against a `postgres:16` service container. Connection reuse is
asserted via `pg_backend_pid()`, so a green run cannot mean the leak scenario
silently did not occur, and the file **throws** rather than skipping when
`CI=true` without a database — a conditional test must not become an optional one.

Writing it surfaced three failure modes the one-off run had not, all recorded as
**R-33** in `../governance/RISK_REGISTER.md` and folded into `ADR-0005` as an
amendment:

1. **`ENABLE ROW LEVEL SECURITY` does not bind the table's owner** — and on a
   managed PostgreSQL the application's migration role usually *is* the owner.
   Every policied table must also be `FORCE`d. Test 8 reproduces a total bypass
   with a correct policy enabled.
2. **"No tenant context" is not always `NULL`** — it is the empty string on any
   recycled connection, so an `IS NULL` guard fires once per connection lifetime
   and never again.
3. **`SET`/`SET LOCAL` take no bind parameters**, so writing them literally means
   interpolating the tenant id into SQL. `set_config($1, $2, true)` is required.

`ADR-0005` point 4 was itself wrong — it specified session-scoped context "per
connection", which is the leak. It is amended and dated.

# Stage Status

Live tracker. **A stage is only advanced when its exit-gate evidence is linked.**
Status: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `COMPLETE`.

**As of 2026-09-02, no stage is complete.** The architecture baseline awaits
founder approval; no remediation has begun.

| Stage | Name | Status | Existing coverage | Evidence |
| --- | --- | --- | --- | --- |
| 00 | Repository, governance, evidence baseline | NOT STARTED | Clean history; 670 tests; typecheck + build green; docs suite delivered by this audit | Audit branch |
| 01 | Security, identity, orgs, multi-tenancy | NOT STARTED | bcrypt+JWT, console two-lock gate, API key handling, SSRF guard, rate limiting | — · **blocking gates: authentication decision gate (`ADR-0004`) and pooled-runtime isolation proof (`ADR-0005`)** |
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

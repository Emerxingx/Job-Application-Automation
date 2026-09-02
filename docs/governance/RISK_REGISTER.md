# Risk Register

Scored **Likelihood × Impact** (1–5). Owner is the stage that closes it.

## Critical (score ≥ 16)

| ID | Risk | L | I | S | Mitigation | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | **Cross-tenant data leak.** Isolation is 63 hand-written filters; no RLS, no isolation test. One omission exposes another org's candidates, case notes or placements | 4 | 5 | 20 | RLS backstop + permanent negative-authorization suite | 01 |
| R-02 | **AI fabricates candidate facts.** No evidence grounding exists. A fabricated claim on a submitted résumé is a career-damaging, trust-destroying failure | 4 | 5 | 20 | Career Evidence Vault; generation accepts evidence refs only; truthfulness suite | 03 |
| R-03 | **Deployed Next.js advisories.** Proxy/middleware bypass, SSRF, cache poisoning, XSS, DoS on a version with no in-band patch | 4 | 5 | 20 | Upgrade to 16.2.6+, inside Payload's peer range. **Never `audit fix --force`** | 01 |
| R-04 | **No migrations + SQLite.** No reproducible schema, no rollback, no RLS capability | 5 | 4 | 20 | PostgreSQL + baseline migration `0001` | 01 |

## High (10–15)

| ID | Risk | L | I | S | Mitigation | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| R-05 | **Sensitive demographics influence outcomes.** No fields yet, so no defect — but nothing prevents someone adding `gender` to `User`, after which every `SELECT *` and profile serialisation carries it into scoring and prompts | 3 | 5 | 15 | Separate schema and grants **before** any such field exists | 02 |
| R-06 | **Stripe unvalidated and non-idempotent.** Revenue-critical path never run live; a replayed event re-grants | 4 | 4 | 16 | `WebhookEvent` idempotency; full test-mode E2E | 01 / 15 |
| R-07 | **Session theft persists 30 days.** Stateless JWT; logout deletes the cookie only | 3 | 4 | 12 | Server-side sessions with immediate revocation | 01 |
| R-08 | **New route ships unauthenticated.** No global gate; each route re-implements `requireUser()` | 4 | 4 | 16 | Deny-by-default middleware + a route-coverage test | 01 |
| R-09 | **Silent job loss.** No queue; two designed schedulers have no runner. In an automation product, silent loss destroys trust faster than an outage | 4 | 4 | 16 | Outbox + lease workers + dead-letter + admin visibility | 01/05 |
| R-10 | **Unlawful acquisition.** Commercial pressure to scrape prohibited sources | 3 | 5 | 15 | `SOURCE_ACCESS_POLICY.md`; per-source legal basis recorded before enablement; absolute prohibitions | 05 |
| R-11 | **Case-note exposure.** Most sensitive data on the platform; a public-sector breach is existential for the WorkBC product | 2 | 5 | 10 | `RESTRICTED` classification, org isolation, full audit, per-org retention | 17 |
| R-12 | **Auto-apply UI over-promises.** A user enables a toggle that does nothing and believes applications were sent | 5 | 3 | 15 | Disable or relabel the control | **00** |
| R-13 | **Product/billing inversion.** ~19k lines of commercial code against ~500 lines of candidate core; effort continues to flow to the mature layer | 3 | 4 | 12 | Stage sequencing puts candidate core first; billing is re-scoped, not extended | 02–10 |

## Medium (5–9)

| ID | Risk | L | I | S | Mitigation | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| R-14 | Lint backlog surfaces late on 238 files | 4 | 2 | 8 | Measure first, report-only, then ratchet | 00 |
| R-15 | Payload peer range blocks a future Next security fix | 2 | 4 | 8 | Standing pre-upgrade check; `ADR-0003` revisit trigger | ongoing |
| R-16 | Rate limits multiply by instance count | 3 | 3 | 9 | Shared Redis store | 01 |
| R-17 | Artefacts lost on container restart (local filesystem) | 4 | 2 | 8 | Object storage | 05 |
| R-18 | Cross-border AI processing without adequate consent | 2 | 4 | 8 | Documented exception, disclosure, minimal content, no sensitive data | 01/15 |
| R-19 | Dashboards degrade transactional performance | 3 | 3 | 9 | Marts and materialized views | 21 |
| R-20 | Taxonomy licensing breach | 2 | 4 | 8 | Licence recorded before ingestion | 04 |
| R-21 | Windows dirty-tree churn on generated files | 4 | 1 | 4 | `.gitattributes` + determinism check | 00 |
| R-22 | 34 unreferenced models become permanent confusion | 3 | 2 | 6 | Explicit wire/keep/defer decision per model, recorded | 01 |

## Accepted with compensating controls
| ID | Risk | Rationale |
| --- | --- | --- |
| R-23 | `esbuild`/`drizzle-kit` moderate advisory, no fix available | Affects the esbuild **dev server** only; reaches us via Payload's migration CLI, never run in production. Development-machine exposure only. Revisit when Payload updates its adapter deps |
| R-24 | Webhook SSRF residual DNS-rebinding gap | Literal private addresses blocked and redirects refused; closing fully needs a custom agent that re-checks the resolved address at connect time. Documented honestly in-source. Revisit in Stage 23 |

## Open legal / compliance decisions (R-25 … R-29)

These are **not engineering risks to be mitigated by engineering**. They are open
decisions owned by the founder and counsel. Full detail, including why none
blocks the architecture baseline, is in
[`COMPLIANCE_REGISTER.md`](COMPLIANCE_REGISTER.md).

| ID | Open question | Status | Decision owner | Must be resolved by |
| --- | --- | --- | --- | --- |
| R-25 (L-1) | Does the WorkBC engagement make the platform a service provider to a public body, and which regime applies? | **OPEN** | Founder + BC public-sector privacy counsel | **Stage 17** (input needed by Stage 01) |
| R-26 (L-2) | Which Canadian taxonomy datasets may be redistributed commercially, and on what attribution terms? | **OPEN** | Founder + IP / data-licensing counsel | **Stage 04**, before ingestion |
| R-27 (L-3) | Are cross-border AI transfers acceptable under intended customer contracts, especially public-sector? | **OPEN** | Founder + privacy counsel | **Stage 03**; re-confirmed at Stages 11 and 17 |
| R-28 (L-4) | What recruiter / staffing licensing applies in BC and each target jurisdiction? | **OPEN** | Founder + employment / regulatory counsel | **Stage 19** |
| R-29 (L-5) | What consent language is required for agency representation and employer disclosure? | **OPEN** | Founder + employment / privacy counsel | **Stage 18** (disclosure); **Stage 19** (representation) |

**Handling rule.** An unresolved question is never converted into an engineering
assumption. A stage reaching its exit gate with its question still open is
**BLOCKED** at that gate.

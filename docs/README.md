# Documentation

Architecture baseline, decisions and production programme.
**Status: proposed, pending founder approval. No remediation has begun.**

## Read in this order
1. `programme/CURRENT_BASELINE.md` — what was **measured**, with commands
2. `programme/GAP_ANALYSIS.md` — gaps in remediation order
3. `programme/MASTER_BUILD_PLAN.md` — Stages 00–24
4. `product/PRODUCT_MODULES.md` — MVP / V1 / V2 / Enterprise boundaries
5. `adr/README.md` — the 20 decisions

## Structure
```
architecture/   15 documents — platform, data, security, AI, jobs, CMS, payment,
                reporting, deployment, mobile, multi-tenancy, integration,
                automation, domain model, system context
product/         7 documents — vision, modules, personas, roles, screens,
                journeys, entitlements
governance/      8 registers — decisions, risks, integrations, compliance,
                classification, retention, AI governance, source access
programme/       6 documents — baseline, gaps, build plan, stage status,
                test strategy, readiness gates
adr/            20 numbered decision records
```

## Evidence standard
Documentation claims are **not** proof. Capabilities are marked `PASS`,
`PARTIAL`, `FAIL`, `NOT IMPLEMENTED`, `NOT VERIFIED` or `BLOCKED`, and `PASS`
requires evidence from code, tests, a running application, migrations, API
contracts, real integration testing, CI or security tooling.

`HANDOFF.md` in the repository root is a good-faith prior handoff and is treated
as a corroborated secondary source. One material correction to it is recorded in
`programme/CURRENT_BASELINE.md` §6.1.

## Headline findings
- Typecheck, tests (670/670) and build all **PASS**. Lint **FAIL** — ESLint is not
  installed and has no config, so `npm run lint` prompts interactively.
- 14 dependency advisories (6 high). Next.js is the dominant contributor;
  **a supported upgrade path to 16.2.6+ exists inside Payload's peer range.**
- Transactional store is **SQLite with no migrations**.
- **Multi-tenancy is schema-only** — `Organization`/`Membership` have zero code
  references; isolation rests on 63 hand-written filters with no RLS and no test.
- **No integration has been validated against a live service** — and none is
  misrepresented, which is a genuine positive finding.
- **Recommendation: keep Payload, do not migrate to Strapi** (`adr/ADR-0003`).

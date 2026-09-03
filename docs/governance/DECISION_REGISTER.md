# Decision Register

Index of consequential decisions. Full reasoning in `../adr/`.
All are **Proposed** pending founder approval of the architecture baseline.

| # | Decision | Summary | Reversibility |
| --- | --- | --- | --- |
| 0001 | Modular monolith | One deployable, module boundaries, event seams. No microservices/K8s | Easy — seams designed in |
| 0002 | PostgreSQL + migrations | Replace SQLite; baseline existing schema as `0001`; managed, Canadian | **Hard** — do early |
| 0003 | **Keep Payload, do not migrate to Strapi** | Working, zero extra services, correct boundary already; migration buys nothing the product needs | Moderate — coupling is 3 modules |
| 0004 | Authentication — **decided at the Stage 01 gate: Supabase Auth** (`../programme/AUTH_DECISION_GATE.md`, ratified 2026-09-02) | Console gate and roles retained; platform issues its own revocable sessions after the provider authenticates; provider identities linked to one user | Moderate — cheapest before the first real user |
| 0005 | RBAC + ABAC + RLS | Isolation enforced twice; app filters kept, RLS as backstop | **Hard** |
| 0006 | Task-shaped AI gateway | `generate/structuredOutput/embed/classify/rank`; model routing; `ai_runs` traceability | Easy |
| 0007 | Sensitive-data isolation | Separate schema, separate grants; unreachable from any decision path | **Hard** — design in from Stage 02 |
| 0008 | Lawful-source connectors | 8-method contract, strict source priority, absolute prohibitions | Easy |
| 0009 | Canada taxonomy | NOC/TEER spine, SOC-ready, jurisdiction first-class, bilingual from schema | **Hard** |
| 0010 | Payment ≠ entitlement | Explicit entitlement layer; every feature check reads it | Moderate |
| 0011 | Postgres queue + outbox | Enqueue in the same transaction; lease workers; interface ready for managed queue | Easy |
| 0012 | Events → marts → dashboards | No dashboard query on a transactional table; warehouse-ready, not warehouse-first | Moderate |
| 0013 | Mobile contract-first | OpenAPI published and frozen **before** the Expo app | Easy |
| 0014 | Generated-file policy | `.gitattributes`, track generated files, CI determinism check | Easy |
| 0015 | Canadian residency | Personal data in Canada; cross-border processors documented exceptions | **Hard** |
| 0016 | Human-in-the-loop | Assisted apply default; auto-apply modelled but unreachable | Easy to keep, hard to reverse safely |
| 0017 | Dependency remediation | Next 15.4.11 → **16.2.6+** (inside Payload's peer range). **No `audit fix --force`** | Easy |
| 0018 | CI quality gates | Required: typecheck/test/build. Lint measured then ratcheted | Easy |
| 0019 | Admin config boundary | Tier 1 business config editable; Tier 2 security implementation code-only | Moderate |
| 0020 | WorkBC boundary | Progressive levels; ship at Level 0; no fake integration | Easy |

## Decisions deliberately deferred
| Topic | Deferred until |
| --- | --- |
| Autonomous auto-apply | Stage 22 preconditions + written founder decision + legal review |
| Interview probability modelling | Sufficient real outcome data to calibrate |
| OpenSearch | Postgres FTS + pgvector demonstrably insufficient |
| Data warehouse | Mart refresh cost exceeds budget |
| Stripe Connect | A genuine marketplace exists |
| Microservice extraction | A module's scaling or compliance profile genuinely diverges |
| Physical tenant isolation | A contractual or public-sector requirement |

## Decisions inherited and endorsed
Made by the prior engagement, reviewed in this audit, and **kept**:

- Two databases, two lifecycles (Prisma transactional / Payload content).
- Provider abstraction with mock defaults and warn-and-degrade.
- CMS mounted at `/api/cms` so it cannot shadow application routes.
- `AUTH_SECRET` rejected by value; `PAYLOAD_SECRET` kept distinct.
- Console two-lock gate failing closed.
- Assisted apply over prohibited form automation.
- Scrub-in-place erasure so financial and audit records survive.
- The public API's structured error envelope, distinct from the internal shape.

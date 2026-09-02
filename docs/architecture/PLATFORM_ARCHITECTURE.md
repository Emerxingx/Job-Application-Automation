# Platform Architecture

**Status:** Proposed baseline · **Evidence:** `../programme/CURRENT_BASELINE.md`

## One platform, four products

```
                    ┌───────────────────────────────────────────┐
                    │        CAREER & EMPLOYMENT INTELLIGENCE   │
                    │              OPERATING SYSTEM             │
                    └───────────────────────────────────────────┘
   ┌────────────┬──────────────────┬──────────────────┬──────────────────┐
   │ P1         │ P2               │ P3               │ P4               │
   │ Candidate  │ Corporate /      │ Employment       │ Career Change /  │
   │ Job Search │ Talent /         │ Services /       │ Learning /       │
   │ OS         │ Staffing OS      │ WorkBC OS        │ Certification OS │
   └────────────┴──────────────────┴──────────────────┴──────────────────┘
   ┌───────────────────────────────────────────────────────────────────────┐
   │                        GOVERNED PLATFORM CORE                         │
   │  identity · tenancy · authorization · consent · audit                 │
   │  candidate digital twin · career evidence vault                       │
   │  occupation & skills taxonomy (NOC/TEER, SOC-ready)                   │
   │  job intelligence (connectors → normalize → dedup → eligibility →     │
   │                     compatibility)                                     │
   │  document engine · job folder · communication intelligence            │
   │  AI gateway (task-shaped, traceable) · prompt registry                │
   │  billing · entitlement · events & workers · reporting · admin         │
   └───────────────────────────────────────────────────────────────────────┘
```

The four products are **surfaces over one core**, not four applications. A
candidate's digital twin is the same record a recruiter sees (with consent) and a
case manager works with (with assignment). Duplicating it per product is the
failure mode this architecture exists to prevent.

## Architectural style

**Modular monolith with extraction seams** (`../adr/ADR-0001-modular-monolith.md`).
One deployable, one PostgreSQL instance, module boundaries enforced by review and
dependency rules, cross-module communication by public interface and events.

Explicitly rejected at current scale: microservices, Kubernetes, per-product
databases, service mesh.

## Layers

| Layer | Technology | State |
| --- | --- | --- |
| Web | Next.js (App Router), React 19, TypeScript, Tailwind | **Exists** |
| Mobile | React Native + Expo | Planned, contract-first (`ADR-0013`) |
| API | Next route handlers; versioned public API + OpenAPI | Partial — 49 routes, 4 public |
| Domain modules | `src/lib/*` by domain | Partial |
| AI | Task-shaped gateway + provider adapters | Partial (`ADR-0006`) |
| Persistence | PostgreSQL + Prisma, versioned migrations | **Planned** — currently SQLite, no migrations (`ADR-0002`) |
| Vector | pgvector on the same instance | Planned |
| Cache | Abstraction: in-process → Redis | **Exists** |
| Queue/workers | Postgres-backed outbox + lease workers | Planned (`ADR-0011`) |
| Object storage | S3-compatible, Canadian region, encrypted | Planned — currently local filesystem |
| CMS | Payload 3, in-process, separate logical database | **Exists** (`ADR-0003`) |
| Billing | Stripe Billing + Tax; internal entitlement layer | Partial (`ADR-0010`) |

## Module map

`identity` · `organization` · `candidate` · `career_evidence` · `job` ·
`matching` · `application` · `document` · `communication` · `talent` ·
`staffing` · `case_management` · `career` · `learning` · `billing` ·
`integration` · `governance` · `analytics`

Rules:
1. A module owns its tables. No other module reads them directly.
2. Cross-module reads go through the owning module's interface.
3. Cross-module side effects go through events (`ADR-0011`).
4. `governance` (consent, audit, retention, classification) is a dependency of
   everything and depends on nothing.

## Preserved from the existing implementation

These are load-bearing and must survive every refactor — see `GAP_ANALYSIS.md`
Part 5 for the full list with rationale:

- **The provider abstraction pattern**: lazy adapter loading, mock default,
  warn-and-degrade when credentials are absent. Extended, never replaced.
- **The deterministic match engine** as the explainable scoring stage and the AI
  fallback.
- **The assisted-apply posture** (`ADR-0016`).
- **The two-lock staff gate** as the pattern for every admin surface.
- **The CMS/transactional boundary**, which already satisfies the target
  requirement.

## Cross-cutting invariants

1. **Tenant isolation is enforced twice** — application filters and RLS
   (`ADR-0005`).
2. **Sensitive attributes never enter a decision path** (`ADR-0007`).
3. **Every material AI claim traces to approved evidence** (`ADR-0006`,
   Stage 03).
4. **Payment state ≠ entitlement state** (`ADR-0010`).
5. **No autonomous application submission** (`ADR-0016`).
6. **No unlawful data acquisition** (`ADR-0008`).
7. **Personal data stays in Canada by default** (`ADR-0015`).
8. **Business configuration is admin-editable; security implementation is not**
   (`ADR-0019`).

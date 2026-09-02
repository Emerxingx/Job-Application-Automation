# Architecture Decision Records

One numbered file per consequential decision. Format: Context → Options →
Decision → Consequences → Revisit when.

Status values: `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Rejected`.

All ADRs below are **Proposed** pending founder approval of the architecture
baseline. None has been implemented.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](ADR-0001-modular-monolith.md) | Modular monolith, not microservices | Proposed |
| [0002](ADR-0002-operational-database.md) | PostgreSQL + versioned migrations | Proposed |
| [0003](ADR-0003-headless-cms.md) | **Keep Payload; do not migrate to Strapi** | Proposed |
| [0004](ADR-0004-authentication.md) | Extend the existing auth; add revocable sessions, MFA, OAuth | Proposed |
| [0005](ADR-0005-multitenancy-rls.md) | RBAC + ABAC + PostgreSQL RLS as a backstop | Proposed |
| [0006](ADR-0006-ai-abstraction.md) | Task-shaped AI gateway with provider adapters | Proposed |
| [0007](ADR-0007-sensitive-data-isolation.md) | Physical schema separation for sensitive attributes | Proposed |
| [0008](ADR-0008-job-acquisition.md) | Lawful-source-only connector framework | Proposed |
| [0009](ADR-0009-canada-taxonomy.md) | NOC/TEER spine, jurisdiction as a first-class dimension | Proposed |
| [0010](ADR-0010-payment-entitlement.md) | Separate payment state from entitlement state | Proposed |
| [0011](ADR-0011-events-background-jobs.md) | Postgres-backed queue and outbox, in-process workers first | Proposed |
| [0012](ADR-0012-reporting.md) | Events → marts → dashboards; warehouse-ready, not warehouse-first | Proposed |
| [0013](ADR-0013-mobile.md) | React Native + Expo, contract-first | Proposed |
| [0014](ADR-0014-generated-files.md) | `.gitattributes`, tracked generated files, determinism check | Proposed |
| [0015](ADR-0015-data-residency.md) | Canadian residency for personal data | Proposed |
| [0016](ADR-0016-application-automation.md) | Human-in-the-loop by default; autonomy gated | Proposed |
| [0017](ADR-0017-dependency-remediation.md) | Sequenced Next upgrade to 16.x; no `audit fix --force` | Proposed |
| [0018](ADR-0018-ci-quality-gates.md) | Required gates now; lint ratcheted from a measured baseline | Proposed |
| [0019](ADR-0019-admin-configuration-boundary.md) | Business config is editable; security implementation is not | Proposed |
| [0020](ADR-0020-workbc-integration-boundary.md) | Progressive integration levels; no fake integration | Proposed |

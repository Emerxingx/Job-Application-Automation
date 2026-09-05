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
| [0013](ADR-0013-mobile.md) | React Native + Expo, contract-first — all three steps delivered in Stage 14: the contract (ADR-0028), its freeze and tests, and the Expo client under `mobile/` (ADR-0029 for its sign-in); device-level proofs NOT VERIFIED | Accepted (Stage 14) |
| [0014](ADR-0014-generated-files.md) | `.gitattributes`, tracked generated files, determinism check | Proposed |
| [0015](ADR-0015-data-residency.md) | Canadian residency for personal data | Proposed |
| [0016](ADR-0016-application-automation.md) | Human-in-the-loop by default; autonomy gated | Proposed |
| [0017](ADR-0017-dependency-remediation.md) | Sequenced Next upgrade to 16.x; no `audit fix --force` | Proposed |
| [0018](ADR-0018-ci-quality-gates.md) | Required gates now; lint ratcheted from a measured baseline | Proposed |
| [0019](ADR-0019-admin-configuration-boundary.md) | Business config is editable; security implementation is not | Proposed |
| [0020](ADR-0020-workbc-integration-boundary.md) | Progressive integration levels; no fake integration | Proposed |
| [0021](ADR-0021-eligibility-before-fit.md) | Eligibility is evaluated before fit, as pass/fail with reasons; advisory rules marked advisory | Accepted (Stage 07) |
| [0022](ADR-0022-compatibility-pipeline.md) | Compatibility is a decomposable, versioned pipeline around the preserved deterministic engine; weights governed; pgvector BLOCKED, no fake embeddings | Accepted (Stage 08) |
| [0023](ADR-0023-document-versions.md) | Every document is a hashed, versioned file in TXT/PDF/DOCX; a submitted version is immutable by the database and byte-reproducible or refused; signed expiring links; structural upload scan (no antivirus engine) | Accepted (Stage 09) |
| [0024](ADR-0024-application-folder.md) | One canonical application record: the status machine as data, history on every move in the same transaction, children on the tenant path, audit with ids and kinds only, a self-checking completeness checklist | Accepted (Stage 10) |
| [0025](ADR-0025-mailbox-intelligence.md) | Mailbox and calendar intelligence reads headers only under metadata scopes and per-connection consent; tokens encrypted in a system-only table; explainable, thresholded association that never auto-files a doubtful match; a revocation that purges; both real connectors IMPLEMENTED-NOT-VALIDATED | Accepted (Stage 11) |
| [0026](ADR-0026-assisted-application.md) | Preparation never submits: three reachable application modes with Approved Auto-Apply refused in code, the question bank in the prepared package under its policies, submission only as the applicant's instructed click, and field mappings as governed versioned data recorded on every application (the last ADR-0019 Tier-1 migration) | Accepted (Stage 12) |
| [0027](ADR-0027-candidate-analytics.md) | Candidate analytics read three replaced-not-incremented marts through one metric dictionary (mirrored in METRIC_DICTIONARY.md, test-enforced); reach inferred from the status history; small-cohort suppression on the system-only benchmark; freshness published; no industry dimension exists | Accepted (Stage 13) |
| [0028](ADR-0028-candidate-api-contract.md) | The candidate API contract is a frozen, hash-locked, versioned OpenAPI 3.1 document the backend is tested against in CI; a breaking change is a new major version; 1.1.0 (additive) added the mobile operations and closed every schema; the mobile app consumes only it | Accepted (Stage 14; amended 1.1.0) |
| [0029](ADR-0029-device-sessions.md) | The mobile app signs in with a device key: an `ApiKey` of kind `device`, scope `write` never `admin`, minted only by the applicant's own sign-in through the one public contract operation, expiring, capped, revoked by the owner, by a password change and by sign-out-everywhere | Accepted (Stage 14) |

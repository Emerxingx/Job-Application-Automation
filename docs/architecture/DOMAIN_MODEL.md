# Domain Model

Bounded contexts, their aggregates, and the invariants each must uphold. This is
the conceptual model; physical schema is in `DATA_ARCHITECTURE.md`.

## Identity & Access
**Aggregates:** `User`, `Session`, `Credential`, `Organization`, `Membership`, `Role`, `Permission`.
**Invariants:** one person, one `User`, many memberships. A session is revocable
server-side. An unset tenancy context matches no rows.
**Today:** `User` and sessions exist; `Organization`/`Membership` exist with
**zero code references**; roles are a string column.

## Candidate
**Aggregates:** `CandidateProfile` (the Digital Twin) with `EmploymentHistory`,
`Education`, `Skill`, `Certification`, `Project`, `Achievement`, `Language`,
`CareerPreferences`, `WorkAuthorization`; and a **physically separate**
`SensitiveProfile`.
**Invariants:** the sensitive aggregate is unreachable from matching, scoring,
ranking, recommendation and document generation. Work authorisation is *not*
sensitive-segregated — eligibility needs it — but is access-controlled and audited.
**Today:** ~12 flat fields on `User`; résumé content as JSON text.

## Career Evidence
**Aggregates:** `Evidence` (atomic, candidate-approved, sourced, timestamped),
`EvidenceSource`, `ApplicationAnswer`, `QuestionPolicy`.
**Invariants:** evidence is immutable once approved (edits create versions). No
material generated claim may exist without an evidence reference. Question
policies (`AUTO_FILL`, `ASK_IF_CHANGED`, `REQUIRE_REVIEW`, `NEVER_AUTOMATE`) are
enforced in the apply path, not merely displayed.
**Today:** does not exist. This is the single largest trust gap.

## Job Intelligence
**Aggregates:** `JobSource`, `JobPosting` (canonical), `JobSnapshot` (immutable
per-source capture), `JobRequirement`, `JobSkill`, `Company`.
**Invariants:** one canonical posting per `canonical_hash`, with every source
retained as provenance. A snapshot is never mutated — the Job Folder's integrity
promise depends on it. Closure is detected, not inferred from silence.
**Today:** a ~15-field `Job` with 3 code references; no dedup, no lifecycle.

## Matching
**Aggregates:** `EligibilityResult`, `CandidateJobMatch`, `MatchDimension`, `MatchWeightVersion`.
**Invariants:** eligibility is evaluated **first** and is pass/fail with reasons —
never folded into a score. A score is always decomposable into named dimensions
with cited evidence. Every score records the weight version used. Sensitive
attributes are structurally absent from every input.
**Today:** a deterministic, explainable scorer exists (**preserve**); no
eligibility gate.

## Application
**Aggregates:** `Application`, `JobFolder`, `ApplicationEvent`, `ApplicationAnswer`,
`ApplicationDocument`, `Interview`, `Assessment`, `Offer`, `Outcome`.
**Invariants:** one canonical folder per application. The exact submitted document
version is immutable and byte-reproducible. Status history is append-only.
**Today:** folder generation exists with ~15 of ~30 target fields.

## Document
**Aggregates:** `Document`, `DocumentVersion`, `ResumeVersion`, `CoverLetter`.
**Invariants:** every version is content-hashed. A submitted version can never be
mutated or deleted while its application exists.
**Today:** text and PDF; no DOCX, no version history.

## Communication
**Aggregates:** `EmailConnection`, `EmailThread`, `EmailMessage`, `CalendarConnection`, `CalendarEvent`.
**Invariants:** association to a Job Folder carries a confidence score; low
confidence requires human confirmation and is never auto-filed. Revoking a
connection purges derived content. Mailbox content never reaches an AI provider
without explicit consent.
**Today:** does not exist.

## Talent (P2)
**Aggregates:** `EmployerAccount`, `Recruiter`, `Requisition`, `TalentPool`,
`CandidateSubmission`, `Pipeline`, `Offer`, `Hire`.
**Invariants:** **no candidate is disclosed to an employer without that
candidate's consent**, honouring their recruiter-visibility preference. Sensitive
attributes are never employer-visible.

## Staffing
**Aggregates:** `ClientContract`, `Engagement`, `FeeStructure`, `Placement`,
`GuaranteePeriod`, `RepresentationConsent`, `PlacementInvoice`.
**Invariants:** employer-paid placement and candidate-paid services are distinct
commercial objects and **never share a billing path**. Representation consent is
explicit, revocable, audited. Jurisdictional rules are configuration.

## Case Management (P3)
**Aggregates:** `ServiceProvider`, `Centre`, `CaseManager`, `ClientAssignment`,
`Case`, `Assessment`, `EmploymentPlan`, `Intervention`, `CaseNote`,
`TrainingReferral`, `EmploymentOutcome`, `RetentionEvent`.
**Invariants:** case notes are `RESTRICTED`. Strict organisational isolation.
**AI recommends; the case manager decides** — no AI output is auto-applied.

## Career & Learning (P4)
**Aggregates:** `Occupation`, `SkillTaxonomy`, `CareerPath`, `SkillGap`,
`LearningProgram`, `CredentialCatalog`, `Provider`, `LearningPlan`.
**Invariants:** the graph is transactional and joinable — CMS holds the narrative,
not the relationships (`ADR-0003`). A credential's claimed effect on eligibility
must be computable, not asserted.

## Billing & Entitlement
**Aggregates:** `Customer`, `Product`, `Price`, `Subscription`, `Entitlement`,
`Usage`, `Invoice`, `Payment`, `CreditNote`, `Refund`.
**Invariants:** payment state and entitlement state are distinct. Every feature
check reads entitlements. No card data is stored.
**Today:** deep invoicing (**preserve**); entitlement is quota-only.

## Governance
**Aggregates:** `Consent`, `AuditEvent`, `RetentionPolicy`, `DataClassification`,
`PrivacyRequest`, `AiRun`, `PromptVersion`, `FeatureFlag`.
**Invariants:** audit is append-only. Every privileged action is audited. Every
material AI action produces an `AiRun`. Consent changes emit events.

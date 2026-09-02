# Master Build Programme — Stages 00–24

**Baseline:** `CURRENT_BASELINE.md` · **Gaps:** `GAP_ANALYSIS.md` · **Scope:** `docs/product/PRODUCT_MODULES.md`

Every stage carries the same ten headings. Existing coverage is stated from
measured evidence so no completed work is rebuilt.

**Universal exit gate.** No stage is complete until: CI green (typecheck, lint,
unit, integration, build); migrations present and reversible; RLS policies and
authorisation tests for every new table; no new `high`/`critical` advisory; docs
and ADRs updated; evidence recorded in `STAGE_STATUS.md`.

---

## Stage 00 — Repository, governance and evidence baseline

**Objective.** Make change safe and observable before changing anything.
**Existing coverage.** Clean history; `HANDOFF.md`, `README.md`, `DEPLOYMENT.md`; 670 passing tests; typecheck and build green.
**Gaps.** G-02 (no CI, lint never run), G-09 (no `.gitattributes`), G-11(b) (auto-apply UI over-promises), G-03 (advisories).
**Dependencies.** None. Everything depends on this.
**Implementation.** Add `.gitattributes` (`* text=auto eol=lf`, binary rules). Add GitHub Actions: install → typecheck → test → build as **required**; ESLint installed and configured but **reporting-only** in run 1, with the violation count published. Add `npm run verify`. Disable or relabel the auto-apply toggle so no UI claims unimplemented behaviour. Add `CODEOWNERS`, PR template, `SECURITY.md`. Add a determinism check that regenerates `importMap.js` and fails on drift.
**Security.** Enable GitHub secret scanning, Dependabot, `npm audit --audit-level=high` as a reporting job (blocking only after Stage 01 clears the Next upgrade).
**Testing.** CI must reproduce all six gates from the baseline table.
**Acceptance.** A PR cannot merge with a red typecheck, test or build. Lint violation count is published. No UI control promises behaviour that does not exist.
**Evidence.** Green Actions run URL; committed lint baseline; screenshot or diff of the auto-apply UI change.
**Exit gate.** CI required on `main`; `.gitattributes` merged; a clean clone on Windows and Linux both report a clean tree.

---

## Stage 01 — Security, identity, organizations and multi-tenancy

**Objective.** One identity system, real tenancy, an authorisation backstop, and a patched runtime.
**Existing coverage.** bcrypt + JWT sessions; production secret rejection by value; two-lock staff gate; API key hashing; SSRF guard; rate limiting; `Organization`/`Membership` **schema** present.
**Gaps.** G-01, G-03, G-04, G-06, G-07, G-08, S-01…S-08.
**Dependencies.** Stage 00.
**Implementation.**
1. **PostgreSQL + migrations.** Switch `provider` to `postgresql`; baseline the existing schema as `0001`; stand up Supabase (Canada Central) per `ADR-0015`.
2. **Next.js upgrade** per `ADR-0017` — to `16.2.6+`, inside Payload 3.88.0's declared peer range. Full regression before merge.
3. **Middleware.** `src/middleware.ts` denying by default; public routes opt in explicitly.
4. **RLS.** Policies on every tenant-scoped table beneath the existing `userId` filters — defence in depth, not replacement (`ADR-0005`).
5. **Tenancy.** Wire `Organization`/`Membership`; add `organization_id` to tenant-scoped tables; add role/permission tables (`ADR-0005`).
6. **Auth.** Email verification, MFA/TOTP, recovery, device/session list with **server-side revocation**, OAuth (Google/Microsoft/Apple) (`ADR-0004`).
7. **Webhook idempotency.** Use `WebhookEvent`: record `event.id`, ignore replays (G-08).
8. **Consent and audit.** Consent records; extend `AuditLog` to every privileged action.
**Security.** Threat-model the tenancy boundary. Add negative authorisation tests as a permanent suite: *user A must never read user B's row*, per table.
**Testing.** RLS tests executed as distinct database roles. Session-revocation test. Replayed-webhook test. Upgrade regression: all 670 tests plus the build.
**Acceptance.** Cross-tenant read is impossible with RLS **and** with application filters removed in a test harness. No high advisory in deployed dependencies. Revoked session is dead immediately.
**Evidence.** Migration files; RLS policy DDL; passing isolation suite; `npm audit` before/after; Next upgrade regression report.
**Exit gate.** PostgreSQL in use with migrations; RLS on every tenant table; zero high advisories deployed; MFA available.

---

## Stage 02 — Candidate Digital Twin

**Objective.** Replace flat profile fields with a structured, queryable career profile.
**Existing coverage.** ~12 `User` fields; `Resume` as JSON text; onboarding flow.
**Gaps.** G-10.
**Dependencies.** Stage 01.
**Implementation.** First-class entities: `employment_history`, `education`, `skills` + `candidate_skills`, `certifications`, `projects`, `achievements`, `languages`, `career_preferences` (target/adjacent titles, salary, work mode, employment type, geography, travel, relocation, autonomy, recruiter visibility), `work_authorization`. Migrate existing `Resume` JSON into structured rows with a reversible backfill. **Sensitive-attribute segregation from day one** (`ADR-0007`): demographic self-identification lives in a separate schema with its own access path and is structurally unavailable to matching.
**Security.** Field-level classification (`DATA_CLASSIFICATION.md`); RLS on every new table; sensitive schema readable only by an explicitly authorised path.
**Testing.** Backfill idempotency; a matching-engine test proving sensitive attributes are unreachable from the scoring code path.
**Acceptance.** A candidate profile is fully expressible as relations; no scoring input can reach the sensitive schema.
**Evidence.** Migrations; backfill report with row counts; segregation test.
**Exit gate.** Structured profile live; sensitive isolation proven by test.

---

## Stage 03 — Career Evidence Vault and application-question architecture

**Objective.** Make fabrication structurally impossible, not merely discouraged.
**Existing coverage.** Prompt registry with versioning; single-pass non-recursive interpolation; deterministic engine used as AI grounding and fallback.
**Gaps.** G-11(a).
**Dependencies.** Stage 02.
**Implementation.** `career_evidence` — atomic, candidate-approved, timestamped claims, each linked to its source (employment record, education, project, upload). Generation accepts **evidence IDs, never free text**. Every material generated claim carries an evidence reference; unreferenced claims are rejected before render. `application_answers` question bank with risk classification and policy states `AUTO_FILL` / `ASK_IF_CHANGED` / `REQUIRE_REVIEW` / `NEVER_AUTOMATE`.
**Security.** Evidence is immutable once approved; edits create versions. Sensitive answers default to `NEVER_AUTOMATE`.
**Testing.** **Truthfulness suite** (`AI_GOVERNANCE.md`): given a fixed profile, assert generated documents contain no employer, technology, date, credential or metric absent from the vault. Runs against both the deterministic and live-model paths.
**Acceptance.** A tailored resume cannot include an unevidenced material claim.
**Evidence.** Truthfulness suite results, including adversarial prompts.
**Exit gate.** Grounding enforced in code, not prompt text.

---

## Stage 04 — Canada occupation, skills and labour intelligence

**Objective.** A real occupational spine; Canada first, US-compatible.
**Existing coverage.** A 9-entry NOC title regex inside the Adzuna adapter.
**Gaps.** G-21.
**Dependencies.** Stage 01. **Licensing confirmed before ingestion.**
**Implementation.** `occupations` (NOC + TEER, SOC-ready), `skills_taxonomy`, `occupation_skills`, `career_paths`, geography (province/territory, economic region), bilingual EN/FR content model. Jurisdiction is a first-class dimension so Canadian and US semantics normalise without collapsing (`ADR-0009`).
**Security.** Licence terms recorded per dataset in `SOURCE_ACCESS_POLICY.md`; attribution surfaced where required.
**Testing.** Taxonomy integrity; NOC↔SOC crosswalk sanity; bilingual completeness.
**Acceptance.** A job and a candidate can both be expressed in NOC/TEER terms; adding SOC requires no schema change.
**Evidence.** Licence records; row counts; crosswalk coverage.
**Exit gate.** Taxonomy queryable and jurisdiction-aware.

---

## Stage 05 — Job source connector framework

**Objective.** Many lawful sources behind one contract.
**Existing coverage.** `JobProvider` (2 methods); Adzuna adapter (`IMPLEMENTED-NOT-VALIDATED`); ATS detection for Greenhouse/Lever; provider registry pattern.
**Gaps.** G-22, G-28.
**Dependencies.** Stages 01, 04.
**Implementation.** Expand to `JobSourceConnector`: `discover`, `fetch`, `normalize`, `validate`, `refresh`, `detectClosed`, `getApplicationRoute`, `healthCheck` (`ADR-0008`). Per-connector config, credentials, rate limits, health and audit. Adapters in priority order: authorized APIs → authorized feeds → legitimate public ATS posting interfaces → structured career pages → licensed aggregators → permitted crawling. **Validate Adzuna against the live API in this stage.** Object storage (`ADR-0015`) replaces local filesystem.
**Security.** No CAPTCHA bypass, no access-control circumvention, no fingerprint evasion, no restriction-defeating proxies — enforced by review and recorded in `SOURCE_ACCESS_POLICY.md`. Per-source robots/ToS record.
**Testing.** Connector contract suite every adapter must pass; recorded-fixture replay; live smoke test per credentialed source.
**Acceptance.** A new lawful source is added without touching application code.
**Evidence.** Contract-suite results; live Adzuna run; ToS record per source.
**Exit gate.** ≥2 lawful sources live; Adzuna reclassified `PRODUCTION-VALIDATED`.

---

## Stage 06 — Job normalization, deduplication and freshness

**Objective.** One canonical job, provenance preserved, lifecycle tracked.
**Existing coverage.** ~15-field `Job`; skill extraction; NOC inference.
**Gaps.** G-13.
**Dependencies.** Stages 04, 05.
**Implementation.** Canonical job per §10 of the brief, including `normalized_title`, `occupation_family`, NOC + SOC, `postal_region`, `first_seen`/`last_seen`, `active_state`/`closed_at`, `source_hash`, `canonical_hash`, separated required/preferred skills, education, certification and experience requirements, language, work authorisation, sponsorship. Deduplicate on `canonical_hash` while retaining every source row (`job_snapshots`). Freshness sweeps and closure detection via `detectClosed()`.
**Security.** Snapshots are immutable — the Job Folder's integrity promise depends on it.
**Testing.** Dedup precision/recall on a labelled fixture set; closure-detection accuracy; normalisation golden files.
**Acceptance.** The same posting from two sources yields one canonical job with two provenance records.
**Evidence.** Dedup metrics; normalisation goldens.
**Exit gate.** Canonical model live; dedup measured; freshness running.

---

## Stage 07 — Eligibility engine

**Objective.** Hard pass/fail gates, evaluated before and separately from fit.
**Existing coverage.** None. Work authorisation is a free-text `User` field.
**Gaps.** G-12.
**Dependencies.** Stages 02, 06.
**Implementation.** Deterministic, explainable, jurisdiction-aware rules: work authorisation, sponsorship, licensure/certification, location and radius, security clearance, language. Output is a structured `eligibility_results` record with per-rule reason, never a number.
**Security.** Eligibility must never read the sensitive-demographic schema. Work authorisation is operationally relevant but access-controlled and audited.
**Testing.** Rule-level unit tests per jurisdiction; a suite asserting that an ineligible candidate is never surfaced as recommended.
**Acceptance.** No ineligible job reaches recommendations; every exclusion states a reason.
**Evidence.** Rule coverage matrix; ineligibility test results.
**Exit gate.** Eligibility gates scoring; explanations human-readable.

---

## Stage 08 — Compatibility and recommendation engine

**Objective.** Transparent compatibility. Never `resume + JD → LLM → %`.
**Existing coverage.** **Preserve.** A deterministic keyword/semantic engine producing a score breakdown, matched/missing keywords and a rationale — already explainable and stable.
**Gaps.** Missing the eligibility gate (Stage 07), evidence retrieval (Stage 03), embeddings and configurable weights.
**Dependencies.** Stages 03, 06, 07.
**Implementation.** Complete the mandated pipeline: parse → eligibility → requirement extraction → **evidence retrieval** → deterministic compare → semantic compare (pgvector) → weighted score → explanation. Weights become admin-configurable data with versioning; every score records the weight version used. `match_dimensions` persists per-dimension contribution.
**Security.** Sensitive attributes are structurally excluded from every input.
**Testing.** Scoring-consistency suite (same inputs → same score); weight-change regression; explanation completeness.
**Acceptance.** Every score is decomposable into named dimensions with cited evidence.
**Evidence.** Consistency results; a worked example showing the full chain.
**Exit gate.** Pipeline complete; weights admin-editable and versioned.

---

## Stage 09 — Resume, cover letter and document engine

**Objective.** Truthful, ATS-safe, versioned documents with immutable submitted copies.
**Existing coverage.** Text rendering; `pdfkit` PDFs; tailoring report; folder artefacts.
**Gaps.** G-16.
**Dependencies.** Stages 03, 08.
**Implementation.** ATS-friendly structures; DOCX alongside PDF; `document_versions` with content hashing; cover letters, application messages, recruiter introductions, outreach, follow-ups, thank-you notes — all evidence-grounded. The exact submitted version is retained immutably.
**Security.** Documents are private by default; access via signed, expiring URLs; server-side scanning for uploads.
**Testing.** Document regression goldens; ATS-parse validation; a test proving a submitted version can never be mutated.
**Acceptance.** Any submitted document is byte-reproducible from storage.
**Evidence.** Golden diffs; ATS parse reports; immutability test.
**Exit gate.** DOCX + PDF live; versions immutable.

---

## Stage 10 — Job Folder / Application CRM

**Objective.** One canonical, auditable record per application.
**Existing coverage.** Folder generation with README, JD snapshot, resume, cover letter, tailoring report; DB fallback; `Application` + `ActivityEvent`.
**Gaps.** G-14.
**Dependencies.** Stages 06, 09.
**Implementation.** Complete the §4 field set: employer and recruiter contacts, submission confirmation, interviews, assessments, follow-ups, notes, full status history, offer, rejection, structured outcome. Move artefacts to object storage.
**Security.** RLS; every access audited; export honours retention and erasure.
**Testing.** Status-machine tests; retention/erasure behaviour; folder completeness.
**Acceptance.** A folder answers "what exactly was sent, to whom, when, and what happened" without reference to any other system.
**Evidence.** A complete folder for a real end-to-end application.
**Exit gate.** Canonical folder live; artefacts durable.

---

## Stage 11 — Email and calendar intelligence

**Objective.** Associate employer communication to the right folder, with confidence controls.
**Existing coverage.** None. `EmailToken`/`EmailLog` models exist unused.
**Gaps.** G-15.
**Dependencies.** Stages 01 (consent, OAuth), 05 (storage), 10 (folder).
**Implementation.** Gmail and Microsoft Graph with **least-privilege incremental scopes**; explicit per-connection consent; Google and Microsoft calendars. Thread→folder association with a confidence score; low-confidence matches require confirmation and are never auto-filed. Events: `EMAIL_RECEIVED`, `INTERVIEW_DETECTED`, `OFFER_RECEIVED`.
**Security.** Highest privacy surface in the programme. Scope minimisation, revocation, encrypted token storage, retention limits, and **no mailbox content in prompts without explicit consent**. Classified `RESTRICTED`.
**Testing.** Association precision/recall on a fixture corpus; scope-revocation behaviour; a leakage test proving mailbox content never reaches an unconsented AI call.
**Acceptance.** Connect, sync, associate, revoke — all provable; revocation purges derived content.
**Evidence.** Precision/recall; scope inventory; revocation trace.
**Exit gate.** Both providers live with audited consent.

---

## Stage 12 — Application preparation (assisted, human-in-the-loop)

**Objective.** Make assisted apply excellent. **Not** autonomous submission.
**Existing coverage.** **Preserve.** `DefaultApplyProvider` / `AssistedOnlyApplyProvider` / `MockApplyProvider`; prepared-field generation; Greenhouse/Lever detection; the documented rationale in `providers/apply/types.ts`.
**Gaps.** ATS submission unvalidated; no browser extension; question bank not wired.
**Dependencies.** Stages 03, 09, 10.
**Implementation.** Wire the question bank with its policy states. Validate authorized ATS submission with a consenting employer credential. Optional browser extension consuming `PreparedField`. The four modes — Recommend Only / Prepare / Review & Submit / Approved Auto-Apply — are modelled, with **Auto-Apply disabled and unreachable** until Stage 22.
**Security.** No CAPTCHA bypass, no ToS circumvention, no fingerprint evasion. `NEVER_AUTOMATE` questions always require a human.
**Testing.** Mode-enforcement tests proving Auto-Apply cannot execute; ATS submission against a sandbox board.
**Acceptance.** Assisted apply completes in one click after review; autonomous submission is impossible.
**Evidence.** Sandbox ATS confirmation; mode-enforcement results.
**Exit gate.** Assisted path validated end-to-end; ATS reclassified `SANDBOX-VALIDATED`.

---

## Stage 13 — Candidate dashboards and analytics

**Objective.** Outcome analytics for candidates.
**Existing coverage.** Rich revenue analytics; rollup models; `recharts`; export builders.
**Gaps.** Candidate-outcome analytics are thin; dashboards hit the transactional store (G-25).
**Dependencies.** Stages 10, 11.
**Implementation.** Applications, recruiter responses, screens, interviews, offers, hires; response/interview/offer rates; cuts by title, company, industry, seniority, geography, source, resume version and compatibility score. Served from analytics models (`ADR-0012`).
**Security.** Small-cohort suppression to prevent re-identification.
**Testing.** Metric-definition tests; parity between transactional truth and marts.
**Acceptance.** Every metric has one documented definition and one source.
**Evidence.** Metric dictionary; parity report.
**Exit gate.** Dashboards read marts, not transactional tables.

---

## Stage 14 — Candidate mobile application

**Objective.** React Native + Expo, candidate-first.
**Existing coverage.** None. `/api/v1` covers 4 endpoints.
**Gaps.** G-27, and the real blocker: no stable API contract.
**Dependencies.** Stages 10, 13; a published OpenAPI contract.
**Implementation.** Publish OpenAPI for the candidate surface first; version it; then build Expo (`ADR-0013`). Scope: recommendations, job detail, match analysis, applications, folder, interviews, notifications.
**Security.** Mobile uses the same auth with platform-secure token storage; no privileged endpoints.
**Testing.** Contract tests web↔mobile; device matrix; offline behaviour.
**Acceptance.** Mobile consumes only the published contract.
**Evidence.** OpenAPI spec; contract-test results.
**Exit gate.** Contract frozen and versioned before app work begins.

---

## Stage 15 — Payments, subscriptions and entitlements

**Objective.** Separate payment state from entitlement state; validate Stripe.
**Existing coverage.** **Substantial.** Invoicing, tax, dunning, credit notes, payment allocation, numbering, PDF invoices, multi-gateway abstraction, 670 tests. Stripe Checkout + verified webhook.
**Gaps.** G-23; Stripe `IMPLEMENTED-NOT-VALIDATED`; idempotency (fixed in Stage 01); `PlanPrice`/`BillingProfile` unused.
**Dependencies.** Stage 01.
**Implementation.** Introduce an explicit `entitlement` layer between payment and feature access (`ADR-0010`): `customer → product → price → subscription → entitlement → usage → invoice → payment → credit/refund`. Wire `PlanPrice` and `BillingProfile`. Validate Stripe in test mode end-to-end, then live. Stripe Tax. **No card data stored.** Stripe Connect deferred to a future marketplace.
**Security.** Webhook idempotency verified; entitlement changes audited; refunds do not silently revoke access.
**Testing.** Stripe test-mode E2E including replay, failure and dunning; entitlement independence tests (comp/trial/grandfather without a charge).
**Acceptance.** Entitlement is grantable without payment and revocable without refund.
**Evidence.** Stripe test-mode traces; entitlement matrix tests.
**Exit gate.** Stripe `SANDBOX-VALIDATED` minimum; entitlement layer live.

---

## Stage 16 — Career Transition / Learning / Certification OS (Product 4)

**Objective.** Answer: *will this course or certification materially improve eligibility for the jobs I want?*
**Existing coverage.** `LearningPaths`, `Certifications`, `CareerGuides` as CMS content — correctly placed, not an engine.
**Gaps.** G-20.
**Dependencies.** Stages 04, 07, 08.
**Implementation.** Transactional graph: skills, competencies, occupations, career paths, courses, programs, credentials, institutions, providers, prerequisites, duration, delivery mode, cost, recognition, expiry, renewal, skills acquired. Transition engine: current occupation → transferable skills → candidate occupations → market attractiveness → transition difficulty → gaps (skill/experience/education/certification) → learning pathway → experience bridge → target jobs. CMS keeps the *narrative*; the graph is transactional (`ADR-0003`).
**Security.** Provider/credential data is licensed content — record terms.
**Testing.** Gap-computation correctness; a counterfactual test proving a completed credential measurably changes eligibility.
**Acceptance.** The platform answers the question above with a traceable computation.
**Evidence.** Worked transition with before/after eligibility.
**Exit gate.** Graph queryable; counterfactual demonstrated.

---

## Stage 17 — Employment Services / WorkBC Case Manager OS (Product 3)

**Objective.** A companion platform for case managers. **No fake WorkBC integration.**
**Existing coverage.** None.
**Gaps.** G-19.
**Dependencies.** Stages 01, 02, 08, 10.
**Implementation.** `organizations` (service provider, centre, location), supervisor/case-manager roles, client assignment, `cases`, assessments, barriers, employment goal, target occupation, action plans, tasks, interventions, case notes, job recommendations, resume versions, application activity, interviews, training referrals, employment outcomes, retention follow-up. Case-manager AI copilot **recommends only** — patterns such as poor response rates, unrealistic seniority, missing qualifications, geographic constraints, resume problems, weak demand, certification gaps. The case manager decides.
**Security.** Case notes are `RESTRICTED`. Strict organisational isolation via RLS. Every access audited. Public-sector retention rules configurable per organisation.
**Testing.** Cross-organisation isolation; copilot-recommendation-only enforcement; retention behaviour.
**Acceptance.** A case manager runs a full caseload; no AI output is auto-applied to a client record.
**Evidence.** Isolation suite; copilot audit trail.
**Exit gate.** Product usable; WorkBC integration remains at level 0 (`ADR-0020`).

---

## Stage 18 — Corporate / Talent Acquisition OS (Product 2)

**Objective.** Employer-side hiring.
**Existing coverage.** None. `Organization`/`Membership` wired in Stage 01.
**Gaps.** G-17.
**Dependencies.** Stages 01, 02, 08, 10.
**Implementation.** Employer organisations, hiring managers, recruiters, TA teams, employer contacts, requisitions, job creation, hiring requirements, sourcing, talent pools, matching, recruiter review, **candidate consent**, submissions, pipeline, interviews, notes, collaboration, offers, hires. Reporting: recruiter productivity, source performance, time-to-shortlist/interview/hire.
**Security.** Candidate consent gates every employer-visible disclosure. Recruiter visibility honours the candidate's Stage 02 preference. Sensitive attributes are never employer-visible.
**Testing.** Consent-gating tests; cross-employer isolation; visibility-preference enforcement.
**Acceptance.** No employer sees a candidate who has not consented to that disclosure.
**Evidence.** Consent audit trail; isolation suite.
**Exit gate.** Requisition→hire flow complete with consent enforced.

---

## Stage 19 — Staffing / Placement OS

**Objective.** Agency operations, modelled **separately** from candidate-paid services.
**Existing coverage.** None.
**Gaps.** G-18.
**Dependencies.** Stages 15, 18.
**Implementation.** Client contracts, recruitment engagements, fee structures, placement fees, guarantee periods, recruiter ownership, candidate representation consent, placements, invoicing, compliance. **Employer-paid placement and candidate-paid consulting are distinct commercial objects and must never share a billing path.** Jurisdictional rule configuration — Canadian recruiter/staffing rules are configuration, not hardcoded globals.
**Security.** Representation consent is explicit, revocable and audited. Fee data is `CONFIDENTIAL`.
**Testing.** Jurisdiction-rule tests (BC vs other provinces vs US states); a test asserting candidate-paid and employer-paid flows cannot cross.
**Acceptance.** An agency runs an engagement to invoiced placement; no candidate is ever charged on an employer-paid engagement.
**Evidence.** Jurisdiction matrix; separation test.
**Exit gate.** Placement lifecycle complete and jurisdiction-aware.

---

## Stage 20 — Enterprise tenant controls, SSO and public-sector readiness

**Objective.** Make the founder able to run the business; make the platform sellable to enterprise and government.
**Existing coverage.** Payload admin; `/console` CRM; feature-flag and audit models (unused).
**Gaps.** G-26.
**Dependencies.** Stages 15, 17, 18.
**Implementation.** Platform admin covering users, organisations, roles, permissions, plans, pricing, entitlements, job sources, connectors, AI models, prompt versions, matching weights, taxonomies, templates, career pathways, learning catalog, feature flags, notifications, email templates, CMS, retention, privacy, audit, reports, integration health, system health. Enterprise SAML/OIDC SSO, SCIM, tenant-level policy. **`ADR-0019`: business configuration is admin-editable; security-critical implementation is not.**
**Security.** Admin actions are audited and, for destructive operations, require step-up authentication. Support impersonation is read-only, reason-required and time-boxed — the `ImpersonationSession` design becomes real.
**Testing.** Admin authorisation matrix; impersonation read-only enforcement; SSO flows.
**Acceptance.** The founder performs every routine business change without a developer.
**Evidence.** Admin capability checklist signed off by the founder.
**Exit gate.** No routine business change requires a code deploy.

---

## Stage 21 — Advanced reporting and warehouse readiness

**Objective.** Reporting that does not degrade the product.
**Existing coverage.** Rollup models; revenue analytics; export builders; PDF reports.
**Gaps.** G-25.
**Dependencies.** Stages 13, 17, 18.
**Implementation.** `transactional → events → analytics models/marts → dashboards` (`ADR-0012`). Start pragmatically with Postgres materialized views; design extraction boundaries so a warehouse can be adopted without re-plumbing. Reporting products: candidate, employer, recruiter/staffing, case manager, employment outcome, career transition, founder/platform, financial, AI cost, connector health.
**Security.** Row-level scoping in marts; small-cohort suppression.
**Testing.** Mart/transactional parity; refresh SLAs; performance under load.
**Acceptance.** No dashboard query touches a transactional table.
**Evidence.** Query plans; parity report; load test.
**Exit gate.** Reporting isolated; warehouse path documented and unblocked.

---

## Stage 22 — Controlled autonomous application capability

**Objective.** Only if and when it is lawful, consented, and demonstrably safe.
**Existing coverage.** Deliberately none. Schema fields and a UI toggle exist; the toggle is neutralised in Stage 00.
**Gaps.** Intentional.
**Dependencies.** Stages 03, 07, 08, 12, 20 — **and an explicit written founder decision plus legal review.**
**Implementation.** Not specified here. Preconditions before any design work: per-source lawfulness confirmed in writing; explicit, revocable, granular candidate consent; hard eligibility gating; evidence grounding enforced; per-application audit with human-reversible actions; kill switch; volume caps; full ToS compliance. **No CAPTCHA bypass, no access-control circumvention, no fingerprint evasion, no restriction-defeating proxies — ever.**
**Security.** Highest-risk capability in the programme.
**Testing.** Not applicable until preconditions are met.
**Acceptance.** Blocked pending founder and legal approval.
**Evidence.** Written approvals.
**Exit gate.** **BLOCKED by design.**

---

## Stage 23 — Security, performance, accessibility and operational hardening

**Objective.** Production-grade non-functionals.
**Existing coverage.** Rate limiting; SSRF guard; secret hygiene; API key handling.
**Gaps.** No accessibility testing, no performance baseline, no DR, no backup verification, no penetration test.
**Dependencies.** Stages 01–21.
**Implementation.** Full §20 audit; WCAG 2.2 AA; performance budgets and load testing; backup/restore rehearsal; documented DR with RPO/RTO; incident response; third-party penetration test; data deletion and retention enforcement end-to-end.
**Security.** Independent review, not self-assessment.
**Testing.** Accessibility suite; load tests; **restore-from-backup rehearsal**; DR game day.
**Acceptance.** Every §20 item has evidence, not an assertion.
**Evidence.** Pen-test report; accessibility report; restore rehearsal log.
**Exit gate.** All §20 items `PASS` or accepted-with-compensating-control.

---

## Stage 24 — Production deployment and readiness

**Objective.** Go live deliberately.
**Existing coverage.** `DEPLOYMENT.md`.
**Gaps.** No production environment, no runbooks, no on-call, no status page.
**Dependencies.** Stage 23.
**Implementation.** Production infrastructure per `ADR-0015`; blue/green or canary; runbooks; on-call; monitoring, alerting, SLOs; status page; support process; production smoke suite.
**Security.** Production secret management; least-privilege infrastructure access; audited break-glass.
**Testing.** Production smoke tests; rollback rehearsal.
**Acceptance.** Every gate in `PRODUCTION_READINESS_GATES.md` passes.
**Evidence.** Readiness checklist with links.
**Exit gate.** Live, monitored, rollback-rehearsed.

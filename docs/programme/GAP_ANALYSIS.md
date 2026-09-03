# Gap Analysis — Existing Product vs Target Architecture

**Baseline:** `docs/programme/CURRENT_BASELINE.md` (commit `35d3491`)
**Target:** Career & Employment Intelligence Operating System — four products on one governed platform core.

Gaps are ranked by **remediation order**, which is driven by dependency, not by
severity alone. A gap that blocks ten others outranks a more severe gap that
blocks nothing.

Status vocabulary: `PASS` · `PARTIAL` · `FAIL` · `NOT IMPLEMENTED` · `NOT VERIFIED` · `BLOCKED`.

---

## Part 1 — Platform integrity gaps (must close before any product work)

### G-01 — No versioned database migrations · FAIL · blocks everything
`prisma/migrations/` does not exist; the workflow is `prisma db push`. There is no
schema history, no rollback, and no deterministic way to reproduce a schema state.
The datasource is additionally `sqlite`, and Prisma's `provider` is not
env-switchable, so "change it for production" is an unversioned manual edit.

**Root cause:** the project was built prototype-first and never crossed into a
release discipline.
**Why first:** every subsequent stage adds tables. Each one added without
migrations compounds the problem.
**Remediation:** adopt PostgreSQL as the transactional store and baseline the
existing schema as migration `0001`. See `ADR-0002`.

### G-02 — No CI, and lint has never run · FAIL · blocks safe change
No `.github/workflows/`. `npm run lint` drops into an interactive ESLint setup
prompt and exits 1 (measured), because **ESLint is neither configured nor
installed**. `eslint: { ignoreDuringBuilds: true }` masks the absence.

**Correction to the brief's framing:** the instruction was "do not simply turn
lint on if existing lint debt would make development unmanageable — measure
first." Measurement shows there is **no lint debt to manage**, because lint has
never run. The risk is inverted: introducing a strict config now will surface a
large first-run backlog on a 238-file codebase.
**Remediation:** land CI with the gates that already pass (`typecheck`, `test`,
`build`) as **required** immediately; add ESLint with `next/core-web-vitals` as a
**reporting-only** job, measure the true violation count, then ratchet. See
`ADR-0018` and `TEST_STRATEGY.md`.

### G-03 — Next.js 15.4.11 carries deployed high-severity advisories · FAIL
6 high / 7 moderate / 1 low. Next is the dominant contributor (~24 advisories,
several directly relevant: App Router proxy/middleware bypass, SSRF via Server
Actions, cache poisoning, CSP-nonce XSS).

**Root cause is narrower than previously recorded.** `next@15.4.11` is the last
15.4.x release, so no in-band patch exists — but Payload 3.88.0's peer range
already permits `next >=16.2.6 <17.0.0`, and Next 16.3.4 sits outside the
advisory range. A supported path exists **without changing Payload**.
**Do not run `npm audit fix --force`** — it installs `next@15.5.25`, which is
outside Payload's peer range.
**Remediation:** the sequenced plan in `ADR-0017`.

### G-04 — Tenant isolation is 63 hand-written filters, with no backstop · FAIL
Every isolation guarantee rests on a developer remembering `where: { userId }`.
There is no RLS, no query-level tenant guard, and no test that proves isolation.
`Organization` and `Membership` exist in the schema with **zero code references**.

**Why this is the highest-severity gap:** three of the four target products are
inherently multi-tenant (employer, staffing agency, WorkBC provider). Building
them on application-level filtering alone means one forgotten clause exposes
another organisation's candidates, case notes, or placements.
**Remediation:** PostgreSQL RLS as a defence-in-depth backstop beneath the
existing filters — not as a replacement. See `ADR-0005`.

### G-05 — No background processing · FAIL · blocks 8 target capabilities
No queue, no worker, no scheduler. `AgentSchedule` describes a complete scheduler
(lease columns, failure counters) that nothing reads. Outbound webhooks have a
full delivery state machine with **no runner**.

Blocks: job ingestion, normalisation, dedup, AI scoring at volume, document
generation, email sync, PDF export, reporting rollups, notifications.
**Remediation:** `ADR-0011`.

### G-06 — No global auth gate · FAIL
No `src/middleware.ts`. Every route re-implements `requireUser()`; a new route
that omits it is public by default. Combined with G-04, the failure mode is
silent.
**Remediation:** Stage 01 — add middleware that denies by default and requires
explicit opt-out for public routes.

### G-07 — Sessions cannot be revoked; auth feature set is far from target · FAIL
Stateless 30-day JWT; logout deletes the cookie only. No email verification, no
MFA, no recovery, no device list, no OAuth/SSO — all required by §4 of the brief.
**Remediation:** `ADR-0004`.

### G-08 — Stripe webhook is not idempotent · FAIL · revenue-affecting
`WebhookEvent` exists for de-duplication and is unreferenced. A replayed
`checkout.session.completed` re-runs `activatePlan`. Compounded by the fact that
the whole Stripe path is `IMPLEMENTED-NOT-VALIDATED`.
**Remediation:** Stage 01 — record and check `event.id` before dispatch.

### G-09 — No `.gitattributes`; generated-file policy undefined · PARTIAL
Root cause of the recurring Windows dirty-tree on `importMap.js`. Two generated
artefacts are tracked (`importMap.js`, `payload-types.ts`) with no determinism
check.
**Remediation:** `ADR-0014`.

---

## Part 2 — Candidate product gaps (Product 1)

### G-10 — Candidate Digital Twin is ~12 flat fields vs ~40 structured entities · FAIL
`User` carries `fullName`, `phone`, `city`, `country`, `headline`, `linkedinUrl`,
`portfolioUrl`, `workAuth`. `Resume` stores content as JSON text.

Absent as first-class entities: employment history, education, skills,
certifications, projects, achievements, languages, target/adjacent titles, salary
expectations, work mode, employment type, geographic preferences, travel,
relocation, sponsorship, application preferences, recruiter visibility, autonomy
settings.

**Consequence:** nothing downstream can be structured. Eligibility, matching,
evidence grounding and analytics all require these as queryable relations, not
prose in a JSON blob.
**Remediation:** Stage 02 — the largest single schema expansion in the programme.

### G-11 — AI is ungrounded, and the UI over-promises · FAIL · trust-critical
Two distinct problems:

**(a) No Career Evidence Vault.** The brief requires every material generated
resume claim to be traceable to candidate-approved evidence. No evidence model
exists. `AnthropicAIProvider.tailor()` is handed resume text and a job
description and asked to rewrite — there is **no structural constraint
preventing fabricated employment, technologies, or achievements.** The prompt
engine's injection defences are good; they do not address truthfulness.

**(b) The auto-apply toggle does nothing.** `agent-form.tsx` renders
"Auto-apply above N%". `scanner.ts` uses the threshold only to increment a
counter. No scheduler exists. A user can enable it and reasonably believe
applications are being sent.

**(b) is a UI-integrity defect and must be fixed early** — by disabling or
clearly labelling the control. That is *not* implementing auto-apply; it is
removing a false promise.
**Remediation:** Stage 03 (vault), Stage 00 (UI honesty).

### G-12 — No eligibility engine; scoring conflates eligibility with fit · CLOSED (Stage 07, engineering)
The brief mandates: parse → **hard eligibility** → requirement extraction →
evidence retrieval → deterministic compare → semantic compare → weighted score →
explanation.

**Stage 07:** hard eligibility now runs before scoring (`src/lib/eligibility/engine.ts`): work authorisation, sponsorship, clearance, location, licensure, language, each with a status and a reason in words; an ineligible posting never becomes a match and every exclusion is listed with its reason (`STAGE07_EVIDENCE.md`). Remaining: certification and language are advisory in eligibility (Stage 08 separates required from preferred for scoring, not for exclusion); no radius (no coordinates); clearance is not on the profile.

Present: a deterministic, explainable keyword/semantic engine with a score
breakdown — **a genuine asset worth preserving.**
Absent: the hard-eligibility stage. Work authorisation, sponsorship, licensure
and location are not evaluated as pass/fail gates, so a candidate can be scored
92% for a role they are legally ineligible for.
**Remediation:** Stage 07, ahead of Stage 08.

### G-13 — Job model is too thin for the canonical schema · CLOSED (Stage 06, engineering)
§10 of the brief requires ~35 canonical fields. `Job` has ~15 and only 3 code
references. Absent: `normalized_title`, `occupation_family`, `SOC`, `postal_region`,
`first_seen`/`last_seen`, `active_state`/`closed_at`, `source_hash`,
`canonical_hash`, separated `required_skills`/`preferred_skills`, education,
certification and experience requirements, language, sponsorship.

**Stage 06:** every listed field exists on `Job` and is derived on capture by `src/lib/jobs/canonical.ts`; `JobProvenance` carries every source; dedup on `canonicalHash` is measured on a labelled fixture set (`STAGE06_EVIDENCE.md` §4). Not yet observed on real traffic (no credentialed source) — that observation is the remaining gap.

No deduplication and no freshness/closure detection exist. `nocCode` is inferred
from a 9-entry title regex table in the Adzuna adapter — reasonable as a
placeholder, not an occupational taxonomy.
**Remediation:** Stages 04–06.

### G-14 — Job Folder is ~15 of ~30 required fields · PARTIAL
Exists as a real filesystem artefact (README, JD snapshot, resume, cover letter,
tailoring report) with a DB fallback — a good design. Absent: employer/recruiter
contacts, email thread linkage, interviews, assessments, follow-ups, offer,
rejection, structured outcome, full status history.
**Remediation:** Stage 10.

### G-15 — No email or calendar intelligence · NOT IMPLEMENTED
Gmail, Microsoft Graph, Google Calendar, Microsoft Calendar all absent. This is
the highest-value candidate capability not yet started, and the one with the
largest privacy surface (OAuth scopes, mailbox content, retention).
**Remediation:** Stage 11, gated on Stage 01 consent and Stage 05 storage.

### G-16 — Documents: no DOCX, no version history · PARTIAL
`pdfkit` produces PDFs and resumes render to text. Absent: DOCX, ATS-structure
validation, `document_versions`, and the guarantee that the *exact submitted
version* is immutably retained.
**Remediation:** Stage 09.

---

## Part 3 — Products 2, 3, 4

### G-17 — Corporate / Talent Acquisition OS · NOT IMPLEMENTED
No employer org, hiring manager, recruiter, requisition, talent pool, submission,
pipeline, offer or placement model. Blocked on G-04.

### G-18 — Staffing / Placement OS · NOT IMPLEMENTED
No client contract, engagement, fee structure, guarantee period, recruiter
ownership, representation consent or placement invoicing. The brief's warning is
apt: candidate-paid consulting and employer-paid placement must not share a
commercial model. The existing billing layer models **candidate subscriptions
only**.

### G-19 — Employment Services / WorkBC OS · NOT IMPLEMENTED
No service provider, centre, case manager, caseload, assessment, action plan,
intervention, case note, training referral, outcome or retention model.
**Positive finding:** no fabricated WorkBC integration exists. The integration
boundary can be built honestly from a clean start. See `ADR-0020`.

### G-20 — Career Change / Learning OS · PARTIAL (content only)
`LearningPaths`, `Certifications`, `CareerGuides` exist as **Payload CMS
collections** — editorial content, correctly placed. Absent: the transition
engine, the skills/occupation graph, gap computation, and any ability to answer
"will this certification materially improve eligibility?" — which requires the
graph to be transactional and joinable, not CMS content.
**Remediation:** Stage 16, with a clear CMS/transactional boundary per `ADR-0003`.

### G-21 — No Canadian labour-market taxonomy · NOT IMPLEMENTED
No NOC, TEER, OaSIS, economic region, or skills-taxonomy tables. The 20-entry NOC
regex in the Adzuna adapter is the entire current implementation. No French/EN
bilingual content model. No SOC for the US.
**Remediation:** Stage 04. Licensing must be confirmed before ingestion — see
`docs/governance/SOURCE_ACCESS_POLICY.md`. **Stage 04 (2026-09-03) built the
spine, the loaders and the gate; no dataset is ingested until L-2 is recorded.**

### G-22 — Single job source, unvalidated · PARTIAL
`JobProvider` is a clean two-method interface (`search`, `submit`) with one real
adapter (Adzuna, unvalidated). The brief's `JobSourceConnector` requires eight
methods including `detectClosed()`, `refresh()`, `healthCheck()` and
`getApplicationRoute()`. The existing interface is a good seed but is not the
target shape. **Stage 05 (2026-09-03) built the target shape** — `JobSourceConnector`, register, gate, pipeline, contract suite — with the mock and Adzuna behind it; Adzuna is still unvalidated and disabled.
**Remediation:** Stage 05. See `ADR-0008`.

---

## Part 4 — Platform capability gaps

### G-23 — Entitlement is quota-only; payment and entitlement state are fused · PARTIAL
The brief requires payment state and product entitlement state to be separate.
Currently `Subscription` + a monthly application counter serve both. There is no
`entitlement` concept, so feature access cannot be granted independently of a
successful charge (trials, comps, B2G licensing, grandfathering, refund-without-
revocation). `PlanPrice` and `BillingProfile` exist unused.
**Remediation:** `ADR-0010`.

### G-24 — AI gateway is narrow and untraceable · PARTIAL
`AIProvider` has three product-shaped methods (`analyzeMatch`, `tailor`,
`prepareInterview`). The brief requires task-shaped primitives: `generate()`,
`structuredOutput()`, `embed()`, `classify()`, `rank()`.

Absent: embeddings (so no semantic retrieval and no pgvector use), model routing
by task cost, and **AI run traceability** — there is no `ai_runs` record of
model, prompt version, inputs, evidence, output, confidence or human override.
The CMS `PromptRegistry` was a real strength and already covered version,
provider, model, parameters and default selection; it lacked
approval/evaluation status. **Stage 03 (2026-09-03) replaced it** with the
governed `PromptVersion` registry in the transactional database (approval,
evaluation-gated promotion, rollback, step-up, audit) and the AI gateway.
**Remediation:** `ADR-0006` — implemented; see `STAGE03_EVIDENCE.md`.

### G-25 — Reporting shares the transactional store · PARTIAL
Rollup models and 1,066 lines of revenue analytics exist — genuinely capable. But
dashboards query the transactional database directly, which the brief explicitly
warns against. No event stream, no marts.
**Remediation:** `ADR-0012`.

### G-26 — No platform admin; founder cannot operate the business · FAIL
The founder is non-technical. Today, changing a plan price, a matching weight, a
job source, a feature flag, an AI model or a retention policy requires editing
source or the database.

Present: Payload admin (content, ATS rulesets, prompts, field mappings) and
`/console` (customer CRM, invoices, tickets) — a strong start.
Absent: users, organisations, roles, permissions, plans, pricing, entitlements,
job sources, connectors, matching weights, taxonomies, feature flags, retention,
audit and system health.
**Remediation:** threaded through every stage, consolidated in Stage 20. The rule
in `ADR-0019`: business configuration is admin-editable; security-critical
implementation is not.

### G-27 — No mobile · NOT IMPLEMENTED
Target is React Native + Expo. Nothing exists. The absence of a stable public API
contract (OpenAPI) is the real blocker — `/api/v1` covers 4 endpoints.
**Remediation:** `ADR-0013`; Stage 14.

### G-28 — Local filesystem storage · PARTIAL
`STORAGE_ROOT` on local disk. Application folders do not survive a container
restart (the DB fallback mitigates this for three files only). No encryption at
rest, no object storage, no retention enforcement, no malware scanning for
uploads.
**Remediation:** Stage 05 infrastructure work.

---

## Part 5 — What must be preserved

Explicitly recorded so later stages do not discard it:

1. **The provider abstraction pattern** (`jobs`, `ai`, `payments`, `apply`,
   `cache`). Lazy `require`, mock default, warn-and-degrade on missing
   credentials. This is the single best structural idea in the codebase — extend
   it, do not replace it.
2. **The deterministic match engine.** Explainable, stable, testable scoring is
   exactly what the brief asks for and is rare. It becomes the deterministic
   stage of the target pipeline.
3. **The assisted-apply posture.** `providers/apply/types.ts` documents why the
   product does not drive prohibited forms. This is correct, commercially and
   legally, and is now `ADR-0016`.
4. **The staff-console two-lock gate.** Allowlist AND role, failing closed,
   degrading to least privilege. Reuse this pattern for every future admin surface.
5. **API key handling.** SHA-256, `timingSafeEqual`, prefix design, never
   re-displayed.
6. **The CMS/transactional boundary.** Payload owns content and nothing else. The
   brief's §12 requirement is *already satisfied*.
7. **The prompt registry and interpolation engine.** Versioned, operator-editable,
   single-pass, non-recursive, hard-fails on missing variables.
8. **The webhook delivery state machine and SSRF guard**, including its honest
   in-source statement of the residual DNS-rebinding gap.
9. **The billing and invoicing engine.** ~19,000 lines with 670 passing tests.
   Over-built relative to the product, but sound. Re-scope it; do not rewrite it.
10. **The documentation culture.** The in-source commentary explains *why*, and
    `HANDOFF.md` names its own unverified claims. Preserve this standard.

## Part 6 — What should be refactored, replaced, or not yet built

**Refactor:** `AIProvider` → task-shaped gateway (G-24) · `JobProvider` →
`JobSourceConnector` (G-22) · `User` → decomposed Digital Twin (G-10) ·
`Subscription` → payment/entitlement split (G-23) · scoring → eligibility gate
first (G-12).

**Replace:** SQLite → PostgreSQL (G-01) · `db push` → versioned migrations (G-01) ·
local filesystem → object storage (G-28) · in-process rate limiting → shared store
(S-08).

**Do not build yet:** autonomous auto-apply (Stage 22, gated) · interview
probability (needs calibration data) · microservices · Kubernetes · OpenSearch ·
warehouse · Stripe Connect · WorkBC API integration · mobile (needs the API
contract first).

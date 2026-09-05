# CLAUDE.md — Working guidance for this repository

Read this before changing anything. It records how this codebase actually
behaves, not how it appears to behave.

## What this is
Today: **JobPilot AI**, a Next.js job-application product for the Canadian and US
markets.
Target: a **Career & Employment Intelligence Operating System** — four products
on one governed platform core. See `docs/product/PRODUCT_VISION.md`.

The architecture baseline is in `docs/`. **It is proposed, not approved. No
remediation has begun.**

## Start here
| You want | Read |
| --- | --- |
| Measured state of the code | `docs/programme/CURRENT_BASELINE.md` |
| What is missing and why | `docs/programme/GAP_ANALYSIS.md` |
| What to build, in order | `docs/programme/MASTER_BUILD_PLAN.md` |
| Why a decision was made | `docs/adr/` |
| Prior engineering handoff | `HANDOFF.md` |

## Commands
```bash
npm ci                # install from the lockfile
npm run dev           # http://localhost:3000
npx tsc --noEmit      # typecheck  — PASSES
npm test              # 1199 tests  — PASSES with the two database URLs below set; the
                      #   database suites skip WITH A REASON without them and THROW
                      #   when CI=true, so CI cannot pass by skipping them
npm run build         # production — PASSES
npm run lint          # eslint directly — 0 errors, 8 warnings (baseline)
npm run lint:ci       # blocking variant: --max-warnings=8
npm run verify        # lint:ci + typecheck + test + build (the CI gate set)

# The database is PostgreSQL 16 (no SQLite path exists any more). Point both
# at a database that has had `npm run db:migrate:deploy` run against it:
#   tests/rls-isolation.test.ts     — raw mechanism proof (creates its own schema)
#   tests/tenancy-isolation.test.ts — the migrated schema through the real Prisma client
#   tests/organizations.test.ts, tests/sessions.test.ts
RLS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test \
TENANCY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test npm test

npm run db:migrate:deploy  # apply the versioned history (the ONLY production path)
npm run db:migrate         # local: create + apply a migration (needs CREATEDB for the shadow db)
npm run db:migrate:status
npm run db:seed            # plans + demo account (+ its personal workspace and consent)
npm run db:push            # LOCAL prototyping only — never staging or production
npm run cms:importmap      # regenerate the tracked Payload import map
npm run cms:types          # regenerate payload-types.ts

# The mobile app (Stage 14) is its own package: cd mobile && npm ci && npm run verify
#   (api:types diff · typecheck · 24 node:test suites · Metro web bundle). Never run on a device here.
```

## Things that will surprise you

1. **The database is PostgreSQL with a versioned migration history** since
   Stage 01 (`ADR-0002`). Forty-nine migrations under `prisma/migrations/`; CI applies
   them to an empty database and fails on drift. `DATABASE_URL` is the
   transaction pooler, `DIRECT_URL` the session endpoint for migrations. The RLS
   migration is **generated** from `src/lib/tenancy/rls-tables.ts` — regenerate
   it, never hand-edit it (a test compares the two). Procedure and recovery:
   `docs/operations/DATABASE_MIGRATIONS.md`.

2. **ESLint was never installed until Stage 00.** The
   `eslint: { ignoreDuringBuilds: true }` leftover in `next.config.mjs` is gone —
   it stopped meaning anything once CI gained a blocking lint job, and Next 16
   warned on it. Lint is configured as **flat config invoking
   `eslint` directly**, never `next lint` (deprecated in Next 15, removed in
   16). Baseline is **0 errors, 8 warnings**, locked by `--max-warnings=8`. The
   one rule exemption — `no-require-imports` for `src/lib/providers/**` — is the
   deliberate lazy-`require` pattern, not debt. The baseline rose from 2 to 8
   when Next 16 brought a stricter ruleset that surfaced six **pre-existing**
   `set-state-in-effect` sites; each was analysed and none is a defect. See
   `docs/programme/LINT_BASELINE.md`.

3. **Many Prisma models still have no application code references.** Some are
   nested-write models genuinely in use (`InvoiceLine`, `PaymentAllocation`,
   `DocumentSequence`). Others are designed-but-unwired — `AgentSchedule` (a
   complete scheduler with no scheduler) is the clearest; since Stage 04 so are
   `Region`, `RegionLabel`, `CareerPath`, `SkillLabel`, `SkillMapping` and
   `OccupationSkill` (schema and RLS only; their loaders wait on their own
   licence reviews). Stage 01 wired
   `Organization` / `Membership` (every user owns a personal workspace) and
   `WebhookEvent` (replay and ordering). Check before assuming a model does
   something.

4. **Nothing applies autonomously, and the UI now says so.** `scanner.ts` reads
   `autoApplyThreshold` only to increment a counter, and no scheduler exists
   (`AgentSchedule` has no code that reads it). Stage 00 disabled the auto-apply
   control and corrected the README. **Do not re-enable it** — autonomous
   submission is Stage 22 and is gated on lawfulness review plus an explicit
   founder decision (`ADR-0016`).

5. **There are two databases.** Prisma owns transactional data; Payload owns
   content, in its **own** database (`PAYLOAD_DATABASE_URI`). Deliberate.
   Nothing in the CMS reads or writes a Prisma table. Keep it that way.

6. **Tenant isolation is application filters PLUS row-level security, and the
   backstop only covers the tenant path.** Every table is `ENABLE`+`FORCE` RLS
   with policies for the `app_tenant` role. Request handlers reach that role only
   through `requireTenant()` → `run(tx => …)` (`src/lib/tenancy/request.ts`);
   anything still on the module-level `db` client runs as the system role and
   is protected by its `where: { userId }` filter alone. So: **keep the filter on
   every query, and put user-facing queries inside `run`.** A query on `db` from
   inside a `run` callback silently escapes the transaction — the one mistake
   the design cannot catch mechanically. Never set session-level `SET`; only
   `set_config(…, TRUE)` inside the transaction (R-33).

7. **Sessions are rows.** The cookie is a signed JWT whose `sid` names a
   `Session` row; `requireUser()` refuses a revoked, expired or password-epoch-
   stale row on every request, with no cache. `src/proxy.ts` checks only the
   signature (it cannot reach the database) — it is a gate, not the authority.
   A signature-valid token without `sid` (pre-Stage-01) is refused.

8. **The Supabase staging project is NOT reachable from the Claude build
   environment.** `DATABASE_URL`/`DIRECT_URL` are present and correctly shaped
   (verified without printing them), but the egress proxy relays only HTTPS and
   the pooler needs raw TCP. Never print those variables. Everything that needs
   the real project is tracked as a blocker in `AUTONOMOUS_STATUS.json`; do not
   mark it done on the strength of local PostgreSQL or PgBouncer runs.

9. **Demographic self-identification lives in the `sensitive` PostgreSQL schema
   with NO Prisma model** (ADR-0007, Stage 02). Only `src/lib/sensitive/` may touch
   it, through the `app_sensitive` role; a static test fails if any matching, AI,
   apply, document, analytics or export module references it. Do not add a
   sensitive field to a Prisma model — add it to the SQL migration for that schema.

10. **The career profile is structured** (`CandidateProfile` and ten child
    tables). `Resume.content` is a derived projection during the expand phase:
    write through `src/lib/candidate/profile.ts`, never to the JSON directly.

11. **`npm run cms:*` temporarily rewrites `package.json`.** `scripts/payload-cli.mjs`
   flips `"type": "module"` for the duration of the call and restores it, including
   on Ctrl-C. If a crash leaves it set, `git checkout package.json`.

12. **No integration has been validated against a live service.** Stripe, Adzuna,
    Anthropic, PayPal, ATS submission, **Supabase Auth and the managed PostgreSQL
    itself** are all `IMPLEMENTED-NOT-VALIDATED`. Code existing is not evidence of
    working.

13. **Every model-backed task goes through `src/lib/ai/gateway.ts`** (Stage 03).
    It resolves the tenant's `aiProcessingPolicy` before dispatch (missing →
    `EXTERNAL_AI_PROHIBITED`), refuses payloads carrying a `RESTRICTED` key,
    always runs the deterministic engine, grounds every generated section in
    code against the résumé + approved evidence, and writes an `AiRun` row
    with the exact prompt version. Prompts live in `PromptVersion`
    (`/console/prompts`), not in code and not in the CMS; **no version is
    `default` yet**, so every task is served by the deterministic engine and
    recorded as `deterministic` / `degraded` — that is the fail-closed design,
    not a bug. A static test fails if anything outside the gateway touches
    the SDK or the provider.

14. **Approved evidence is immutable** (`CareerEvidence`): the service refuses
    edits and a database trigger refuses them independently. A correction is
    a new version with `supersedesId`.

15. **The occupational spine is empty until a licence is recorded** (Stage 04,
    ADR-0009). `Occupation` / `OccupationCode` / labels exist, the NOC loader
    and the NOC↔SOC crosswalk are proven on a fixture, but every
    `TaxonomyDataset` is `unrecorded` and `requireIngestible()` refuses to
    load until an admin records the licence and attribution at
    `/console/taxonomy` (L-2). Classification falls back to the old regex
    table and records `regex_fallback` — a low-confidence method, not a match.

16. **A job source runs only through the connector gate** (Stage 05,
    ADR-0008). `JOB_PROVIDER` names a `JobSource` register row;
    `requireEnabledSource()` refuses it unless it is enabled, its
    per-connector record is complete and its named credentials are present,
    and records the refusal as a run. Only the synthetic mock is enabled out
    of the box; Adzuna is registered disabled with an empty legal basis and
    has never been called live. Every capture is an immutable `JobSnapshot`.
    `AtsRulesets` and `PromptRegistry` are no longer CMS collections.

17. **A `Job` is canonical and every source that carries it is a
    `JobProvenance` row** (Stage 06). `src/lib/jobs/canonical.ts` derives the
    canonical fields and `canonicalHash` on every capture; the pipeline resolves
    a capture to a job by provenance, then by hash, then creates one. The
    primary (first) source owns the `Job` columns; a second source keeps its
    own apply link. Closure is per source and never inferred from silence:
    a job closes, or is marked unknown, only when NO source still lists it;
    `unknown` stays open and is shown as unconfirmed; a closed job is never a
    merge target. Closed jobs leave the feed, the dashboard and the v1 match
    feed; exports and analytics keep history. `sponsorship` is `unknown`
    unless the posting says otherwise, and a negated or merely preferred
    requirement never becomes one. A weak identity (undisclosed employer,
    unparseable region, no vocabulary skills) never merges. `JobSource` is
    system-only: never include it on the tenant path — resolve names with
    `sourceNamesFor()`. Dedup is measured on a labelled fixture set, not on
    real traffic (no credentialed source). There is **no scheduler**:
    freshness runs from `/console/sources` or `npm run jobs:freshness`.

18. **Eligibility is evaluated before fit, and never as a number** (Stage 07,
    ADR-0021). `src/lib/eligibility/engine.ts` is pure: six rules, each with
    a status (pass · fail · unknown) and a reason in words; a hard fail makes
    the verdict `ineligible`, and `unknown` never excludes. The scanner calls
    it before `analyzeMatch`; an ineligible posting never becomes a
    `JobMatch` (an existing match is demoted to status `ineligible`, never
    deleted, and restored when the verdict lifts), every recommendation
    query filters with `notIneligibleFor(userId)`, and the verdict is stored
    (`EligibilityResult`) so the candidate sees why (`/dashboard/jobs/excluded`,
    the job page, the API). The profile version covers work authorisation,
    preferences, certifications and languages; check staleness with
    `profileVersionOf()` (timestamps only) before the audited read.
    The candidate's facts are read once per batch on the tenant path,
    audit-first (`eligibility.profile.read`, never a value). Certification
    and language are ADVISORY in eligibility (Stage 08 separates required
    from preferred for SCORING only, not for exclusion); do not make them
    hard gates on a mention. Nothing under
    `src/lib/eligibility/` may touch the sensitive schema (ADR-0007; the
    static allowlist test enforces it).

19. **Compatibility is a decomposable, versioned pipeline** (Stage 08,
    ADR-0022). `src/lib/matching/pipeline.ts` wraps the PRESERVED deterministic
    engine: requirement extraction from the canonical job, evidence retrieval,
    the deterministic stage through the gateway, a deterministic semantic
    stage (`semantic.ts`, an equivalence map — **pgvector is BLOCKED**, no
    embedding exists anywhere; never fake one), governed weights
    (`weights.ts`, `MatchWeightVersion`: draft → second-admin approval →
    active; nothing seeded active, the built-in constants apply as
    `builtin:1`). Every `JobMatch` records `weightVersion` and
    `pipelineVersion` and carries one `MatchDimension` row per dimension with
    cited evidence ids; `matched` items carry `how` (`exact` | `semantic`)
    and `missing` items a `level` (`required` | `preferred` | `wording`).
    The recorded score is `combineScore(breakdown, weights)` on every route.
    Never change the built-in constants silently; never rewrite a stored
    score when weights change; activation needs a reason (no evaluation
    gate exists for weights — say so, do not fake one).

20. **Every document is a hashed, versioned file** (Stage 09, ADR-0023).
    `src/lib/documents/`: one ATS-safe `DocumentModel` with text, PDF and
    DOCX renderers that are deterministic for a model and a date (do not
    add "now", random ids or compressed streams — the stored hash depends on
    it; the `docx` library draws random ids for hyperlinks, comments and text
    boxes, so never add one of those to the model without extending the
    determinism test); `DocumentVersion` rows whose bytes are read back hash-verified or
    refused; a submitted version is immutable by a database trigger (UPDATE
    and direct DELETE refused; only the owner's erasure cascade passes).
    Files are served through signed ten-minute links only. Uploads pass the
    structural scan in `scan.ts` — **there is no antivirus engine; never
    claim one.** Messages go through the gateway's `compose` task, never a
    template string in a route.

21. **An application's status moves only through the machine** (Stage 10,
    ADR-0024). `src/lib/applications/status-machine.ts` is the table;
    `transitionApplication` refuses anything else and writes the history
    row in the same transaction — never `application.update({ status })`
    directly. Folder children (contacts, interviews, assessments,
    follow-ups, notes) are user-owned tables written through `run()`;
    their audit entries are BUFFERED on the actor (`folderActor`) and
    flushed with `flushAudit` after the commit, because `AuditLog` is
    system-only and a tenant transaction cannot insert into it. Audit rows
    carry ids and kinds, never a name, an email, a note or a salary. Reads
    are not audited per view — say so, do not imply otherwise.

22. **A mailbox is read by reference only, and never by a model** (Stage 11,
    ADR-0025). The connectors ask for metadata scopes (`gmail.metadata`,
    `Mail.ReadBasic`) that cannot return a body; a grant that carries a
    content scope is revoked and refused. Tokens are AES-256-GCM in
    `MailboxSecret`, a SYSTEM-ONLY table (never on the tenant path — the
    tenant role has no policy on it), decrypted only inside
    `src/lib/mailbox/service.ts`. `EmailThread` has no body column and never
    will; association (`associate.ts`) and detection are pure and read the
    subject, participants, dates and the invite flag. Nothing under
    `src/lib/mailbox` may import the AI gateway or a provider (static test),
    and the gateway refuses any payload with a `mailbox` key. Neither Google
    nor Microsoft has been called from this codebase — no credentials exist
    here; `MAILBOX_CONNECTOR=mock` works outside production only and the
    registry never falls back to it. Revocation purges in one transaction.

23. **Preparation never submits; submission is the applicant's click**
    (Stage 12, ADR-0026). Every apply provider's `apply()` prepares and
    returns `assisted` or `unavailable` — even with an employer credential,
    even the mock. A record is `ready_to_submit` or `failed` at preparation
    and becomes `submitted` only through `confirmAssistedSubmission` (the
    applicant did it on the form) or `submitThroughAts` (their instructed
    click, Review & submit mode, an employer-authorised board, source
    `ats_api`). `src/lib/apply/modes.ts` holds the three reachable modes;
    `approved_auto_apply` is refused by `parseApplicationMode` and has no
    permission row — do not add one. The question bank is prepared into
    `Application.preparedQuestions` under its policies and a `never` entry
    carries no value. Field mappings are `FieldMappingVersion` (system-only,
    governed at `/console/field-mappings`, built-in set as `builtin:1` until
    a version is active); every application records the version it was
    prepared with. The CMS no longer holds any automation configuration. No
    real board has ever been submitted to.

24. **Candidate dashboards read marts, through one dictionary** (Stage 13,
    ADR-0027). `src/lib/analytics/candidate/dictionary.ts` defines every
    candidate metric once (mirrored in `docs/governance/METRIC_DICTIONARY.md`;
    a test fails if they differ); `rollup.ts` is the ONLY reader of the
    transactional tables and REPLACES whole (days × user) scopes; `read.ts`
    reads `CandidateOutcomeMart` / `CandidateMatchMart` on the tenant path
    and the system-only `CandidateBenchmarkMart` only through
    `suppressSmallCohort` (under five people → no number). A static test
    refuses a transactional query for a metric in the read module, the
    analytics page or the overview — add a metric to the dictionary and the
    mart, never a `count()` to a page. Counts are reach from the status
    HISTORY. There is no scheduler: `npm run analytics:rollup`, the
    candidate's refresh, or the first-visit rebuild. No industry dimension
    exists; do not fake one.

25. **`/api/v1` is a frozen contract, and the mobile app consumes only it**
    (Stage 14, ADR-0028, ADR-0029). `docs/api/openapi.candidate.v1.json`
    (1.1.0) names every operation, scope and schema; every object schema is
    CLOSED and every operation documents 401 and 429 (`contractProblems()`
    enforces both); `openapi.candidate.v1.lock` holds its hash, and
    `tests/candidate-api-contract.test.ts` fails when the document, the lock
    or the route files under `src/app/(app)/api/v1` disagree, and validates
    every response against its schema (ajv, closed - a leaked column fails).
    To change the API: edit the document and the code together, run
    `npm run api:freeze`, bump the minor version for an additive change - a
    breaking change is version 2 at a new path, never an edit - then
    `cd mobile && npm run api:types` (CI diffs the generated types). Every
    v1 route goes through `v1Route` (key auth, scope, rate limit, the one
    error envelope); the ONE public operation is the device sign-in
    (`v1PublicRoute`, address-limited), which mints an `ApiKey` of kind
    `device` (scope `write`, never `admin`, expiring, capped, revoked with
    the sessions on password change). The two employer-facing writes are the
    applicant's own confirm and instructed submit; `confirm` claims the
    record under the same advisory lock as `submit`. **The Expo app lives in
    `mobile/`** - its own package, lockfile and CI job; excluded from the root
    tsconfig and eslint; `mobile/README.md` is the recipe. It has NEVER run
    on a device: do not claim device-level behaviour.

26. **What an account may do is an entitlement, never a subscription
    status** (Stage 15, ADR-0010, ADR-0030). `src/lib/entitlements/service.ts`
    is the only writer and the only reader feature code uses:
    `entitlementsFor` / `quantityFor` / `can` resolve `Entitlement` rows (the
    person's and their accepted organizations') by max with the free
    baseline from `capabilities.ts`. Plan transitions in
    `src/lib/subscription.ts` are the only automatic writer (`activatePlan`,
    `startTrial`, `cancelSubscription`, `setSubscriptionStatus`,
    `suspendSubscription` each sync the rows with a reason); staff grant and
    revoke on `/console/entitlements` under step-up; a refund is recorded
    (`billing.refund.recorded`) and NEVER revokes. `getQuota`'s limit is the
    `applications_per_month` entitlement plus the bonus and `canApply` does
    not read status; the agent ceiling is the `agents` quantity. A static
    test refuses a feature module that branches on `Subscription.status` or
    reads a plan column - add a capability to the registry, never a status
    check to a page. Grants are idempotent by `dedupeKey` (a replayed
    webhook writes nothing), EXCEPT that a row staff revoked for cause stays
    revoked through every system re-sync; `cap` is the one source that
    LOWERS an answer (a staff ceiling, applied after the max-merge); an
    account with no `Subscription` row still has a quota (`baselineQuota`,
    never null). Stripe has still never been called from this
    codebase (no key here); `PlanPrice` and `BillingProfile` are wired into
    checkout (`resolvePrice`, `ensureBillingProfile`; a real gateway is only
    offered a price cell that carries its price id).

27. **The career transition graph is licensed reference data and the engine
    is pure** (Stage 16, ADR-0031). `Credential`, `OccupationCredential`,
    `LearningProvider`, `LearningOffering` and their skill links are
    `reference` rows loaded ONLY through `loadLearningGraph` →
    `requireIngestible()` (an unknown NOC code is reported, never invented;
    a row another dataset loaded is reported as a conflict, never
    re-parented; a prohibition purges everything the dataset loaded AND
    withdraws it from every stored plan first - `withdraw.ts`); every learning
    dataset is `unrecorded` (L-2), so the graph is EMPTY outside a test
    database and the pages say so. `src/lib/career/engine.ts` is
    deterministic (a static test refuses the AI gateway, a provider, the
    mailbox or the sensitive path under `src/lib/career`); every pathway
    step carries provenance or an explicit "no licensed offering covers
    this yet"; recognition is a string the dataset states; no outcome is
    predicted. `credentialCounterfactual` is the Stage 07 engine run twice.
    Plans are versioned (`refresh` writes n+1 with `supersedesId`), a `done`
    milestone may cite only the person's own approved evidence, and access
    is the `career_transition_per_month` / `learning_recommendations`
    entitlements. `TaxonomyDataset` is system-only, so the career service
    reads dataset facts through `datasetFacts()` on the system client -
    the one documented system-client read in that path; never add a
    `dataset` relation include on the tenant path (it returns null).

28. **A case exists only with the client's consent, and its notes are
    RESTRICTED** (Stage 17, ADR-0032; ADR-0020 Level 0 - there is NO WorkBC
    integration and no page may suggest one). `src/lib/cases/`: the case
    roles are a named set over the organisation ladder (`roles.ts`;
    unknown → viewer); a supervisor invites by EMAIL - the accounts table
    is never consulted and the audit row carries a digest - the CLIENT
    whose account address matches accepts under Settings (linked, name
    snapshotted, `ConsentRecord` `employment_services_case`, one
    transaction) and may withdraw; every engagement is a new `Case` row
    and a declined person is not re-invited; nothing about the client is
    read before consent or after withdrawal, and the delegated read checks
    THE CASE'S OWN consent record, never the purpose. A service-provider
    organisation is created only with `{ verifiedOrganization: true }` (staff).
    `Case` is SELECT-only for the client under RLS (`custom` + `readUsing`). `CaseNote` / `CaseAssessment` are `org`-scoped under RLS
    and every read and write is audited FIRST on the system client with ids
    and kinds only. What a case manager sees of the client is the delegated,
    audited read in `client-view.ts` (four checks, then the system client
    with `where: { userId: client }`) - never the sensitive schema. The
    copilot (`copilot.ts`) is pure and `runCopilot` writes
    `CaseRecommendation` rows and nothing else; the case manager decides.
    `caseNote`, `caseAssessment`, `caseBarriers` are RESTRICTED gateway keys
    (a Stage 10 folder's `assessments` count is not) and a static test keeps
    case rows out of matching, analytics, career and the gateway. Retention
    is per organisation, thins CLOSED cases only (from closure), and NO
    policy means NO purge (`npm run cases:retention`). Never add a WorkBC client, mock or screen.

29. **No employer sees a candidate who has not granted disclosure to THAT
    employer** (Stage 18, ADR-0033). `src/lib/employer/`: the hiring roles
    are a named set over the ladder (`roles.ts`, the matrix row); an
    employer organisation, like a service provider, is created only with
    `{ verifiedOrganization: true }` (staff); a requisition is a draft until opened, and opening publishes it through
    `requireEnabledSource('employer')` and the Stage 06 pipeline as a
    canonical `Job` (`source: employer`; closure is what the requisition's
    status says) - the publishing writes run on the SYSTEM client because
    the pipeline must see the committed row (never inside `run()`).
    Sourcing (`candidate-view.ts`) returns anonymised cards scored by
    `scoreCompatibility({ mode: 'deterministic' })` - the engine alone, no
    `AiRun` under the candidate, no model - honouring `recruiterVisibility`
    (hidden is never sourced nor askable). Employer audit rows are BUFFERED
    on the actor and flushed by `employerDone` after the transaction. `Disclosure` is the candidate's per-employer
    consent: granted in one transaction with its `ConsentRecord`
    (`employer_disclosure`), declined is final, revoked withdraws every
    disclosed submission and pool membership; every employer-visible read
    asks `grantedDisclosure()` (the row's OWN consent record), and the
    profile reaches the employer only through `readDisclosedCandidate`
    (audited). The stage machine (`stage-machine.ts`) refuses any stage at
    or past `consented` without it; `consented` is the candidate's stage.
    `Disclosure` is SELECT-only for the candidate under RLS. The consent
    version is `2026-09-05-draft`: `grantConsent` REFUSES a `-draft`
    purpose in production until counsel records the wording (L-5) - do not
    bump the version by hand. Nothing under `src/lib/employer` may touch
    the sensitive path, the gateway or a case record (static test). No
    notification is sent to anyone.

30. **Employer-paid placement and candidate-paid subscriptions never share
    a billing path, and jurisdiction rules are data** (Stage 19, ADR-0034).
    `src/lib/staffing/`: an agency's `ClientContract`, `FeeStructure`
    (`paidBy` is always `client`; the service refuses anything else),
    `Engagement`, `RepresentationConsent`, `Placement` and
    `PlacementInvoice` - the last has NO user id and no relation to
    `Invoice`, `Payment`, `Subscription` or `Entitlement`; nothing under
    `src/lib/staffing` may import the subscription, entitlement, invoice or
    payment modules and nothing under those may name a staffing table
    (static tests; a database test proves the candidate's billing is
    untouched). Its numbers come from the shared numbering BOOK
    (`DocumentSequence`, scope `placement_invoice`, series `PL`), allocated
    in a system-client transaction - a counter, not a billing path.
    `StaffingJurisdictionRule` rows are seeded with NAMES ONLY; counsel's
    answer is recorded at `/console/staffing` (audited); `jurisdiction.ts`
    is pure and an unknown is never a pass: a `blocked` verdict refuses a
    placement, `unconfirmed` marks it, and **no invoice is issued unless the
    verdict is `allowed`** (L-4). Never assert a jurisdiction's rule in
    code. Representation follows the Stage 17/18 consent pattern (invited by
    email, one transaction, SELECT-only for the candidate, revocable);
    `agency_representation` is `2026-09-05-draft` and refused in production
    (L-5).

## Conventions worth preserving

- **The provider pattern** (`src/lib/providers/`): interface, mock default, lazy
  `require` of real adapters, warn-and-degrade on missing credentials. This is
  why a clean clone boots with no configuration. Extend it; do not replace it.
- **Two error envelopes, deliberately.** Internal routes return
  `{ error: string }`. `/api/v1` returns `{ error: { type, code, message, param } }`
  because a third-party client cannot branch on English. Do not unify them.
- **No CORS on `/api/v1`, deliberately.** An API key is a bearer credential and
  must never reach browser JavaScript.
- **The console two-lock gate**: `STAFF_EMAILS` allowlist **and** `User.role`,
  failing closed, unknown role degrading to the *weakest* staff level. Reuse this
  pattern for any new admin surface.
- **Scrub-in-place erasure.** Personal data is nulled; invoices, payments and
  audit rows are retained and carry their own bill-to snapshot.
- **Security events go to `AuditLog` through `src/lib/security-audit.ts`**, never
  with a secret, a token or a request body; a failed sign-in stores only a digest
  of the address. Match that when adding events.
- **Every new table is classified in `src/lib/tenancy/rls-tables.ts`** before it
  ships; the coverage test fails until it is.
- **In-source commentary explains *why*.** Match that standard.

## Hard rules

1. **Never claim a mock is production.** Update
   `docs/governance/INTEGRATION_REGISTER.md` instead.
2. **No autonomous application submission** (`ADR-0016`).
3. **No unlawful data acquisition** — no CAPTCHA bypass, no access-control
   circumvention, no fingerprint evasion (`docs/governance/SOURCE_ACCESS_POLICY.md`).
4. **No sensitive demographic attribute may reach a matching, scoring, ranking or
   recommendation path** (`ADR-0007`).
5. **Never skip, disable or delete a test to get a green run.** A failing test is
   a finding.
6. **Never run `npm audit fix --force`.** It installs `next@15.5.25`, which is
   outside Payload's peer range. Follow `ADR-0017`.
7. `importMap.js`, `payload-types.ts` and the `row_level_security` migration are
   **generated**. Regenerate them; never hand-edit.
8. **Never print, log or commit `DATABASE_URL` / `DIRECT_URL`.** Diagnostics use
   `describeDatabaseUrl()` (redacted host, port, mode) and nothing else.

9. **Never call a model provider outside `src/lib/ai/gateway.ts`, and never set
   `PromptVersion.deploymentStatus = 'default'` by hand.** Promotion goes through
   `promotePromptVersion`, which refuses until an evaluation has passed
   (`docs/governance/AI_GOVERNANCE.md`).

10. **Never load a taxonomy dataset except through `requireIngestible()`**, and
    never set `TaxonomyDataset.licenceStatus` / `ingestionApproved` by hand
    (`docs/governance/SOURCE_ACCESS_POLICY.md`, ADR-0009).

11. **Never run a job source except through `requireEnabledSource()`**, never
    flip `JobSource.status` by hand, and never add an evasion setting to an
    `AtsRuleset` (ADR-0008). A `JobSnapshot` is never updated.

## Dependency constraint you must know
`@payloadcms/next@3.88.0` declares:
```
next: ">=15.2.9 <15.3.0 || >=15.3.9 <15.4.0 || >=15.4.11 <15.5.0 || >=16.2.6 <17.0.0"
```
Installed: **`next@16.3.4`** — inside the `>=16.2.6 <17.0.0` window. Stage 01
performed this upgrade under `ADR-0017`; it removed every **deployed**
high-severity advisory (14 advisories → 11, high 6 → 3, and the remaining three
are dev-only Prisma chain). **Check this range before any further Next upgrade** —
17.x is outside it.

Two consequences of being on 16.x:
- The edge gate is **`src/proxy.ts`**, not `middleware.ts`. Next 16 deprecated
  the old convention; the handler export is `proxy`. Verified against Next's own
  loader (`(isProxy ? mod.proxy : mod.middleware) || mod.default`).
- `eslint-config-next` is **native flat config**. Do not reintroduce
  `FlatCompat` — passing flat config through it throws a circular-structure error.

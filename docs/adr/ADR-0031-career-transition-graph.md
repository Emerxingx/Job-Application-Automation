# ADR-0031 - The career transition graph and engine: licensed reference rows, a deterministic transition analysis with provenance on every step, versioned plans, and a counterfactual that runs the eligibility engine twice

**Status:** Accepted (Stage 16, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 16 (Product 4), gap G-20 · **Depends on:** ADR-0003 (CMS holds narrative, transactional data is Prisma), ADR-0007 (nothing sensitive reaches a scoring or recommendation path), ADR-0009 (licence-gated taxonomy ingestion), ADR-0021 (the eligibility engine is pure and never a number), ADR-0030 (entitlements)

## Context

The product question is *"will this course or certification materially
improve my eligibility for the jobs I want?"*. Before this stage the
repository could not ask it: learning paths, certifications and career
guides were Payload CMS collections - editorial narrative, correctly placed
under ADR-0003 - and nothing joined a credential to an occupation, an
occupation to the skills it asks for, or an offering to the skills it states
it teaches. Stage 04 gave the occupational spine and the licence gate;
Stage 07 gave a pure eligibility engine with a `licensure` rule that reads
the candidate's certifications; Stage 15 gave entitlements. What was missing
was the graph and an engine that answers with a traceable computation.

Two honesty pressures shape the design. Provider and credential data is
licensed content (Job Bank's regulated-occupation requirements, the CICIC
directory), so nothing may be loaded except under a recorded licence and
every row must be purgeable when a licence is refused. And the platform
must not fabricate: a credential's recognition, a course's outcome, an
employer's acceptance or a hire are things a dataset or an employer states,
never things the engine infers.

## Decision

1. **The graph is transactional and licence-gated.** `Credential`,
   `CredentialSkill`, `OccupationCredential`, `LearningProvider`,
   `LearningOffering` and `OfferingSkill` are reference rows (RLS
   `reference`: every tenant may read them, only the system writes),
   each carrying the `TaxonomyDataset` it came from. `loadLearningGraph`
   refuses unless `requireIngestible()` passes (the Stage 04 gate: licence
   recorded AND ingestion approved), matches occupations by NOC 2021 code
   through `OccupationCode` and **reports a code the spine does not hold
   rather than inventing an occupation**, and matches skills to the shared
   `Skill` table by normalised name. A row another dataset loaded (the same
   slug, or the same occupation-skill pair) is never overwritten or
   re-parented: it is reported as a conflict, so a later prohibition purges
   exactly what each licence loaded. A prohibition purges everything the
   dataset loaded in the same transaction (`purgeDataset`, extended) and
   WITHDRAWS the dataset's content from every stored plan and milestone
   first (`withdraw.ts`: the steps read as withdrawn, the attribution and
   offering names leave the stored JSON, the key is listed under
   `withdrawn`). An operator loads a file with
   `npm run taxonomy:load-learning -- <file> <key>` after the licence is
   recorded; a `*fixture*` key cannot be recorded in production. Three
   datasets are registered: `esdc-regulated-occupations`, `cicic-programs`
   (both `unrecorded`; counsel review L-2) and `learning-fixture` (tests
   only). The CMS collections stay as narrative; nothing in the graph reads
   or writes them (ADR-0003).
2. **The engine is pure and deterministic** (`src/lib/career/engine.ts`,
   `ENGINE_VERSION`): from the target occupation's skills and credential
   requirements, the candidate's structured profile (skills by id or
   normalised name, certification names), the licensed offerings, the
   postings this deployment holds and the career paths the dataset
   records, it computes what transfers, the gaps by kind (skill,
   credential - required, preferred or regulated), a difficulty score with
   named factors and a band, a pathway (credentials first, then a greedy
   set cover of offerings over the remaining skill gaps, then an explicit
   "no licensed offering covers X yet" step - or, when the person's plan
   does not include learning recommendations, a "not shown under your plan"
   step, so a stored plan never reads as "the graph holds nothing" when the
   offerings were merely withheld - then bridge roles) and the provenance
   of every step. Ordering is total: importance, then name (ICU, `en`),
   then the id; the same input always yields the same output. A
   certification recorded as not yet held ("in progress", "candidate", …)
   is not held, and one whose recorded expiry has passed is not held - the
   same vocabulary the eligibility engine uses, so the plan and the verdict
   agree. It never calls a model provider (static test) and never
   reads the sensitive schema (ADR-0007; the Stage 02 allowlist test covers
   it). The market signal is what THIS deployment holds and says so.
3. **The counterfactual is the Stage 07 engine run twice.** `credentialCounterfactual`
   evaluates the candidate's facts against the posting's stated requirements
   with and without the credential's spellings added to their
   certifications; the answer is the difference, rule by rule, and
   `materiallyChanged` is true only when the verdict itself moved. It is
   exposed on the job page ("what if I held it?") and as
   `POST /api/career/whatif`, where the read of the candidate's facts is
   audited (`eligibility.profile.read`, reason `api`) like every other.
4. **Plans are versioned, never edited.** `CareerPlan` stores the analysis
   JSON with its engine version; a refresh writes version n+1 with
   `supersedesId` and archives n, carrying a `done` milestone forward by
   title. `CareerPlanMilestone` rows are the person's own (RLS `user`); a
   completed milestone may cite one of their own APPROVED `CareerEvidence`
   claims and nothing else, so "done" is backed by something the documents
   can also say (Stage 03). Both tables are the person's on the tenant path.
5. **Access is an entitlement, not a plan column** (ADR-0030).
   `career_transition_per_month` bounds new analyses in a rolling 30-day
   window (a refresh does not count); `learning_recommendations` decides
   whether offerings are shown - the gaps are always shown, because knowing
   what is missing is not the paid part, and the withheld pathway says why.
6. **Dataset facts are read on the system client, deliberately.**
   `TaxonomyDataset` is system-only under RLS (it records who recorded a
   licence), so a relation include on the tenant path returns null and
   would silently drop every provenance and hide every offering.
   `datasetFacts()` reads key, attribution and licence state once per
   request on the system client - reference metadata, never a tenant's
   data, the same read `attributionFor()` makes - and the loaders take it
   as a parameter. This is the one documented system-client read inside
   the career path.

## Consequences

- The platform answers the Stage 16 question with a traceable computation:
  every gap, step and verdict change names its rule or its dataset.
- Until a licence is recorded the graph is empty: the pathway says "no
  licensed offering covers X yet" rather than recommending anything, the
  what-if panel does not appear, and the page says where data would come
  from. This is the fail-closed design, not a defect.
- Recognition is a string the dataset states (`regulated · industry ·
  vendor · unverified`); the engine weights `regulated` and `required`
  higher for difficulty but promises nothing about acceptance.
- No outcome is predicted anywhere - not an interview, a hire or a salary -
  and the honesty caveats are part of every stored analysis.
- Per-seat, employer-side and case-manager uses of the graph are Stage 17-19
  work and are not claimed.

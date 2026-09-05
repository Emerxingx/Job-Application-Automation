# Stage 16 - Career transition, learning and certification OS - evidence

Recorded 2026-09-05 on branch `claude/stage-16-career-transition`
(PR #28), stacked on Stage 15 (PR #27) - 14 (#26) - 13 (#25) - 12 (#24) -
11 (#23) - 10 (#22) - 09 (#21) - 08 (#20) - 07 (#19) - 06 (#18) - 05 (#17) -
04 (#16) - 03 (#15) - 02 (#14) - 01 (#13, PARTIAL). Every line was run or
read; nothing is PASS on the strength of a mock, a skipped test or a
document. This stage's honest centre: **the platform now answers "will this
credential materially improve my eligibility?" with a traceable computation
- the graph is transactional and licence-gated, the engine is pure and
cites a dataset on every step, the counterfactual is the Stage 07 engine run
twice - and the graph holds NOTHING outside a test database, because no
learning dataset's licence has been recorded (L-2). The exit gate ("graph
queryable; counterfactual demonstrated") is met on the fixture and stated
as such.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 16 (Product 4): a transactional graph -
skills, occupations, career paths, courses and programs, credentials,
providers, prerequisites, duration, delivery mode, cost, recognition, expiry,
renewal, skills acquired - and a transition engine: current occupation ->
transferable skills -> candidate occupations -> market attractiveness ->
transition difficulty -> gaps (skill / experience / education /
certification) -> learning pathway -> experience bridge -> target jobs. The
CMS keeps the narrative (ADR-0003). Security: provider and credential data
is licensed content - record terms. Testing: gap-computation correctness and
a counterfactual proving a completed credential measurably changes
eligibility. Exit gate: graph queryable; counterfactual demonstrated.

## 2. The graph - `PASS` (empty outside a test database, by design)

Eight tables (migration `20260905140000_career_graph`; RLS generated in
`20260905140100_rls_career_graph`): `Credential` (kind, issuer,
jurisdiction, recognition as STATED, regulated, validity, renewal,
spellings), `CredentialSkill`, `OccupationCredential` (required · preferred
· regulated, per jurisdiction), `LearningProvider`, `LearningOffering`
(delivery mode, duration, cost, prerequisites, the credential it leads to),
`OfferingSkill` - all `reference` (readable by every tenant, written by the
system only) and each carrying its `TaxonomyDataset`; `CareerPlan` and
`CareerPlanMilestone` - the person's own (`user`). `OccupationSkill`
(Stage 04, previously unwired) now carries what a licensed learning
dataset states an occupation asks for. `src/lib/career/loader.ts` loads a
validated file only through `requireIngestible()` (ADR-0009), resolves
occupations by NOC 2021 code and **reports an unknown code instead of
inventing an occupation** (the fixture's `99999` is reported, not loaded),
and a prohibition purges every row the dataset loaded in one transaction
(`purgeDataset`, extended). Three datasets are registered:
`esdc-regulated-occupations` and `cicic-programs` (both **unrecorded**,
counsel review L-2 - `SOURCE_ACCESS_POLICY.md`) and `learning-fixture`
(tests only). Every row in every table is classified in
`src/lib/tenancy/rls-tables.ts` (coverage test).

## 3. The engine - `PASS`

`src/lib/career/engine.ts` (`ENGINE_VERSION` recorded on every plan) is
pure: transferable skills (by shared skill id or normalised name), gaps by
kind (skill with importance and which offerings cover it; credential with
requirement, regulated flag and recognition as stated), difficulty as named
factors summing to a banded score (skills 4-20 by importance; credentials
30 regulated / 15 required / 5 preferred; -5 for a lateral move at the same
TEER when the dataset records no bridge role between the two), the market signal (postings THIS deployment holds, said so), a
pathway - credentials first via an offering when one leads to it, then a
deterministic greedy set cover of offerings over the remaining skill gaps,
then an explicit "no licensed offering in the graph covers X yet" step with
no provenance (or, for a person whose plan does not include learning
recommendations, a "not shown under your plan" step - the stored plan says
withheld, never absent), then bridge roles from the dataset's `CareerPath`
rows - and
the provenance of every step. Four honesty caveats travel with every
stored analysis. A static test proves nothing under `src/lib/career`
imports the AI gateway, a provider SDK, the mailbox or the sensitive path.

## 4. The counterfactual - `PASS` (demonstrated on the fixture)

`credentialCounterfactual` runs the Stage 07 eligibility engine on the
candidate's facts and the posting's stated requirements, then again with the
credential's spellings added to the certifications; the answer is the list
of rules whose status changed and whether the verdict moved. Worked
transition, in tests and on the page: a Canadian citizen with no
certifications against a posting titled "CPA - Senior Accountant" that
requires the CPA is **ineligible** (licensure fails); holding the regulated
CPA (recognition `regulated`, provenance the fixture) the verdict is
**eligible**, and exactly one rule changed (`licensure`: fail -> pass). A
credential the posting does not ask for changes nothing and says so.
Exposed on the job page ("what if I held it?" - the panel lists the
credentials the posting's occupation carries under a recorded licence, for
a person whose plan includes the analysis) and as `POST /api/career/whatif`
(any servable credential against any posting; refused without the
entitlement; rate-limited, because every call is the audited Stage 07 read
of the candidate's facts, `eligibility.profile.read`, reason `api`).

## 5. Plans, milestones and access - `PASS`

`/dashboard/career` (pick a target from the licensed spine, optionally a
current occupation; the page says where the data comes from and that
nothing predicts an outcome) and `/dashboard/career/:planId` (difficulty
with factors, what transfers, gaps, the pathway with a source on each step,
milestones, postings held here, the caveats and the datasets used).
`POST /api/career/plans` stores version 1 with milestones from the pathway;
`PATCH … {action: refresh}` writes version n+1 with `supersedesId`, archives
n and carries a `done` milestone forward by title; `archive` retires.
`PATCH /api/career/milestones/:id` moves a milestone; `done` may cite one of
the person's own APPROVED `CareerEvidence` claims and nothing else (a draft
or another person's is refused, 422). Access: `career_transition_per_month`
bounds new analyses in a rolling 30-day window (a refresh does not count);
`learning_recommendations` decides whether the pathway's offerings are shown
- the gaps are always shown and a withheld pathway says why (ADR-0030;
`ENTITLEMENT_MATRIX.md`). Every read and write is on the tenant path;
dataset facts (key, attribution, licence state) are read once per request
on the system client because `TaxonomyDataset` is system-only (ADR-0031 §6
says why, and the code says it too).

## 6. Tests - `PASS`

`tests/career-engine.test.ts` (8, pure + static) and `tests/career.test.ts`
(1 pure, 7 database): every case in `TEST_STRATEGY.md` §Stage 16 - holding
by id, name or whole-word spelling; transfers vs gaps, ordering, pricing,
banding; the pathway's shape and provenance; determinism and "nothing
invented"; the offering and credential counterfactuals; the loader's
validation and licence gate; an unmatched NOC reported; idempotent load;
the engine on the tenant path for the entitled and the unentitled; plan
versioning, the budget and its refusals; the evidence rule; RLS ownership
and reference readability; the counterfactual on real rows with provenance;
the purge on prohibition. The review round (§11) added: the withheld pathway (pure and the stored plan), the not-yet-held and dotted spellings, withdrawal from a stored analysis, conflicts between datasets, the milestone rules, an expired certification, a refresh without the entitlement, the tenant-path write refusal on reference tables, and the in-progress certification in the eligibility suite. Root suite: 1130 / 1130 (0 skipped).

## 7. What is NOT done, and why

- **No learning dataset is recorded.** Job Bank's regulated-occupation
  requirements and the CICIC directory are registered `unrecorded`; the
  loaders exist and are proven on the fixture, and nothing is loaded until
  an administrator records the licence and attribution at
  `/console/taxonomy` after counsel review (L-2). Outside a test database
  the graph is empty and every page says so.
- **The occupational spine is still empty** (Stage 04, L-2): a target
  occupation can only be picked once NOC 2021 is recorded and loaded.
- **Market attractiveness is this deployment's postings**, not the labour
  market; no external labour-market series is licensed.
- **No outcome is predicted** - not an interview, a hire or a salary - and
  no recognition is inferred: `recognition` is a string the dataset states.
- **The CMS collections** (`LearningPaths`, `Certifications`,
  `CareerGuides`) stay narrative; nothing links them to the graph yet.
- **No scheduler**: plans are refreshed by the person.

## 8. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 7 warnings (baseline ceiling 8) |
| Typecheck | 0 |
| Tests | **1130 / 1130**, 0 skipped (Stage 15: 1109) - new: `career-engine` 10, `career` 10 |
| Build | passes; `/dashboard/career`, `/dashboard/career/[planId]`, `/api/career/*` present |
| Migrations | **forty-one** (three new, additive; RLS generated); fresh-database rehearsal: 41 applied, `migrate diff` clean, **129** forced-RLS tables in `public` |

## 9. Exit gate - verdict

| Exit criterion | Verdict |
| --- | --- |
| Graph queryable | **PASS** - eight tables, reference RLS, loaded through the licence gate, queried on the tenant path by the engine |
| Counterfactual demonstrated | **PASS** - pure and against the database: the regulated CPA turns ineligible into eligible on exactly the licensure rule |
| The question answered with a traceable computation | **PASS** - every gap, step and verdict change names its rule or its dataset; the analysis is stored with its engine version |
| Provider / credential terms recorded | **BLOCKED (LEGAL, L-2)** - datasets registered, nothing recorded; no row exists outside a test database |

**Stage 16: PASS on engineering; the product is empty until a licence is
recorded, and says so.** Merge posture inherited from the stack.

## 10. What a founder or operator has to do

1. Counsel review of the Job Bank and CICIC terms (L-2); then record the
   licence and attribution at `/console/taxonomy` and load the data.
2. The same for NOC 2021 (Stage 04), without which no target can be chosen.
3. Decide whether the CMS narrative collections should link to graph rows
   (a content-model change, not an engine change).

## 11. Independent review

An independent adversarial review of the Stage 16 diff (a separate agent
with the whole tree, asked to break isolation, honesty, the entitlement and
licence gates, the engine, the data model and the docs) returned 1 HIGH,
5 MEDIUM and 10 LOW findings. Every HIGH and MEDIUM is fixed on the branch;
every LOW is fixed or recorded here. Nothing was suppressed.

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| H1 | HIGH | An unentitled person's STORED plan asserted "no licensed offering covers X" when the offerings were merely withheld, and the milestones repeated it. | Fixed: `offeringsWithheld` is an engine input and part of the stored analysis; coverage is `null` (unknown), the pathway carries a `withheld` step ("not shown under your plan"), one milestone says so, the plan page says so. Tested pure and on the stored plan. |
| M2 | MEDIUM | The 30-day budget and the refresh chain were read-then-write races: two concurrent creates both saw the budget unspent; two refreshes both superseded one version. | Fixed: a transaction-scoped advisory lock per person in `createCareerPlan` and `refreshCareerPlan`; `CareerPlan.supersedesId` is unique (migration `20260905150000_career_plan_supersedes_unique`). |
| M3 | MEDIUM | The loader upserted by global slug and overwrote `datasetId`, so a second dataset could take over another's rows and a prohibition would purge the wrong content; `OccupationSkill` rows of another source were overwritten. | Fixed: a row another dataset owns is reported as a `conflict` and left alone (credential, provider, offering, occupation-skill, occupation-credential); tested with a second dataset. |
| M4 | MEDIUM | A prohibition left offering titles, provider names and the attribution string in every stored plan and milestone. | Fixed: `withdraw.ts` runs inside `purgeDataset` before the rows go - steps and coverage that cite the dataset read as withdrawn, the key is listed under `withdrawn`, milestones that cited a purged offering or credential are retitled; tested pure and on the database (the attribution string is gone from the stored JSON). |
| M5 | MEDIUM | "CPA (in progress)" counted as holding the regulated CPA, in the career engine and in the Stage 07 licensure rule. | Fixed in both with one shared vocabulary (`NOT_YET_HELD`; a test asserts the two are identical); `RULES_VERSION` bumped so stored verdicts re-evaluate. |
| M6 | MEDIUM | The docs said an operator loads a dataset; no load path existed, and nothing stopped a fixture being recorded in production. | Fixed: `npm run taxonomy:load-learning -- <file> <key>`; `recordDatasetLicence` refuses a `*fixture*` key in production. |
| L7 | LOW | The two engines normalised certifications differently ("P. Eng"). | Fixed: `certificationTerm` matches the eligibility engine's normalisation; tested. |
| L8 | LOW | `POST /api/career/whatif` wrote an audit row per call with no limit; the panel rendered for the unentitled. | Fixed: rate-limited (`careerWhatIf`, 20 per 10 minutes) and the job page renders the panel only for a person whose plan includes the analysis. |
| L9 | LOW | `licensed()` failed open on a null dataset and differed from `loadOfferings`. | Fixed: one `isServable` predicate (recorded AND approved; null is not servable) for every reader, the job page included. |
| L10 | LOW | `purgeLearningGraph` was dead and incomplete. | Fixed: deleted; `purgeDataset` is the one purge. |
| L11 | LOW | A re-load incremented `rowCount` and left stale skill links. | Fixed: `rowCount` is recounted; links a file no longer lists are removed. |
| L12 | LOW | Milestone rules were looser than documented. | Fixed: evidence only with `done`, cleared on leaving it, no edits on an archived version; tested. |
| L13 | LOW | A refresh ran with no entitlement at all. | Fixed: a refresh needs the analysis to be included (limit > 0), still spends no unit; tested. ADR §5 says so. |
| L14 | LOW | Certification expiry was ignored. | Fixed: a certification whose recorded expiry has passed is not held; tested. |
| L15 | LOW | Doc claims: "ties break by id", the lateral condition, the what-if scope. | Fixed: the ordering is now total (importance, name, id) and the ADR and this document say exactly what the code does. |
| L16 | LOW | Test gaps. | Partly fixed (see §6); no concurrency test - the advisory lock is the mechanism and is the same one Stage 12 relies on. A route-level suite is not added. |

Verification after the fixes: typecheck 0, lint 0 errors / 7 warnings,
`1130 / 1130` tests (0 skipped), build passes, fresh rehearsal 41
migrations, drift clean, 129 forced tables.

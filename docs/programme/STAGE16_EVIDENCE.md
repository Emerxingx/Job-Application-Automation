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
TEER), the market signal (postings THIS deployment holds, said so), a
pathway - credentials first via an offering when one leads to it, then a
deterministic greedy set cover of offerings over the remaining skill gaps,
then an explicit "no licensed offering in the graph covers X yet" step with
no provenance, then bridge roles from the dataset's `CareerPath` rows - and
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
Exposed on the job page ("what if I held it?", only for credentials the
posting's occupation lists under a recorded licence) and as
`POST /api/career/whatif`, where the candidate's facts are read with the
audited Stage 07 read (`eligibility.profile.read`, reason `api`).

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
the purge on prohibition. Root suite: 1126 / 1126 (0 skipped).

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
| Tests | **1126 / 1126**, 0 skipped (Stage 15: 1109) - new: `career-engine` 8, `career` 8 |
| Build | passes; `/dashboard/career`, `/dashboard/career/[planId]`, `/api/career/*` present |
| Migrations | **forty** (two new, additive; RLS generated); fresh-database rehearsal: 40 applied, `migrate diff` clean, **129** forced-RLS tables in `public` |

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

__REVIEW__

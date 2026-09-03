# Stage 08 — Compatibility and recommendation engine — evidence

Recorded 2026-09-03 on branch `claude/stage-08-compatibility-engine` ([PR #20](https://github.com/Emerxingx/Job-Application-Automation/pull/20), draft), stacked
on Stage 07 (PR #19) → 06 (#18) → 05 (#17) → 04 (#16) → 03 (#15) → 02 (#14)
→ 01 (#13, PARTIAL). Every line was run or read; nothing is PASS on the
strength of a mock, a skipped test or a document. This stage's honest centre:
**the mandated pipeline is complete around the preserved deterministic
engine, weights are governed data and every score decomposes into cited
dimensions; the semantic stage is a deterministic equivalence map because
pgvector is not available anywhere this codebase can reach, and no
embedding is pretended.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 08: transparent compatibility, never
`resume + JD → LLM → %`. Preserve the deterministic engine. Complete the
pipeline: parse → eligibility → requirement extraction → **evidence
retrieval** → deterministic compare → semantic compare (pgvector) →
weighted score → explanation. Weights become admin-configurable data with
versioning; every score records the weight version used;
`match_dimensions` persists per-dimension contribution. Testing:
scoring-consistency, weight-change regression, explanation completeness.
Acceptance: every score decomposable into named dimensions with cited
evidence. Exit gate: pipeline complete; weights admin-editable and versioned.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903160000_compatibility_engine` | `MatchDimension` (one row per named dimension of a match: score, weight, contribution, matched / missing items, cited evidence ids, note; unique per match and dimension); `MatchWeightVersion` (the governed register; **nothing seeded active**); `JobMatch.weightVersion` (default `builtin:1`) and `pipelineVersion`; classification comments | applied fresh and incrementally; drift clean |
| `20260903160100_rls_matching_tables` | Generated (manifest `RLS_MANIFESTS[7]`): `MatchDimension` user-owned (`userId`); `MatchWeightVersion` system | determinism test; a tenant reads their own dimension rows only and the register not at all (tested); **103/103** public tables forced |

## 3. The pipeline — `PASS`

`src/lib/matching/pipeline.ts`, `scoreCompatibility()`:

| Stage | What runs | Where it comes from |
| --- | --- | --- |
| parse | the canonical job (`Job` row) | Stage 06 |
| eligibility | evaluated BEFORE this pipeline; an ineligible posting never reaches it | Stage 07 (`scanner.ts`) |
| requirement extraction | `requiredSkills`, `preferredSkills`, `certificationRequirements` and `experienceYearsMin` reach the engine (`MatchOptions.requirements`): a missing nice-to-have costs half a requirement and is marked `preferred`; a required credential counts in full; the extracted minimum years replaces the regex over the requirements text. **Education requirements are NOT scored** — the engine has no education dimension and inventing one would change the weights contract; they remain visible on the posting (stated limit) | `jobRequirements()` over Stage 06 columns; tested |
| evidence retrieval | the candidate's approved `CareerEvidence` (ids, claims, kinds) loaded on the tenant path | Stage 03 `loadEvidenceForGeneration()`, now with `entries` |
| deterministic compare | the PRESERVED engine (`MockAIProvider.analyzeMatch`) through the gateway — policy resolved before dispatch, `AiRun` written, grounding unchanged — with the weights, the equivalence map and the requirements injected; the posting's skills are deduplicated under the map so a spelling variant never counts twice | Stage 00 engine, Stage 03 gateway |
| semantic compare | a closed equivalence map over the skill vocabulary applied to both sides; a match made through it is persisted on the skills dimension as `{ term, how: 'semantic', via }` and shown on the job page ("postgres ≈ postgresql") | `src/lib/matching/semantic.ts` — **pgvector BLOCKED** (§5) |
| weighted score | the active `MatchWeightVersion`, else the built-in baseline recorded as `builtin:1`; the recorded score is `combineScore(breakdown, weights)` (weighted sum × domain fit) on EVERY route — on the deterministic route it equals the engine's own number, on an external route it replaces the model's, so `weightVersion` always describes the score | `src/lib/matching/weights.ts`, `keywords.ts` |
| explanation | the engine's rationale plus one `DimensionResult` per dimension: score, weight, contribution, matched items with HOW they matched, missing items with their LEVEL, cited evidence ids, a note. The keyword-density row decomposes into the tokens the density score counted, not the skills list; citations require the term to be found the way the engine finds it (an ambiguous word such as "go" needs a skill claim or a proper-noun spelling); seniority cites the employment claims carrying the highest-level title; location cites nothing and says it is a profile fact | `scoreCompatibility()`, `citeEvidence()`, `keywordOverlap()` |

The scanner writes the `JobMatch` with `weightVersion` and
`pipelineVersion` and its five `MatchDimension` rows in one create. The job
page shows each dimension's weight, note and up to three cited claims, and
the versions the score was computed with.

## 4. Worked example — the full chain on one posting

Run against the local database with the built-in weights (script in the
session, not committed; the numbers are the engine's, unedited). Candidate:
"Senior Data Analyst" with PostgreSQL, SQL, Python, Tableau, dbt; one
employment row (2021-01 to present); evidence derived from the profile and
approved (9 claims). Posting: "Senior Data Analyst" at Maple Analytics,
Toronto, hybrid; "Strong SQL and Postgres", "Python and Tableau", "3+ years",
"Nice to have: Looker".

```
CANONICAL required ["postgres","python","sql","tableau"] preferred ["looker"] years 3
SCORE 93 weights builtin:1 pipeline 2026-09-03.2 route deterministic policy EXTERNAL_AI_PROHIBITED
SEMANTIC [{"required":"postgres","satisfiedBy":"postgresql","how":"semantic"}]
DIM skills     score  89 weight 0.34 contribution 30.26
    matched=[{"term":"postgres","how":"semantic","via":"postgresql"},{"term":"python","how":"exact"},{"term":"sql","how":"exact"},{"term":"tableau","how":"exact"}]
    missing=[{"term":"looker","level":"preferred"}]
    evidence=[Built PostgreSQL reporting for finance | Python pipelines cut latency | Skill: PostgreSQL | Skill: SQL | Skill: Python | Skill: Tableau]
    — 4 of 4 required skills evidenced; 0 of 1 nice-to-haves (1 through the equivalence map) — 6 supporting claims.
DIM keywords   score 100 weight 0.22 contribution 22
    matched=[analyst, data, python, senior, sql, tableau (all exact)]   missing=[looker, postgres (level: wording)]
    evidence=[Senior Data Analyst at Northbridge (Toronto), 2021-01 to present | Built PostgreSQL reporting for finance | Python pipelines cut latency | Skill: SQL | Skill: Python | Skill: Tableau]
    — 6 of 8 terms from the posting's title, requirements and skills wording appear in the résumé; 6 supporting claims.
DIM experience score  96 weight 0.22 contribution 21.12
    evidence=[Senior Data Analyst at Northbridge (Toronto), 2021-01 to present]
    — Years of experience against the posting's stated requirement, summed from 1 employment claim.
DIM seniority  score 100 weight 0.14 contribution 14
    evidence=[Senior Data Analyst at Northbridge (Toronto), 2021-01 to present]
    — Highest résumé title level against the posting's title, from 1 employment claim.
DIM location   score  70 weight 0.08 contribution 5.6
    — Profile location against the posting's; remote is always reachable. A profile fact, not an evidence claim.
RATIONALE Excellent fit — this profile should clear both ATS filters and a recruiter screen. You match 4 of 5 named skills. Your 5.7 years of experience meets the 3-year requirement.
```

Reading it: the posting's "Postgres" was satisfied by the résumé's
"PostgreSQL" through the equivalence map and the row says so (`how:
semantic, via: postgresql`); "Looker", which the extraction placed in
`preferredSkills`, is missing and marked `preferred` — it costs half a
requirement, so the skills score is 4 ÷ 4.5 = 89, not 80; the skills row
cites the six approved claims that carry the matched terms; the keyword
row decomposes into the six posting tokens the density score counted and
the two it did not (density is lexical: "postgres" is not in a résumé that
says "PostgreSQL", and the row says `wording`, not requirement); experience
and seniority cite the employment claim; location cites nothing and says
why. The contributions (30.26 + 22 + 21.12 + 14 + 5.6 = 92.98) are scaled
by the domain-fit factor (skills 89 → 1.0) to the recorded 93, which is
`combineScore(breakdown, builtin:1)`. Route `deterministic`, policy
`EXTERNAL_AI_PROHIBITED`: no model was called (Stage 03 fail-closed).

## 5. The semantic stage — honest scope

The `vector` extension is **not available** on the local PostgreSQL 16 or
the CI service container (`pg_available_extensions` returns nothing), and
the staging project is unreachable from the build environment (R-34). No
embedding is computed anywhere in this codebase and none is pretended:
`INTEGRATION_REGISTER.md` lists pgvector as BLOCKED. What runs is a closed
equivalence map (spellings, abbreviations, near-synonyms of the vocabulary:
`postgres`/`postgresql`, `k8s`/`kubernetes`, `ml`/`machine learning`, …),
applied to both sides before comparison — the posting's own spellings are
deduplicated under it — and every match made through it is persisted on the
skills dimension (`{ term, how: 'semantic', via }`) and shown to the
candidate as such ("postgres ≈ postgresql" on the job page). The map is data
and is reviewed like any other change. An embedding comparer can replace it
behind the same function when the extension exists; nothing else changes.

## 6. Weights as governed data — `PASS`

`src/lib/matching/weights.ts`, `/console/match-weights`,
`/api/console/match-weights[/id]`: the PromptVersion LIFECYCLE and
separation of duties — draft → approved by a SECOND admin → active (one at a
time; activating an older version is the rollback, recorded as one) →
retired; every change step-up re-authenticated and audited
(`match_weights.*`); validation (every dimension named, each in [0, 1],
summing to 1); advisory lock; the active version read cache-first on the
system client only, most recent activation first, and invalidated on
activation. **Unlike a prompt, a weight version has no evaluation gate**
(there is no scored corpus to evaluate against); activation therefore
requires a mandatory reason, recorded in the audit (tested). A stored row
that no longer validates degrades to the baseline with a logged error
rather than failing every scan. **Nothing is seeded active**: until an admin
activates a version the built-in constants apply and are recorded as
`builtin:1` — the tested baseline, not a silent default.

| Assertion (`tests/match-weights.test.ts`) | Result |
| --- | --- |
| No active version → the built-in baseline, recorded as `builtin:1` | PASS |
| The scanner writes `weightVersion`, `pipelineVersion` and one dimension row per dimension; each row's score is the breakdown value, contribution = score × weight, weights sum to 1, every row explains itself; the skills row names matched and missing | PASS |
| create → approve (second admin; the author is refused) → activate; a bad sum is refused | PASS |
| **Regression**: matches scored before an activation keep their score and `builtin:1`; a new scan after it scores with `v1` and its dimension rows carry the new weights | PASS |
| v2 then v1 again is recorded as `match_weights.rollback` with the reason; the active version cannot be retired; exactly one active | PASS |
| Tenants read their own dimension rows only and cannot see the register | PASS |

## 7. Consistency, semantics and explanation — `PASS` (pure)

`tests/matching-pipeline.test.ts`: the same inputs give the same score and
breakdown across 25 runs; the equivalence map lets "PostgreSQL" satisfy
"postgres" while without it the posting term is missing; a different weight
version changes the score but not the measured breakdown; absent weights
equal the baseline; weight validation; evidence citation under the map and
by kind.

## 8. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **982 / 982**, 0 skipped (Stage 07: 964) — new: `matching-pipeline` 12, `match-weights` 5 |
| Build | passes; `/console/match-weights`, `/api/console/match-weights` present |
| Migrations | twenty-three applied fresh; drift clean; 103/103 forced; RLS migration equals the generator output |

Run with the documented command only (the two test URLs; `DATABASE_URL` /
`DIRECT_URL` unset).

## 9. Exit gate — verdict

| Condition | State |
| --- | --- |
| Pipeline complete | **MET** — every mandated stage runs in order around the preserved engine; the semantic stage is deterministic (§5) |
| Weights admin-editable and versioned; every score records the version | **MET** |
| Every score decomposable into named dimensions with cited evidence | **MET** — five `MatchDimension` rows per match; the page shows them with the claims |
| Scoring consistency, weight-change regression, explanation completeness | **MET** (tests) |
| Semantic compare with pgvector | **NOT MET — BLOCKED (EXTERNAL_SERVICE)**: the extension is unavailable locally and in CI; the deterministic map runs in its place and says so |

**Verdict: Stage 08 passes every engineering gate; its exit is PARTIAL** on
the absence of pgvector, stated rather than approximated, and on the same
inherited cause as Stages 05–07 (no real traffic). Merge posture inherited
from the stack.

## 10. What a founder or operator has to do

1. Decide the first governed weight version: create it at
   `/console/match-weights`, have a second admin approve it, activate it.
   Until then the built-in baseline scores and says so.
2. pgvector: when the staging project is reachable, confirm the extension is
   enabled there and enable it on the CI service image; the embedding
   comparer is then a Stage 08 follow-up behind the same function.
3. Staging — unchanged (R-34).

## 11. Independent review — findings and what was done

An adversarial review of `git diff 021ba1f..2d87e99` (isolation, authz,
migration safety, secrets, scoring correctness, dead code, false PASS)
returned **0 HIGH · 5 MEDIUM · 5 LOW · 5 INFO**. Every MEDIUM and LOW is
closed in the review commit, each with a test; the INFO items are recorded.

| # | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | MEDIUM | Three of the five documented requirement inputs were dead (`experienceYearsMin`, education, certifications) and required/preferred were merged, so a nice-to-have cost as much as a requirement while §3 claimed otherwise | `MatchOptions.requirements` reaches the engine: a preferred-only miss weighs 0.5, a certification requirement counts as required, the extracted minimum replaces the regex; education is dropped from `JobRequirements` and stated as NOT scored (§3). Tests: 80 vs 67, 57 / 86 with a credential, "asks for 10 years" |
| 2 | MEDIUM | `semanticMatches` was computed and discarded; nothing was persisted or shown as `semantic` | `MatchedItem { term, how, via }` persisted on the skills row; the job page shows "postgres ≈ postgresql"; `resumeTerms` built from the engine's own corpus (`resumeCorpusText`). Tested end to end against the database |
| 3 | MEDIUM | The keywords row's matched items and citations were the skills list, not the density it scored | `keywordOverlap()` over the same `jobSignalText` / `resumeCorpusText` the engine tokenises; the row lists the overlapping tokens, the absent ones (`level: wording`) and cites claims carrying those tokens whole. Tested (`['analyst','data','python','sql']`) |
| 4 | MEDIUM | `citeEvidence` matched bare tokens ("Helped the team go live" cited for Go) | A vocabulary term must be found by the engine's boundary-aware pattern; an ambiguous word (`AMBIGUOUS_TERMS`) needs a skill claim or a non-sentence-initial proper-noun spelling; a plain token must be whole, ≥ 3 letters and not a stop word. Tested with "go live", "Skill: Go", "in Go", "golang", "Google Ads", "in R", "Rest days" |
| 5 | MEDIUM | The map was applied to the résumé only; "PostgreSQL" in the description plus "postgres" in the skills field counted twice | The posting's skills are deduplicated under the map (first spelling kept). Tested: one match, "2 of 3 named skills" |
| 6 | LOW | `getActiveWeights(client)` on a tenant client would cache the baseline over an activation | Parameter removed; always the system client |
| 7 | LOW | An invalid stored row failed every scan | Logged, baseline returned, nothing cached |
| 8 | LOW | No tie-break if two rows were ever active | `orderBy activatedAt desc, version desc` (a partial unique index is not expressible in the Prisma schema and would trip the drift check; noted) |
| 9 | LOW | Experience/seniority/location citations indiscriminate or absent | Experience cites every dated employment claim (they all feed the sum, and the note says so); seniority cites the claims carrying the highest-level title; location says it is a profile fact |
| 10 | LOW | On an external route the model's score would be recorded under `weightVersion` | The recorded score is `combineScore(breakdown, weights)` on every route (`analysis.matchScore` recomputed in the pipeline). Tested equal on the deterministic route |
| 11 | INFO | No evaluation gate for weight activation, unlike prompts; ADR wording overstated the parallel | ADR-0022 §2 corrected; a reason is now mandatory on activation (tested) |
| 12 | INFO | Step-up and the advisory lock were asserted in prose, not by a test; `scoreCompatibility` had no direct test | `scoreCompatibility` now tested directly against the database (§6); step-up on the routes remains covered by the shared `governanceRoute` / `requireStepUp` helpers' own tests, not by a match-weights route test — recorded honestly |
| 13–15 | INFO | Backfill truthful; multi-instance cache staleness ≤ 300 s is harmless because version and weights are cached together; dead code (`citeEvidence` `kinds` used by tests only, education fields) | Recorded; education fields removed |

`PIPELINE_VERSION` is now `2026-09-03.2`; rows scored under `.1` keep their
plain-string `matched` / `missing` and the page shows them without labels.

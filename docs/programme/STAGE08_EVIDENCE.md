# Stage 08 — Compatibility and recommendation engine — evidence

Recorded 2026-09-03 on branch `claude/stage-08-compatibility-engine`, stacked
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
| requirement extraction | `requiredSkills` + `preferredSkills` (separated), `experienceYearsMin`, education and certification requirements, joined with the posting's listed skills so the compare targets what the posting REQUIRES | `jobRequirements()` over Stage 06 columns |
| evidence retrieval | the candidate's approved `CareerEvidence` (ids, claims, kinds) loaded on the tenant path | Stage 03 `loadEvidenceForGeneration()`, now with `entries` |
| deterministic compare | the PRESERVED engine (`MockAIProvider.analyzeMatch`) through the gateway — policy resolved before dispatch, `AiRun` written, grounding unchanged — with the weights and the equivalence map injected | Stage 00 engine, Stage 03 gateway |
| semantic compare | a closed equivalence map over the skill vocabulary applied to both sides; a match made through it is labelled `semantic` | `src/lib/matching/semantic.ts` — **pgvector BLOCKED** (§5) |
| weighted score | the active `MatchWeightVersion`, else the built-in baseline recorded as `builtin:1`; the engine's domain-fit scaling is unchanged | `src/lib/matching/weights.ts` |
| explanation | the engine's rationale plus one `DimensionResult` per dimension: score, weight, contribution, matched, missing, cited evidence ids, a note | `scoreCompatibility()` |

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
SCORE 90 weights builtin:1 pipeline 2026-09-03.1 route deterministic policy EXTERNAL_AI_PROHIBITED
SEMANTIC [{"required":"postgres","satisfiedBy":"postgresql","how":"semantic"}]
DIM skills     score  80 weight 0.34 contribution 27.2  matched=[postgres, python, sql, tableau] missing=[looker]
               evidence=[Built PostgreSQL reporting for finance | Python pipelines cut latency | Skill: PostgreSQL | Skill: SQL | Skill: Python | Skill: Tableau]
               — 4 of 5 named skills evidenced (6 supporting evidence claims).
DIM keywords   score 100 weight 0.22 contribution 22    matched=[postgres, python, sql, tableau] missing=[]  evidence=[same six claims]
DIM experience score  96 weight 0.22 contribution 21.12 evidence=[Senior Data Analyst at Northbridge (Toronto), 2021-01 to present]
               — Years of experience against the posting's stated requirement, from 1 employment claim.
DIM seniority  score 100 weight 0.14 contribution 14    — Distance between the résumé's highest title level and the posting's.
DIM location   score  70 weight 0.08 contribution 5.6   — City or province against the posting's; remote is always reachable.
RATIONALE Excellent fit — this profile should clear both ATS filters and a recruiter screen. You match 4 of 5 named skills. Your 5.7 years of experience meets the 3-year requirement.
```

Reading it: the posting's "Postgres" was satisfied by the résumé's
"PostgreSQL" through the equivalence map and is labelled so; "Looker" (a
nice-to-have the extraction placed in `preferredSkills`) is the one missing
skill; the skills and keywords dimensions cite the six approved claims that
mention the matched terms; experience cites the employment claim; the
contributions (27.2 + 22 + 21.12 + 14 + 5.6 = 89.92) are scaled by the
engine's domain-fit factor to the final 90. Route `deterministic`, policy
`EXTERNAL_AI_PROHIBITED`: no model was called (Stage 03 fail-closed).

## 5. The semantic stage — honest scope

The `vector` extension is **not available** on the local PostgreSQL 16 or
the CI service container (`pg_available_extensions` returns nothing), and
the staging project is unreachable from the build environment (R-34). No
embedding is computed anywhere in this codebase and none is pretended:
`INTEGRATION_REGISTER.md` lists pgvector as BLOCKED. What runs is a closed
equivalence map (spellings, abbreviations, near-synonyms of the vocabulary:
`postgres`/`postgresql`, `k8s`/`kubernetes`, `ml`/`machine learning`, …),
applied to both sides before comparison; every match made through it is
labelled `semantic` and reported to the candidate as such. The map is data
and is reviewed like any other change. An embedding comparer can replace it
behind the same function when the extension exists; nothing else changes.

## 6. Weights as governed data — `PASS`

`src/lib/matching/weights.ts`, `/console/match-weights`,
`/api/console/match-weights[/id]`: the PromptVersion discipline — draft →
approved by a SECOND admin → active (one at a time; activating an older
version is the rollback, recorded as one) → retired; every change step-up
re-authenticated and audited (`match_weights.*`); validation (every
dimension named, each in [0, 1], summing to 1); advisory lock; the active
version read cache-first and invalidated on activation. **Nothing is seeded
active**: until an admin activates a version the built-in constants apply
and are recorded as `builtin:1` — the tested baseline, not a silent default.

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
| Tests | **975 / 975**, 0 skipped (Stage 07: 964) — new: `matching-pipeline` 6, `match-weights` 4 |
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

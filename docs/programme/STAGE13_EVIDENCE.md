# Stage 13 - Candidate dashboards and analytics - evidence

Recorded 2026-09-03 on branch `claude/stage-13-candidate-analytics`, stacked
on Stage 12 (PR #24) - 11 (#23) - 10 (#22) - 09 (#21) - 08 (#20) - 07 (#19) -
06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) - 01 (#13, PARTIAL).
Every line was run or read; nothing is PASS on the strength of a mock, a
skipped test or a document. This stage's honest centre: **the candidate
dashboards now read marts through one metric dictionary, and a static test
refuses a transactional query on those pages. What is NOT built is the
machinery ADR-0012 stages 2 and 3 describe - no event stream feeds the marts
(ADR-0011 is not built) and no scheduler runs the sweep - and one cut the plan
names, industry, does not exist because nothing in the platform classifies
industry.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 13: outcome analytics for candidates -
applications, recruiter responses, screens, interviews, offers, hires; rates;
cuts by title, company, industry, seniority, geography, source, resume version
and compatibility score; served from analytics models (ADR-0012); small-cohort
suppression; metric-definition tests and parity between transactional truth
and marts. Acceptance: every metric has one documented definition and one
source. Exit gate: dashboards read marts, not transactional tables.

## 2. Schema and migrations - `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903210000_candidate_marts` | `CandidateOutcomeMart` (user, day, dimension, key; cumulative-reach counts), `CandidateMatchMart` (user, day; bands and top keywords), `CandidateBenchmarkMart` (day, dimension, key; distinct users) | applied fresh and incrementally; drift clean |
| `20260903210100_rls_candidate_marts` | Generated (manifest `RLS_MANIFESTS[12]`): the two candidate marts user-owned; the benchmark system-only (no tenant policy - tested: a tenant transaction is refused) | determinism test; 120 public tables forced |

## 3. One dictionary - `PASS`

`src/lib/analytics/candidate/dictionary.ts`: twelve counts, seven rates, two
values - each with a key, a label, a one-sentence definition in the
candidate's words, and its mart source; `rateOf` and `valueOf` are the only
computations. `docs/governance/METRIC_DICTIONARY.md` is the human copy;
`tests/candidate-marts.test.ts` fails if any key, label or definition differs,
or if a source names anything but a mart. Dimensions: `all`, `title`,
`company`, `seniority` (from the title's words), `geography`, `source`,
`resume_version`, `score_band`. **`industry` is NOT AVAILABLE** - no industry
classification exists (NOC is occupation) - and is stated, not approximated.

## 4. Reach from history - `PASS`

`marts.ts` (pure): reach is inferred from `ApplicationStatusHistory` plus the
current status. An application that interviewed and was then rejected is an
interview; a withdrawal alone is not a send; a failed preparation reached no
one; an unanswered application is not a zero-hour reply. Attribution is the
record's creation day, so a period's numbers never move because of later
events. The builders are deterministic and order-independent, and on every day
the keys of every dimension sum to `all` (tested).

## 5. The rollup - `PASS`

`rollup.ts` is the only reader of the transactional tables: one query for
the applications created in the window (with history, interviews, job and
the resume version), one for the matches; then the whole (days x user)
scope of each mart is deleted and rewritten inside a transaction, and the
benchmark for those days is rebuilt from the WHOLE outcome mart (a
single-user refresh never shrinks it - tested). A `RollupRun` row records
every run. Two runs over the same rows produce the same rows (tested).

Refresh paths (no scheduler exists): `npm run analytics:rollup` (the
operator's sweep, last 400 days by default); `POST /api/analytics/refresh`
(the candidate's own rows, rate-limited to three per ten minutes); once on a
first visit when the candidate's marts hold nothing.

## 6. Dashboards read marts - `PASS`

`/dashboard/analytics` reads `readCandidateOutcomes` and `readCandidateMatches`
on the tenant path and shows: the KPI row, the keyword panels (from the match
mart's daily tallies), the trend, the funnel, seven cut tables (one per
dimension), the score-band distribution and the reply time - every number a
dictionary metric. The overview's three numbers (applications, sent,
interviews) read `readCandidateTotals`. The static scan in
`tests/candidate-marts.test.ts` refuses a transactional query for a metric in
the read module, the analytics page or the overview. **Scoped and stated:**
the overview's two lists (top matches, recent activity) are operational reads
of the candidate's own rows, not metrics, and stay; the analytics EXPORT
endpoint is a data export, not a dashboard, and still reads the transactional
rows.

Freshness: the page shows the last successful rebuild, flags one older than
a day (or a failed last run), and offers the refresh.

## 7. Parity - `PASS`, with the differences named

`tests/candidate-analytics.test.ts` builds six applications with real
histories, an interview, resume versions and a match, runs the rollup, reads
the mart on the tenant path and compares with the PRE-EXISTING pure engine
(`computeApplicationMetrics`, Stage 00) over the same rows:

| Metric | Mart | Transactional engine | Parity |
| --- | --- | --- | --- |
| applications | 6 | 6 | equal |
| sent | 4 | 4 | equal |
| responded | 3 | 3 | equal |
| offers | 1 | 1 | equal |
| response rate (parts) | 750 000 | 750 000 | equal |
| offer rate (parts) | 250 000 | 250 000 | equal |
| average match score | 75 | 75 | equal |
| top company | maple analytics | maple analytics | equal |
| interviews | **2** | **1** | **differs by design** - the mart reads the history (one interview was later rejected); the old engine reads the current status |

Also from the mart alone: hires 1, screens 1, failed 1, reply samples 3 at
48 hours, resume versions v1 = 3 / v2 = 3, seniority senior / unspecified,
score band 85-100 = 2.

## 8. Small-cohort suppression - `PASS`

`suppressSmallCohort`: a benchmark cut with fewer than five distinct people
yields no number and says why. The benchmark counts DISTINCT people (one
person with twelve applications is one person - tested); over a range the
cohort is the largest single-day cohort, which can only understate. The
benchmark table has no user id, is system-only, and a tenant transaction
cannot read it (tested).

## 9. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **1068 / 1068**, 0 skipped (Stage 12: 1054) - new: `candidate-marts` 9, `candidate-analytics` 3 |
| Build | passes; `/api/analytics/refresh` present; `/dashboard/analytics` and `/dashboard` compile against the marts |
| Migrations | thirty-four applied fresh; drift clean; 120 public tables forced; RLS migration equals the generator output |

## 10. Exit gate - verdict

| Condition | State |
| --- | --- |
| Every metric has one documented definition and one source | **MET** - dictionary in code, mirrored in `METRIC_DICTIONARY.md`, test-enforced |
| Dashboards read marts, not transactional tables | **MET** for the candidate analytics page and the overview's numbers (static test); the overview's lists and the export are stated exceptions |
| Cuts by title, company, seniority, geography, source, resume version, compatibility score | **MET** |
| Cut by industry | **NOT AVAILABLE** - no industry classification exists in the platform |
| Small-cohort suppression | **MET** |
| Parity between transactional truth and marts | **MET** on every shared metric, with the one deliberate difference named |
| Marts fed incrementally from the event stream; a scheduled refresh | **NOT MET** - ADR-0011 not built; no scheduler (sweep, refresh and first visit only) |

**Verdict: Stage 13 passes every engineering gate that can be run here and
is PARTIAL at its exit** on the absence of an event stream and a scheduler
(both inherited platform gaps, stated) and the absence of an industry
dimension. Merge posture inherited from the stack.

## 11. What a founder or operator has to do

1. Run `npm run analytics:rollup` after deploying, and again whenever the
   application history is backfilled; until ADR-0011 exists, schedule it
   externally (cron) - the platform has no scheduler.
2. Decide whether an industry classification is wanted; nothing in the
   taxonomy spine (Stage 04) provides one.
3. Staging - unchanged (R-34).

## 12. Independent review

PENDING - recorded here when done.

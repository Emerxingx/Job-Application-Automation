# Stage 04 — Canada occupation, skills and labour intelligence — evidence

Recorded 2026-09-03 on branch `claude/stage-04-occupation-skills-spine`,
stacked on Stage 03 (PR #15), Stage 02 (PR #14) and Stage 01 (PR #13,
PARTIAL). Same rule as before: every line was run or read. Where the only
proof available used a hand-written fixture, the line says so — and this
stage is one where that matters, because **no real dataset has been
ingested**: the licence question (L-2) is open, and the code refuses to load
anything until a person records the answer.

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 04: a real occupational spine, Canada first,
US-compatible — `occupations` (NOC + TEER, SOC-ready), `skills_taxonomy`,
`occupation_skills`, `career_paths`, geography, a bilingual EN/FR content
model, jurisdiction as a first-class dimension (ADR-0009). **Licensing
confirmed before ingestion.** Acceptance: a job and a candidate can both be
expressed in NOC/TEER terms; adding SOC requires no schema change. Exit
gate: taxonomy queryable and jurisdiction-aware.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903100000_occupational_spine` | Ten tables: `TaxonomyDataset` (the licence record and gate), `Occupation` (canonical id, `level`, `parentId` tree), `OccupationLabel` (per locale: title, description, alternate titles), `OccupationCode` (scheme + version + code, explicit `teer`), `SkillLabel`, `SkillMapping`, `OccupationSkill`, `CareerPath`, `Region` tree (CA and US levels in one column), `RegionLabel`; `Job.occupationId` + `Job.occupationSource`; classification comments (all `INTERNAL`) | applied fresh and incrementally; drift "No difference detected"; **95/95** public tables forced |
| `20260903100100_rls_taxonomy_tables` | Generated policies (manifest `RLS_MANIFESTS[3]`): every table `reference` — SELECT for every tenant, no write policy | determinism test; tenant INSERT refused, tenant `updateMany` on the gate affects 0 rows |

Jurisdiction is a dimension, not a fork: the canonical `Occupation` carries
no country; `OccupationCode` carries `(scheme, version, code)`, so SOC 2018
attached to the same rows as NOC 2021 (§5) with no schema change, and a
NOC revision is a new version with crosswalks, not an edit. Labels are
records per locale, never columns (ADR-0009). `Region` holds Canadian
economic regions and US metros in one tree.

## 3. The licence gate — `PASS`

`src/lib/taxonomy/datasets.ts`. Six datasets are registered with what their
publishers state publicly, **all `unrecorded`**. `requireIngestible()` is the
only way a loader obtains a dataset and it refuses anything not `recorded`
with ingestion approved; `prohibited` is a counsel decision that can never
be loaded. Recording is admin-only (`/console/taxonomy`,
`/api/console/taxonomy/datasets/:key`), needs the attribution text the
product will show and a reason, and writes an audit row.

| Assertion (`tests/taxonomy.test.ts`) | Result |
| --- | --- |
| Every registered dataset starts `unrecorded`; loading NOC, the fixture or an unknown key is refused; nothing is written | PASS |
| A `recorded` licence without attribution or without a reason is refused | PASS |
| `recorded` without ingestion approval still refuses the loader | PASS |
| `prohibited` clears any approval and can never be loaded; both decisions audited with a reason | PASS |
| A tenant cannot create a dataset row or flip `ingestionApproved` (0 rows affected) | PASS |

What the gate does **not** do: it does not know whether the publisher's
terms are what a developer read on the site. That is L-2, and the table in
`SOURCE_ACCESS_POLICY.md` says so in its own words.

## 4. Loading, hierarchy, TEER, bilingual labels — `PASS` on the fixture

`src/lib/taxonomy/noc-loader.ts` parses the shape Statistics Canada publishes
(Level, Hierarchical structure, Code, Class title, Class definition, plus an
example-titles column) with a real CSV reader (quoted fields, embedded
commas), builds the tree by code prefix (2 → 21 → 212 → 2122 → 21223),
carries TEER explicitly, and upserts a label per locale. The fixture is
**17 hand-written nodes in EN and FR**, attributed
(`tests/fixtures/README-taxonomy.md`), approvable only inside a test
database.

| Assertion | Result |
| --- | --- |
| 17 occupations, 17 codes, 34 labels on first load; 0 / 0 / 0 on the second (idempotent) | PASS |
| Unit group 21223 parented by 2122; TEER 1; EN + FR labels; broad category has no parent | PASS |
| Integrity report: no orphans; EN and FR complete; 9 unit groups | PASS |
| Dataset row records `ingestedAt` and `rowCount` | PASS |
| An unrecognised file is refused rather than loaded | PASS |

## 5. NOC ↔ SOC crosswalk — `PASS` on the fixture

`loadSocCrosswalk` attaches SOC 2018 codes to the canonical occupations
(refused until the SOC dataset is recorded; malformed codes refused;
unmatched NOC codes reported, not guessed). `crosswalk()` translates
through the canonical id in both directions; many-to-one is preserved
(15-2051 ↔ {21211, 21223}). Coverage is measured: after the fixture
crosswalk, 4 of 9 unit groups still lack a SOC code and the report says
which.

## 6. Classification with recorded confidence — `PASS`

`src/lib/taxonomy/classify.ts`: exact title in any locale → `title_exact`
(high); an example title → `title_alternate` (high); the legacy regex table
(now `src/lib/taxonomy/fallback.ts`, moved out of the Adzuna adapter) →
`regex_fallback` (low); otherwise `none` — the posting stays unclassified.
The scanner classifies each stored posting once and records the method on
`Job.occupationSource`; the job page shows the occupation, marks a fallback
as approximate, and shows the dataset's attribution line.

| Assertion | Result |
| --- | --- |
| "Data Scientists" → exact; "Scientifiques des données" → the same occupation | PASS |
| "Senior Full Stack Developer (Toronto)" and "Business Analyst, Payments" → alternate title (qualifiers stripped) | PASS |
| "Information Security Manager" → regex fallback, low, 21220 | PASS |
| "Head of Growth" → none | PASS |
| Search by title in either locale, by alternate title, by code prefix | PASS |

## 7. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **867 / 867**, 0 skipped (Stage 03: 853) — new: `taxonomy` 14 (5 pure + 9 database) |
| Build | passes; `/console/taxonomy`, `/api/taxonomy/occupations`, `/api/console/taxonomy/datasets` present |
| Migrations | applied fresh and incrementally; drift clean; 95/95 forced |

## 8. Exit gate — verdict

| Condition | State |
| --- | --- |
| A job and a candidate can both be expressed in NOC/TEER terms | **MET in structure** — `Job.occupationId`; the candidate side keys off the same canonical id (Stages 07/08 consume it). No real vocabulary is loaded |
| Adding SOC requires no schema change | **MET** — SOC 2018 attached to the same rows on the fixture |
| Taxonomy queryable and jurisdiction-aware | **MET** — search, crosswalk, completeness on the tenant path |
| Licence records | **MET as a gate; NOT MET as records** — every dataset is `unrecorded`; the loaders refuse |
| Row counts | 17 fixture nodes; **0 real rows** |
| Crosswalk coverage | measured on the fixture (5 of 9); **0 real** |
| Bilingual completeness | measured (complete on the fixture) |
| L-2 | **OPEN — LEGAL_COMPLIANCE** |

**Verdict: Stage 04 passes every engineering gate reachable from this
environment and is BLOCKED at its exit on L-2** — the same shape as Stage 03
on L-3. The spine, the loaders, the crosswalk and the classifier are built
and proven on an attributed fixture; the product's occupational vocabulary
is empty until counsel confirms the terms and an admin records them, after
which loading is an operator action (`loadNocRows` under the recorded
dataset), not a code change. Skills mapping to OaSIS / CSCT / O*NET has its
tables and gate but no loader yet: those datasets need their own review
first and are recorded as such. Merge posture inherited from the stack.

## 9. What a founder or operator has to do

1. **L-2** — with IP / data-licensing counsel, confirm the terms for NOC 2021
   (Open Government Licence – Canada), SOC 2018, OaSIS, the Canadian Skills
   and Competencies Taxonomy and O*NET, and the attribution wording; record
   each at `/console/taxonomy` with the review as the reason.
2. **Load** — with the licence recorded and ingestion approved, run the
   loader against the published file; verify the integrity report on the
   console page (orphans 0, missing FR 0, crosswalk gaps listed).
3. **Staging** — unchanged (R-34).

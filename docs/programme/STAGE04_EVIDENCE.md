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
| `20260903100100_rls_taxonomy_tables` | Generated policies (manifest `RLS_MANIFESTS[3]`): nine tables `reference` — SELECT for every tenant, no write policy; the dataset register `TaxonomyDataset` is `system` (it carries who recorded a licence and governance notes; a page reads the attribution line through a system-client helper) | determinism test; tenant INSERT refused; tenant read of the register refused |
| `20260903100200_taxonomy_normalised_labels` | `OccupationLabel.normalizedTitle` / `normalizedAlternates` computed at load time so the classifier compares normalised to normalised; `TaxonomyDataset.publisherTerms` for the publisher's unconfirmed statement, kept apart from governance `notes` | applied; drift clean |

Jurisdiction is a dimension, not a fork: the canonical `Occupation` carries
no country; `OccupationCode` carries `(scheme, version, code)`, so SOC 2018
attached to the same rows as NOC 2021 (§5) with no schema change, and a
NOC revision is a new version with crosswalks, not an edit. Labels are
records per locale, never columns (ADR-0009). `Region` holds Canadian
economic regions and US metros in one tree.

## 3. The licence gate — `PASS`

`src/lib/taxonomy/datasets.ts`. Six datasets are registered with what their
publishers state publicly (`publisherTerms`, labelled unconfirmed in the
console and synced from code on every start), **all `unrecorded`**.
`requireIngestible()` is the only way a loader obtains a dataset and it
refuses anything not `recorded` with ingestion approved; `prohibited` is a
counsel decision that can never be loaded. Recording is admin-only
(`/console/taxonomy`, `/api/console/taxonomy/datasets/:key`), **step-up
re-authenticated** (the same password re-entry as a prompt change), needs
the attribution text the product will show and a reason, and writes an
audit row with before/after and the changed fields.

**The gate covers what is already loaded.** A decision that withdraws the
right to serve — `prohibited`, or `recorded` without approval — purges the
dataset's rows in the same transaction (occupations it introduced with
their labels, codes and links; codes it attached; jobs lose the link), and
each load runs in one transaction with a timeout, so a failure leaves
nothing half-loaded. The register is system-only, so the tenant path cannot
filter on it: the purge and the atomic load are the control, not a
read-time check — a first version of this fix added such a check and the
tenant-path test showed it hid the whole spine.

| Assertion (`tests/taxonomy.test.ts`) | Result |
| --- | --- |
| Every registered dataset starts `unrecorded`; loading NOC, the fixture or an unknown key is refused; nothing is written | PASS |
| A `recorded` licence without attribution or without a reason is refused | PASS |
| `recorded` without ingestion approval still refuses the loader | PASS |
| `prohibited` clears any approval and can never be loaded; both decisions audited with a reason | PASS |
| A tenant cannot read, create or change the dataset register at all (system-only) | PASS |
| Prohibiting a loaded dataset purges its codes (SOC: 5 → 0; the crosswalk answers nothing); withdrawing approval on the loaded fixture purges all 19 occupations and clears the job's link; an empty spine classifies nothing | PASS |
| An unknown dataset is a 404, not a 403 | PASS |

What the gate does **not** do: it does not know whether the publisher's
terms are what a developer read on the site. That is L-2, and the table in
`SOURCE_ACCESS_POLICY.md` says so in its own words.

## 4. Loading, hierarchy, TEER, bilingual labels — `PASS` on the fixture

`src/lib/taxonomy/noc-loader.ts` parses the two files Statistics Canada
publishes: the STRUCTURE file (Level · Hierarchical structure · Code - NOC
2021 V1.0 · Class title · Class definition, EN or FR headers, with the
UTF-8 byte-order mark the download carries) and the ELEMENTS file (… ·
Element type · Element description), whose illustrative examples become the
alternate titles — the structure file carries none. A real CSV reader
(quoted fields, embedded commas, CRLF), the tree built by code prefix
(2 → 21 → 212 → 2122 → 21223), TEER carried explicitly, a label per locale
with its normalised form. **A node whose parent is absent is refused**: a
unit-groups-only extract fails and rolls back rather than producing
hundreds of silent roots. The fixture is **19 hand-written nodes in EN and
FR plus an elements sample**, attributed (`tests/fixtures/README-taxonomy.md`),
approvable only inside a test database. **The real files have not been
loaded**: the parsers are written against the published header names and
row structure, and the fixture carries those headers verbatim — that is all
the fixture proves.

| Assertion | Result |
| --- | --- |
| BOM and EN/FR headers accepted; the structure file yields no alternates; the elements file yields examples and not duties; a units-only extract is refused and rolls back | PASS |
| 19 occupations, 19 codes, 38 labels on first load (counted against the table, not inferred); 0 / 0 / 0 on the second (idempotent) | PASS |
| Unit group 21223 parented by 2122; TEER 1; EN + FR labels; broad category has no parent | PASS |
| Integrity report: no orphans (defined as a non-top node with no parent — a dangling id is impossible under the FK); EN and FR complete; 9 unit groups | PASS |
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

`src/lib/taxonomy/classify.ts`: both sides are normalised the same way
(lower-case, brackets removed, every non-letter to a space so hyphens,
slashes and apostrophes agree, seniority qualifiers stripped only at the
ends), the normalised form is stored on the label at load time, and a
posting is tried whole and then as its head before a qualifier separator.
Only UNIT GROUPS match by title; an ambiguous match is `none`. Exact →
`title_exact` (high); an example title → `title_alternate` (high); the
legacy regex table (now `src/lib/taxonomy/fallback.ts`, three mappings
corrected against NOC 2021) → `regex_fallback` (low); otherwise `none`.
`classifyStoredJob` classifies each posting once, does nothing while no
dataset is loaded, and a high-confidence result overwrites the adapters'
capture-time regex guess in `Job.nocCode`; the job page qualifies both
chips as approximate unless the method is high-confidence, and shows the
dataset's attribution line read on the system client.

| Assertion | Result |
| --- | --- |
| "Data Scientists" → exact; "Scientifiques des données" → the same occupation | PASS |
| "Développeurs/développeuses et programmeurs/programmeuses Web" (slashes) → exact; "Analyste d'affaires" (apostrophe) → alternate; "Senior Full-Stack Developer (Toronto)" (hyphen, bracket) and "Business Analyst, Payments" (head) → alternate; "Chief of Staff" → none | PASS |
| A category title ("Computer and information systems professionals") never classifies a posting | PASS |
| A stored posting: classified once; the capture-time guess 21231 replaced by the classified 21211; no second pass; nothing runs on an empty spine | PASS |
| "Information Security Manager" → regex fallback, low, 21220 | PASS |
| "Head of Growth" → none | PASS |
| Search by title in either locale, by alternate title, by code prefix | PASS |

## 7. Independent review — findings and dispositions

An adversarial review agent returned 3 HIGH, 5 MEDIUM, 7 LOW findings and
NITs. Every HIGH and MEDIUM is fixed in this PR with a test; LOW items are
fixed or recorded.

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | HIGH | The gate was write-time only: `prohibited` or withdrawn approval left loaded rows serving; a partial load was served | **Fixed** — purge in the same transaction; loads in one transaction; tests (a read-time filter on the system-only register was tried and removed: it blinded the tenant path) |
| 2 | HIGH | Hyphens truncated titles; raw stored titles could never match a normalised query; FR titles with slashes were unmatchable | **Fixed** — one normal form on both sides stored at load time; qualifiers stripped only at the ends; head-of-title candidate; tests on real-shaped titles |
| 3 | HIGH | Parser rejected the BOM and French headers; example titles come from the elements file, which had no loader | **Fixed** — BOM, EN/FR header aliases, elements-file parser and merge; fixtures carry the published headers verbatim; evidence no longer claims more than the headers |
| 4 | MED | Regex NOC codes shown as certain; scanner preserved the guess over a better match | **Fixed** — `classifyStoredJob` overwrites on high confidence; both chips qualified unless high-confidence |
| 5 | MED | `TaxonomyDataset` readable by tenants (staff email, notes) | **Fixed** — `system` kind; attribution via a system-client helper; test asserts the read is refused |
| 6 | MED | "Orphans" could never fire; missing parents became silent roots | **Fixed** — orphan = non-top node without parent; loader refuses missing parents; test |
| 7 | MED | Publisher's terms shown as unlabelled notes and never refreshed | **Fixed** — `publisherTerms` column synced on every upsert, labelled unconfirmed; `notes` reserved for governance |
| 8 | MED | Tests reset the whole database and restored nothing; label count was a heuristic | **Fixed** — resets scoped to the fixture datasets and restored in `after`; counts compared against the table; scanner path tested |
| 9 | LOW | `prohibited` reversible without step-up; audit fields partial; 403 for unknown | **Fixed** — step-up on every licence record; full before/after with computed changed fields; 404 |
| 10 | LOW | Level-agnostic exact match; EN=FR duplicate titles blocked exact | **Fixed** — unit groups only, deduplicated by occupation, ambiguity → none |
| 11 | LOW | Version-blind code reads | **Fixed** — latest version preferred; fixture and real rows cannot both be servable outside a test database |
| 12 | LOW | Regex mis-mappings user-visible | **Fixed** — DevOps/SRE → 21222, network engineer → 21311, network administrator → 22220 |
| 13 | LOW | Search ordering by level string; locale not applied to alternates; unordered classifier scans | **Fixed** — explicit level rank; locale on both branches; ordered scans with bounded windows |
| 14 | LOW | Classification cost on an empty spine | **Fixed** — short-circuit when nothing is loaded |
| 15 | LOW | Fixture said "a dozen"; reproduces real titles | **Recorded** — README corrected to seventeen and states the posture (the same handful the regex table has carried since Stage 00; rewritten with invented titles if L-2 rules them out) |
| — | NIT | Unused helpers, stale comment, stale counts in CLAUDE.md / GAP_ANALYSIS, migration-table order, `title` attribute for the confidence note | **Fixed** |

## 8. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **871 / 871**, 0 skipped (Stage 03: 853) — new: `taxonomy` 18 (6 pure + 12 database) |
| Build | passes; `/console/taxonomy`, `/api/taxonomy/occupations`, `/api/console/taxonomy/datasets` present |
| Migrations | applied fresh and incrementally; drift clean; 95/95 forced; the dataset register is system-only |

## 9. Exit gate — verdict

| Condition | State |
| --- | --- |
| A job and a candidate can both be expressed in NOC/TEER terms | **MET in structure** — `Job.occupationId`; the candidate side keys off the same canonical id (Stages 07/08 consume it). No real vocabulary is loaded |
| Adding SOC requires no schema change | **MET** — SOC 2018 attached to the same rows on the fixture |
| Taxonomy queryable and jurisdiction-aware | **MET** — search, crosswalk, completeness on the tenant path |
| Licence records | **MET as a gate (with purge on withdrawal); NOT MET as records** — every dataset is `unrecorded`; the loaders refuse |
| Row counts | 19 fixture nodes; **0 real rows** |
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

## 10. What a founder or operator has to do

1. **L-2** — with IP / data-licensing counsel, confirm the terms for NOC 2021
   (Open Government Licence – Canada), SOC 2018, OaSIS, the Canadian Skills
   and Competencies Taxonomy and O*NET, and the attribution wording; record
   each at `/console/taxonomy` with the review as the reason.
2. **Load** — with the licence recorded and ingestion approved, run the
   loader against the published file; verify the integrity report on the
   console page (orphans 0, missing FR 0, crosswalk gaps listed).
3. **Staging** — unchanged (R-34).

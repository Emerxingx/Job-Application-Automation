# Stage 06 — Job normalisation, deduplication and freshness — evidence

Recorded 2026-09-03 on branch `claude/stage-06-normalization-dedup-freshness`,
stacked on Stage 05 (PR #17) → 04 (#16) → 03 (#15) → 02 (#14) → 01 (#13,
PARTIAL). Draft PR #18. Every line was run or read; nothing is PASS on the strength of a
mock, a skipped test or a document. This stage's honest centre: **the
canonical job model is live and dedup is measured — on a hand-labelled set of
eight postings, because no real source is credentialed yet; the freshness
sweep runs on demand and by command, because no scheduler exists in this
codebase.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 06: one canonical job, provenance preserved,
lifecycle tracked. Canonical fields (`normalized_title`, `occupation_family`,
NOC + SOC, `postal_region`, first/last seen, `active_state` / `closed_at`,
`source_hash`, `canonical_hash`, separated required / preferred skills,
education, certification and experience requirements, language, work
authorisation, sponsorship); dedup on `canonical_hash` retaining every source
row; freshness sweeps and closure via `detectClosed()`. Acceptance: the same
posting from two sources yields one canonical job with two provenance
records. Exit gate: canonical model live; dedup measured; freshness running.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903130000_canonical_job` | Fifteen canonical columns on `Job` (defaults, nullable where "not stated" is a value); `JobProvenance` (one row per source × external id carrying a job: its own apply link, first/last sighting, last content hash; unique on `(sourceId, externalId)`); indexes on `canonicalHash`, `normalizedTitle`, `(activeState, postedAt)`; classification comments; an idempotent SQL **backfill** of one provenance row per existing capture | applied fresh and incrementally; drift "No difference detected"; 6 existing captures → 6 provenance rows locally |
| `20260903130100_rls_provenance_table` | Generated (manifest `RLS_MANIFESTS[5]`): `JobProvenance` is `reference` — shared like `Job`, no personal data | determinism test; tenants read provenance and cannot write it (tested); **100/100** public tables forced |

The canonical columns of pre-existing rows are filled by
`npm run jobs:canonicalize` (idempotent, resumable: a row is skipped once it
has a hash), not by the migration — the derivation is application code and
would not belong in SQL. New captures are canonicalised as they arrive.

## 3. The canonical job — `PASS`, measured on goldens

`src/lib/jobs/canonical.ts` is pure and deterministic. What each field is,
and what it is NOT:

| Field | Derivation | Honest limit |
| --- | --- | --- |
| `normalizedTitle` | lower-cased; bracketed qualifiers, requisition / job ids, and trailing segments naming a work mode, employment type, the employer or the place removed; **seniority kept** ("senior data analyst" ≠ "data analyst") | a department segment ("Analyst – Finance") is kept, so two departments' identical titles stay distinct only if their skill fingerprints differ |
| `normalizedCompany` | lower-cased, punctuation-free, a leading "the" and TRAILING legal forms removed ("Maple Analytics Inc." → "maple analytics"; "Canada Life" stays "canada life") | a name made only of a legal form keeps its base form |
| `postalRegion` | `CA-<province>/<city>`, `US-<state>/<city>`, `remote`, or null; province / state by code or name from the posting's own country table, the last such part wins; a city alone only from a known-city list | an unknown city with no province is null, never guessed |
| `requiredSkills` / `preferredSkills` | the closed skill vocabulary, split by section heading ("Requirements" / "Nice to have") and by phrase ("preferred", "an asset", "a plus"); source-listed skills are required unless marked preferred; a skill in both is required | lexical: a skill outside the vocabulary is not seen; a "preferred" marker in a sentence marks the whole sentence |
| `educationRequirements` / `certificationRequirements` | degree and certification patterns | patterns, not a taxonomy; "Bachelor's degree" and "Bachelor's" are different strings (the fixture shows both) |
| `experienceYearsMin` / `Max` | the smallest stated minimum and largest stated maximum of "N years" / "N–M years" | null when no number is written; a range is never invented |
| `languageRequirements` | language names and "bilingual" | presence, not proficiency |
| `workAuthorization` | what the posting STATES: `authorization_required`, `citizenship_or_pr_required`, `security_clearance_required`, or null; evaluated sentence by sentence, and a sentence that negates ("not required") or merely prefers ("an asset") the requirement never counts; Canada and the US only | null means "nothing stated", not "anyone"; a requirement phrased in a way the patterns do not know stays null — silence beats a false "required", which Stage 07 would turn into an exclusion |
| `sponsorship` | `not_offered` / `offered` only on explicit phrasing, sentence by sentence; **`unknown` is the default** | never inferred from silence; a negation never crosses a sentence boundary |
| `occupationFamily` / `socCode` | set by classification against the spine only: NOC broad category of the classified code (`noc:<digit>`) and SOC from the occupation's own codes (the loaded crosswalk); never from the adapter's capture-time regex guess (ADR-0009) | null until the spine is loaded (L-2, Stage 04): today every row is null |
| `canonicalHash` | sha256 of normalised title, normalised company, **country**, region and the de-duplicated, sorted **vocabulary** skill fingerprint; a WEAK identity (placeholder employer, unparseable region or empty fingerprint) is salted with the capture's own id and never merges | see §4 |

`tests/canonical-jobs.test.ts` asserts **every field of fifteen fixture
postings** (a careers page with a requisition id and a postal code, two
aggregator copies, a board copy repeating the place and employer in the
title, a US posting with a zip and a clearance, a remote posting, an
unparseable location, a distinct role at the same employer, two undisclosed
employers, two unparseable locations, remote in each country, and a posting
full of negations, inline headings and a state abbreviation), plus unit cases
for title, company, region, years, education, authorisation and sponsorship.
All PASS.
Three defects the tests caught before any row was written: "New York,
NY" lost its city (the state name matched first); "sponsorship is not
available" was `unknown` (a pattern without the space); and the requisition
pattern stripped only numeric ids, so an alphanumeric id ("Req #3f9a1b2c",
"JR0012345") stayed in the title and split one job into two — found because
the database test's random run id sometimes began with a digit and a letter.

## 4. Deduplication — `PASS`, measured: precision 1.000, recall 1.000 on the labelled set

Identity is what a candidate would recognise as the same job: title, employer,
region and skill fingerprint. The fingerprint uses the closed vocabulary
because it survives an aggregator's reformatting and truncation where raw
text does not.

Measured over **every pair** of the fifteen labelled postings (105 pairs, 2
positives, 103 negatives including five hard negatives — same title, employer
and city but a different role; same posting in a different city; two
undisclosed employers; two unparseable locations; remote in Canada vs remote
in the US):

```
dedup on 15 postings / 105 pairs: tp 2 fp 0 fn 0 tn 103 — precision 1.000 recall 1.000
hard negatives: c1|d1: predicted different; u1|v1: predicted different; w1|w2: predicted different; y1|y2: predicted different; z1|z2: predicted different
```

**What that number is and is not.** It is the exact behaviour on a
hand-written set that covers the shapes real sources produce, checked pair by
pair. It is not a measurement on real traffic: no real source is credentialed
(Stage 05 exit), so no real duplicate has been observed. The metric is
re-computed on every test run and the assertion fails on any false positive
or false negative, so a change to the identity rule is a visible decision.
Known failure modes, by construction: two distinct requisitions at one
employer with the same title, city and vocabulary skills will merge; the
same job posted with a skill list an aggregator truncated will not; "Remote
– Toronto, ON" and "Toronto, ON (Remote)" are both `remote`, so an on-site
copy at `CA-ON/toronto` stays separate; "Kitchener-Waterloo" and "Kitchener
– Waterloo" are different cities. A weak identity never merges, so a source
that omits the employer produces one job per capture rather than one job per
title.

Against the database (`tests/connector-pipeline.test.ts`):

| Assertion | Result |
| --- | --- |
| The same posting captured from two registered sources is **one** `Job` with **two** `JobProvenance` rows and a snapshot per capture (the acceptance case) | PASS |
| The primary (first) source owns the `Job` columns; the second source's differently formatted copy never overwrites them but keeps its own apply link | PASS |
| A re-capture from the second source moves its sighting and grows nothing | PASS |
| A distinct role at the same employer and place is not merged | PASS |
| Two runs racing on a new posting: the loser becomes an update (inherited from Stage 05, now across job, provenance and snapshot in one transaction) | PASS |

## 5. Freshness and closure — `PASS` for the mechanism; running on demand and by command, not on a schedule

Staleness is per **source provenance**: a source's copy not sighted within the
window, and not asked about within the window, is asked about through that
source's `refresh()`; never-asked rows first, then the least recently asked,
so every stale row is reached in turn and a source that answers `unknown`
for everything (Adzuna) is not re-asked about the same rows on every sweep.
`active` re-seats the provenance and the job; `closed` closes the job, and
`unknown` marks it unknown, **only when no other source has sighted it within
the window** — another source's live copy keeps it open and confirmed;
`unknown` is never inferred as closed. A closed job is never a merge target:
the same posting reappearing from another source is a new job.

| Assertion | Result |
| --- | --- |
| A job the mock no longer lists closes with `closedAt`; a listed one is re-seen; a foreign id stays `unknown`, open, not re-seen | PASS |
| A job listed by two sources stays open while one still lists it, and closes when neither does | PASS |
| A job listed by two sources is not marked unknown on one source's doubt while the other sighted it today; the sweep records what it asked and does not re-ask within the window | PASS |
| Closed jobs leave the feed, the dashboard's top matches and the v1 match feed (`job.activeState ≠ closed`); the v1 job object exposes `activeState` / `closedAt`; exports and analytics keep history on purpose; the job page says a posting is closed and when, keeps it for the record, shows `unknown` as unconfirmed, and links every source's own copy | route / page code; the page's tenant-path include is executed by a test (§9 H1); build passes |
| Sweep entry points: `POST /api/console/sources/:key/refresh` (admin; through the same gate as discovery) and `npm run jobs:freshness [key] [hours]` for a scheduler | route builds; script typechecks; **no scheduler exists** in the codebase — Stage 24 |

## 6. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **942 / 942**, 0 skipped (Stage 05: 914) — new: `canonical-jobs` 21; `connector-pipeline` +6 |
| Build | passes; `/api/console/sources/[key]/refresh` present |
| Migrations | applied fresh; drift clean; 100/100 forced; RLS migration equals the generator output; `20260903140000_provenance_sweep_progress` on top (§9 M5, L18) |

Run with the documented command only (the two test URLs; `DATABASE_URL` /
`DIRECT_URL` unset).

## 7. Exit gate — verdict

| Condition | State |
| --- | --- |
| Canonical model live | **MET** — every field on `Job`, derived on capture, backfill command for older rows |
| Dedup measured | **MET on a labelled fixture set** (precision 1.000, recall 1.000, 28 pairs); **NOT MEASURED on real traffic** — no credentialed source |
| Freshness running | **MET as a mechanism, on demand and by command**; **NOT MET as a schedule** — no scheduler exists (Stage 24) |
| Acceptance: one canonical job, two provenance records from two sources | **MET** (database test) |
| Snapshots immutable (the Job Folder's promise) | **MET** — unchanged trigger; a snapshot per capture per source |

**Verdict: Stage 06 passes every engineering gate; its exit is PARTIAL** on the
same cause as Stage 05 — nothing real flows through it yet — and on the
absence of a scheduler, which is a deployment concern this codebase does not
yet have. Merge posture inherited from the stack.

## 8. What a founder or operator has to do

1. Credential a real source (Stage 05 §10) so dedup and closure are observed
   on real postings; record the observed precision here.
2. Schedule `npm run jobs:freshness` (hourly is reasonable for the mock;
   respect each source's rate limit for a real one) — Stage 24.
3. After deploying the canonical migration, run `npm run jobs:canonicalize`
   once for the rows captured before it.
4. Staging — unchanged (R-34).
5. If any `Job` row on staging has no `sourceId` (a capture from before the
   Stage 05 register), decide whether to give it a provenance row (it will
   otherwise never be swept) or to close it by hand (§9 L16).

## 9. Independent review — 2 HIGH, 7 MEDIUM, 9 LOW; every HIGH and MEDIUM closed with a test

A separate reviewer with no shared context read the full diff (`c9beb6b..2d922e6`),
reproduced the gate set, and probed the page query, the pipeline and the
normaliser against the local database with throwaway scripts. Dispositions:

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| H1 | HIGH | The job page included `provenance.source` inside the tenant transaction; `JobSource` is system-only, so Prisma got no row for a required relation and threw — a 500 on every job page since the provenance backfill | **FIXED** — the tenant query includes provenance only; `sourceNamesFor()` resolves display names on the system client outside the transaction, the same way the taxonomy attribution is read. Test: the page's include verbatim under `withTenant` succeeds; the offending include is asserted to throw |
| H2 | HIGH | `canonicalHash` merged unrelated postings through placeholders: two "Manager" postings with the undisclosed-employer placeholder and no vocabulary skills; two unparseable locations; remote-Canada and remote-US (country was not in the hash) | **FIXED** — the country is in the hash; a WEAK identity (placeholder employer, null region, empty vocabulary fingerprint) is salted with the capture's own id and never merges. Fixture: the three pairs are hard negatives; `canonicalIdentityStrength` unit-tested |
| M3 | MED | `normalizeCompany` deleted "canada / usa / the / group / co" anywhere: "Canada Life" → "life", "Air Canada" → "air" | **FIXED** — a leading "the" and TRAILING legal forms only. Tests: Canada Life, Air Canada, Groupe SA, The Home Depot Canada Inc.; two goldens changed by review |
| M4 | MED | `unknown` was written without the "still listed elsewhere" test the `closed` branch had, so one source's doubt overrode another source's sighting from today | **FIXED** — doubt is per source like closure. Test: stale mock provenance + fresh adzuna provenance → stays `active`; both stale → `unknown`, never closed |
| M5 | MED | The sweep ordered by `lastSeenAt` and never advanced a row the source could not answer for, so the same rows were re-asked on every sweep and rows behind the limit were never reached; Adzuna answers `unknown` for every id | **FIXED** — `JobProvenance.lastCheckedAt` (migration `20260903140000`), set on every ask; candidates are rows not asked within the window, never-asked first. Test: a second sweep in the window does not re-ask the row it just asked about |
| M6 | MED | A closed job was revived by a hash twin from another source, keeping the dead primary's apply link and old posting date | **FIXED** — a closed job is never a merge target: the repost is a new job. The page links every source's own copy. Test: closed job + twin from another source → new job, the closed one stays closed |
| M7 | MED | `workAuthorization` / `sponsorship` ignored negation and preference ("citizenship is not required" → required; "no security clearance required" → required; "secret clearance is an asset" → required; "right to work in the UK" → required; a negation forty characters back in another sentence flipped sponsorship) | **FIXED** — both evaluate sentence by sentence; a negated or preferred sentence never counts; Canada and the US only; "we sponsor" recognised. Tests: every probe phrase; a golden posting made of them |
| M8 | MED | A short line starting with a heading word was swallowed with its content: "Requirements: SQL, Python and Tableau." yielded no skills | **FIXED** — the content after the colon is kept in the new mode, including inline headings later in the line. Golden: "Requirements: SQL, Python and Tableau.\nPreferred: Looker. Requirements: Excel." → required sql/python/tableau/excel, preferred looker |
| M9 | MED | Closed jobs still flowed through the v1 match feed, and the v1 job object could not show lifecycle; CLAUDE.md said "leave the feed" unqualified | **FIXED / DOCUMENTED** — the v1 match feed filters `activeState ≠ closed` and the job object exposes `activeState` / `closedAt`; exports and analytics keep history on purpose and the docs say so |
| L10 | LOW | `b\.?a\.?` / `m\.?a\.?` matched the state abbreviation "MA" and "BA" in prose; curly apostrophes mangled "Bachelor's" | **FIXED** — bare BA/BS/MA/MS count only in a degree context ("BA in", "BA or BS"); dotted forms still count; apostrophes normalised. Tests |
| L11 | LOW | `experienceYears` unanchored: "established 2024 years" → 20–24 | **FIXED** — digit-anchored. Tests |
| L12 | LOW | "Hybrid - Toronto, ON" → `CA-ON/hybrid`; "Sr." ≠ "Senior"; "Position:" kept; a source-listed non-vocabulary skill split a job | **FIXED** — a leading work-mode word is not a city; common abbreviations expand; leading label words drop; only vocabulary skills enter the hash. The remote-with-city and hyphenated-city cases are documented in §4 as known modes |
| L13 | LOW | `extractSkills` compiled ~150 patterns per call, once per sentence: a bullet-heavy 50 KB description cost ~2 s on the scan path | **FIXED** — patterns compiled once at module load |
| L14 | LOW | The "no primary any more" promise was implemented only for a null `sourceId` twin, and the row kept the dead capture's key | **FIXED** — such a capture adopts primacy and re-keys the Job row to itself. Test |
| L15 | LOW | `occupationFamily` was derived at capture from the adapter's regex guess, with no method recorded; the doc said every row is null | **FIXED** — set by classification only; the backfill command no longer derives it |
| L16 | LOW | Rows without `sourceId` (pre-Stage-05 captures) get no provenance and are never swept | **DOCUMENTED** — none exist locally; if any exist on staging they need a one-off provenance row per capture, which is a data decision for the operator (§8) |
| L17 | LOW | `jobs:freshness` accepted a non-numeric hours argument (every source recorded a failed run) and had no top-level catch | **FIXED** |
| L18 | LOW | `Job(activeState, postedAt)` had no reader; `Job(normalizedTitle)` has none yet | **FIXED / DOCUMENTED** — the first is dropped in `20260903140000`; the second is kept for Stage 08's search and annotated |

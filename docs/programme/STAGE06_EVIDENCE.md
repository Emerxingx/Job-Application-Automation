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
| `normalizedCompany` | lower-cased, punctuation-free, legal-form suffixes removed | a name made only of suffix words keeps its base form |
| `postalRegion` | `CA-<province>/<city>`, `US-<state>/<city>`, `remote`, or null; province / state by code or name from the posting's own country table, the last such part wins; a city alone only from a known-city list | an unknown city with no province is null, never guessed |
| `requiredSkills` / `preferredSkills` | the closed skill vocabulary, split by section heading ("Requirements" / "Nice to have") and by phrase ("preferred", "an asset", "a plus"); source-listed skills are required unless marked preferred; a skill in both is required | lexical: a skill outside the vocabulary is not seen; a "preferred" marker in a sentence marks the whole sentence |
| `educationRequirements` / `certificationRequirements` | degree and certification patterns | patterns, not a taxonomy; "Bachelor's degree" and "Bachelor's" are different strings (the fixture shows both) |
| `experienceYearsMin` / `Max` | the smallest stated minimum and largest stated maximum of "N years" / "N–M years" | null when no number is written; a range is never invented |
| `languageRequirements` | language names and "bilingual" | presence, not proficiency |
| `workAuthorization` | what the posting STATES: `authorization_required`, `citizenship_or_pr_required`, `security_clearance_required`, or null | null means "nothing stated", not "anyone" |
| `sponsorship` | `not_offered` / `offered` only on explicit phrasing; **`unknown` is the default** | never inferred from silence |
| `occupationFamily` / `socCode` | NOC broad category of the classified NOC code (`noc:<digit>`); SOC from the occupation's own codes (the loaded crosswalk) | null until the spine is loaded (L-2, Stage 04): today every row is null |
| `canonicalHash` | sha256 of normalised title, normalised company, region and the de-duplicated, sorted skill fingerprint | see §4 |

`tests/canonical-jobs.test.ts` asserts **every field of eight fixture
postings** (a careers page with a requisition id and a postal code, two
aggregator copies, a board copy repeating the place and employer in the
title, a US posting with a zip and a clearance, a remote posting, an
unparseable location, a distinct role at the same employer), plus unit cases
for title, company, region, years, authorisation and sponsorship. All PASS.
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

Measured over **every pair** of the eight labelled postings (28 pairs, 2
positives, 26 negatives including two hard negatives — same title, employer
and city but a different role; same posting in a different city):

```
dedup on 8 postings / 28 pairs: tp 2 fp 0 fn 0 tn 26 — precision 1.000 recall 1.000
hard negatives: c1|d1: predicted different; u1|v1: predicted different
```

**What that number is and is not.** It is the exact behaviour on a
hand-written set that covers the shapes real sources produce, checked pair by
pair. It is not a measurement on real traffic: no real source is credentialed
(Stage 05 exit), so no real duplicate has been observed. The metric is
re-computed on every test run and the assertion fails on any false positive
or false negative, so a change to the identity rule is a visible decision.
Known failure modes, by construction: two distinct requisitions at one
employer with the same title, city and vocabulary skills will merge; the
same job posted with a skill list an aggregator truncated will not.

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
window is asked about through that source's `refresh()`. `active` re-seats
the provenance and the job; `closed` closes the job **only when no other
source has sighted it within the window** — another source's live copy keeps
it open; `unknown` is recorded as unknown, never inferred as closed.

| Assertion | Result |
| --- | --- |
| A job the mock no longer lists closes with `closedAt`; a listed one is re-seen; a foreign id stays `unknown`, open, not re-seen | PASS |
| A job listed by two sources stays open while one still lists it, and closes when neither does | PASS |
| Closed jobs leave the feed and the dashboard's top matches (`job.activeState ≠ closed`); the job page says a posting is closed and when, and keeps it for the record; `unknown` is shown as unconfirmed | route / page code, build passes |
| Sweep entry points: `POST /api/console/sources/:key/refresh` (admin; through the same gate as discovery) and `npm run jobs:freshness [key] [hours]` for a scheduler | route builds; script typechecks; **no scheduler exists** in the codebase — Stage 24 |

## 6. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **932 / 932**, 0 skipped (Stage 05: 914) — new: `canonical-jobs` 14; `connector-pipeline` +3 |
| Build | passes; `/api/console/sources/[key]/refresh` present |
| Migrations | applied fresh; drift clean; 100/100 forced; RLS migration equals the generator output |

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

# Stage 07 — Eligibility engine — evidence

Recorded 2026-09-03 on branch `claude/stage-07-eligibility-engine`, stacked
on Stage 06 (PR #18) → 05 (#17) → 04 (#16) → 03 (#15) → 02 (#14) → 01 (#13,
PARTIAL). Draft PR #19. Every line was run or read; nothing is PASS on the strength of a
mock, a skipped test or a document. This stage's honest centre: **hard gates
now run before scoring and an ineligible posting never reaches a candidate's
feed; the gates are as good as the facts on both sides, and two of the six
rules are advisory until Stage 08's requirement extraction can tell
"required" from "a plus".**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 07: hard pass/fail gates, evaluated before and
separately from fit — work authorisation, sponsorship, licensure /
certification, location and radius, security clearance, language.
Deterministic, explainable, jurisdiction-aware; output a structured
eligibility record with a per-rule reason, never a number; never read the
sensitive schema; work authorisation access-controlled and audited.
Acceptance: no ineligible job reaches recommendations; every exclusion
states a reason. Exit gate: eligibility gates scoring; explanations
human-readable.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903150000_eligibility_results` | `EligibilityResult`: one verdict per (user, job) — `outcome` (eligible · ineligible · unknown), `rules` (JSON: every rule with status and reason), `rulesVersion`, `profileVersion` (the profile state it was computed from), `evaluatedAt`; classification comment | applied fresh and incrementally; drift clean |
| `20260903150100_rls_eligibility_table` | Generated (manifest `RLS_MANIFESTS[6]`): `EligibilityResult` is user-owned (`userId`) | determinism test; a tenant reads only their own verdicts and cannot forge one (tested); **101/101** public tables forced |

## 3. The rules — coverage matrix

`src/lib/eligibility/engine.ts` is pure and deterministic. Every rule is
evaluated on every call; every result carries a reason in words; there is no
score anywhere in the output — a reason may quote a date the candidate
recorded, never a percentage, rank or ratio (a test asserts it).
Jurisdictions modelled: Canada and the US, by the posting's country; another
jurisdiction answers `unknown`.

| Rule | Hard? | Posting fact (Stage 06 canonical) | Candidate fact | pass | fail | unknown |
| --- | --- | --- | --- | --- | --- | --- |
| `work_authorization` | yes | `workAuthorization`: null · `authorization_required` · `citizenship_or_pr_required` · `security_clearance_required` | `WorkAuthorization.country`, `.status`, `.permitExpiresAt` | posting silent; citizen / PR in the posting's country; valid work permit for an authorisation requirement | requires sponsorship; expired work permit; work or study permit against a citizenship requirement | posting not yet read by the canonical pipeline; not recorded / unspecified; another country recorded (one row per profile: a fact about Canada says nothing about the US); a clearance statement (the canonical field keeps one statement, so no authorisation statement is invented); study permit against an authorisation requirement (limited work); unmodelled jurisdiction; an unrecognised status |
| `sponsorship` | yes | `sponsorship`: offered · not_offered · unknown | `sponsorshipNeeded` or status `requires_sponsorship` | not needed; needed and offered | needed and not offered | needed and the posting is silent or not yet read |
| `security_clearance` | yes | `workAuthorization = security_clearance_required` | none (clearances are not on the profile yet) | posting silent | — (never: the profile cannot say) | posting requires a clearance |
| `location` | yes | `workMode`, `country`, `postalRegion`, `location` | `CareerPreferences.countries`, `.locations`, `.relocation` | remote; no preference recorded (a work-mode word listed as a place is ignored); the posting's city, province name, province code or country listed as a WHOLE name — never a substring; outside the list but open to relocating | another country, or another province, with relocation `no` | a place listed but the posting's location unparseable; the same province as a listed city but a different municipality (no radius exists: a suburb cannot be told from a city across the province) |
| `licensure` | title-dependent | `certificationRequirements` | `Certification.name`, matched on WHOLE words under any spelling ("RN", "Registered Nurse (CNO)"; "Certified Internal Auditor" holds nothing) | every listed designation held; none listed | a licensed designation (RN, LPN/RPN, P.Eng., CPA) the normalised TITLE demands and does not merely prefer, not held | a certification merely mentioned and not held (the posting may prefer it); a designation mentioned by a posting whose title is not that profession ("Nurse Aide" mentioning the RN); the posting not yet read |
| `language` | no (advisory) | `languageRequirements` ("bilingual" = English + French in Canada, English + Spanish in the US) | `CandidateLanguage` at conversational or better (regional codes and names canonicalised: `fr-CA`, "French (Canada)") | none listed; all held at a working level | — (never) | a listed language not held at a working level; the posting not yet read. **Honest limit:** no settings form writes `CandidateLanguage` yet (a Stage 02 gap), so this rule can only pass on a profile seeded another way |

**Verdict:** any hard `fail` → `ineligible`; else any `unknown` → `unknown`;
else `eligible`. `unknown` never excludes: the posting reaches scoring, the
feed shows an "Eligibility unconfirmed" chip and the page shows the open
question. A posting the canonical pipeline has not read yet (`canonicalHash`
empty) is `unknown` on every posting-side rule rather than "states nothing".

Every cell above is exercised by `tests/eligibility-engine.test.ts` (both
jurisdictions for the authorisation rule), plus determinism and the
aggregation laws. All PASS.

**Why two rules are advisory.** The Stage 06 canonical job lists the
certifications and languages a posting MENTIONS; it does not yet separate
"required" from "an asset" (that is Stage 08's requirement extraction). A
hard gate on a mention would exclude candidates for preferences. So a
certification is a hard gate only when it is a licensed designation the
title itself demands ("Registered Nurse" + `rn`), and language never
excludes. This is stated on the page ("advisory") and here; it is not a
claim that language and certification requirements are enforced.

## 4. The gate — `PASS`

`src/lib/eligibility/service.ts` and the scanner:

| Assertion (`tests/eligibility-gate.test.ts`) | Result |
| --- | --- |
| The candidate's facts (work authorisation, preferences, certifications, languages) are read on the TENANT path as `app_tenant` (no privilege on the sensitive schema, ADR-0007), audit-first: an `eligibility.profile.read` row naming the purpose and the batch size is written strictly on the system client before the read, and never a value | PASS |
| One verdict per (user, job); reused while the profile and the rule set are unchanged; re-evaluated when the candidate's work authorisation, preferences, certifications or languages change (`profileVersion` = latest change plus row counts) | PASS |
| A match created while eligible is demoted to `ineligible` (never deleted) when the verdict flips, leaves the feed, and is restored to `new` when the verdict lifts; the feed, the dashboard and the v1 match feed also filter on the verdict itself | PASS |
| A page view with a current verdict reads no facts and writes no audit row (staleness from timestamps and counts only); a stale one evaluates once | PASS |
| **The scanner gates before scoring**: a candidate who needs sponsorship, scanning the synthetic source whose "Senior Data Analyst" posting says it does not sponsor, gets that posting EXCLUDED — no `JobMatch` is ever created for it — with the verdict stored and its reason; a citizen scanning the same source is excluded from nothing and every scored posting has a stored verdict too | PASS |
| Tenants read their own verdicts only and cannot forge one | PASS |
| Nothing under `src/lib/eligibility/` names the sensitive schema | PASS (`tests/sensitive-segregation.test.ts`, allowlist unchanged) |

The synthetic source now carries real-world eligibility statements on three
postings ("Must be legally authorized to work in Canada.", "We are unable to
sponsor visas at this time.", "Canadian citizenship or permanent residence is
required.", "Bilingual (English/French) required.") so the gate is observable
end to end without a credentialed source.

## 5. Surfaces — `PASS` (route and page code; build passes)

- **Job feed** — "N postings your agents found were excluded by an
  eligibility requirement. See which, and why." → `/dashboard/jobs/excluded`,
  every exclusion with its reasons. Nothing is hidden silently.
- **Job page** — an eligibility panel above the fit score: the outcome,
  every rule with its status and reason, advisory rules marked, the rule-set
  version and the date. Evaluated on view only when no current verdict is
  stored (staleness checked from timestamps, without an audited read).
- **Feed chip** — "Eligibility unconfirmed" on a match whose verdict is
  `unknown`; an ineligible verdict never reaches the feed at all.
- **Scan result** — "(N excluded as ineligible — see the feed for why)".
- **`GET /api/eligibility/:jobId`** — the structured record: outcome, rules,
  `rulesVersion`, `evaluatedAt`. Never a number.

## 6. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **964 / 964**, 0 skipped (Stage 06: 942) — new: `eligibility-engine` 14, `eligibility-gate` 7 |
| Build | passes; `/dashboard/jobs/excluded`, `/api/eligibility/[jobId]` present |
| Migrations | twenty-one applied fresh; drift clean; 101/101 forced; RLS migration equals the generator output |

Run with the documented command only (the two test URLs; `DATABASE_URL` /
`DIRECT_URL` unset).

## 7. Exit gate — verdict

| Condition | State |
| --- | --- |
| Eligibility gates scoring | **MET** — evaluated in the scanner before `analyzeMatch`; an ineligible posting never becomes a match (tested end to end on the synthetic source) |
| Explanations human-readable | **MET** — every rule states a reason; no score anywhere; the page, the exclusions list, the feed chip and the API show them |
| No ineligible job reaches recommendations; every exclusion states a reason | **MET** (database test) |
| Never reads the sensitive schema; work authorisation access-controlled and audited | **MET** — tenant-path read, audit-first, static allowlist unchanged |
| Rule coverage per jurisdiction | **MET for Canada and the US** on the six named rules; radius is **NOT IMPLEMENTED** (no coordinates exist — province / city match only); clearance is **unknown-only** (no profile field); certification and language are **advisory** until Stage 08 |

**Verdict: Stage 07 passes every engineering gate; its exit is PARTIAL** on
the honest scope of two advisory rules and the absence of a radius, and on
the same inherited cause as Stages 05–06 (no real traffic). Merge posture
inherited from the stack.

## 8. What a founder or operator has to do

1. Nothing new for this stage to run; the candidate-side facts come from
   Settings › Work authorisation and Preferences, which exist since Stage 02.
2. Stage 08 upgrades certification and language to hard gates once
   requirement extraction separates required from preferred; a security
   clearance field on the profile is a Stage 02-shaped addition to decide.
3. Staging — unchanged (R-34).

## 9. Independent review — 3 HIGH, 5 MEDIUM, 4 LOW; every HIGH and MEDIUM closed with a test

A separate reviewer with no shared context read the full diff (`f22a696..96c82d8`),
reproduced the gate set, and probed the engine, the scanner and the page
path with throwaway scripts against the local database. Dispositions:

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| H1 | HIGH | `profileVersion` was derived from work authorisation and preferences only, so a licensure exclusion never re-evaluated after the candidate added the licence — contradicting the reason text and the exclusions page | **FIXED** — the version is the latest change across work authorisation, preferences, certifications and languages plus the row counts (a deletion moves no timestamp). Test: add "Registered Nurse (CNO)" → version changes, verdict re-evaluated to eligible |
| H2 | HIGH | A `JobMatch` created while eligible survived a later ineligible verdict; no feed filtered on eligibility, so the feed showed the exclusion count AND the excluded posting, and the panel's "not in your feed" was false | **FIXED** — an ineligible verdict demotes the candidate's open matches for that job to `ineligible` (never deleted; restored to `new` when the verdict lifts), and the feed, the dashboard and the v1 match feed filter on the verdict itself (`notIneligibleFor`). Test: eligible → match in feed; flip → demoted and out; flip back → restored |
| H3 | HIGH | Licensure matched designations by substring ("rn" inside "Certified Inte**rn**al Auditor" held the licence; "Registered Nurse (CNO)" did not), used the raw title ("CPA preferred" demanded the CPA), and `\bnurse\b` caught "Nurse Aide" postings that merely mention the RN | **FIXED** — each designation has its spellings, matched on whole words; the normalised title is used and a title that merely prefers the designation is not a demand; title words are the profession itself (`registered nurse`, `rn`); an empty certification name holds nothing. Tests: every probe phrase |
| M4 | MED | Location matched by substring, so `on` (Ontario) matched Toronto, Boston, London and every Ontario candidate passed everything with a fabricated reason, while Québec/BC candidates were hard-excluded from a municipality next door; a work-mode word listed as a place failed; `workModes` was read into the input and never used | **FIXED** — whole-name matching only (city, province name, province code, country); the same province as a listed city but another municipality is `unknown` (no radius exists), another province a fail; work-mode words are ignored as places; `workModes` dropped from the input. Tests: Toronto vs Thunder Bay unknown, Boston vs Ottawa fail, Montreal vs Laval unknown, "Remote" as a place ignored, province code pass |
| M5 | MED | Every job-page view (and API call) read the facts and wrote an audit row even with a current verdict, contrary to the helper's own comment | **FIXED** — staleness is checked from timestamps and counts (`profileVersionOf`, no value read, no audit row); the audited read happens only when an evaluation is needed. Test: three views, one audit row; a profile change, one more |
| M6 | MED | A `security_clearance_required` statement was rewritten as an authorisation requirement, producing a hard fail for a sponsorship candidate on a statement the posting never made; the canonical field keeps one statement, so a citizenship requirement beside a clearance is dropped | **FIXED** in the engine — the authorisation rule answers `unknown` on a clearance statement (the clearance rule carries it); the single-statement limit of the canonical field is stated in the matrix and left for Stage 08's requirement extraction |
| M7 | MED | A `Job` row the canonical pipeline had not read yet (`canonicalHash` empty) was told "the posting states no requirement" | **FIXED** — `read` flag; every posting-side rule answers `unknown` with "not yet read". Test |
| M8 | MED | One `WorkAuthorization` row per user made a wrong-country hard fail unfixable for a dual-authorised candidate | **FIXED** — another recorded country is `unknown` with the same guidance, not a fail. Test |
| L9 | LOW | No settings form writes `CandidateLanguage`; `fr-CA` / "French (Canada)" did not canonicalise | **PARTLY FIXED / DOCUMENTED** — regional codes and names canonicalise (test); the missing form is a Stage 02 gap recorded in the matrix |
| L10 | LOW | Scan message said "nothing new above your threshold" when everything was excluded; the audit row was written for an empty batch; the user-typed agent name landed in `AuditLog` | **FIXED** — the message names the exclusions; no read for an empty batch; the audit carries a fixed reason code and the agent id, never user text |
| L11 | LOW | "No number anywhere" overclaimed (dates, the rule-set version); some matrix cells untested; the feed had no `unknown` marker | **FIXED** — "no score" (a test asserts no percentage, score or ratio); the `other` status, province code, place-level relocation and US city cases are tested; the feed shows an "Eligibility unconfirmed" chip |
| L12 | LOW | `page.ts` re-implemented the verdict parser with bare `JSON.parse`; the exclusions list capped at 100 while the count was unbounded and both included closed jobs | **FIXED** — shared `toVerdict`; open postings only in both, cap 200 |

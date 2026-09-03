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
number anywhere in the output (a test asserts no percentage in any reason).
Jurisdictions modelled: Canada and the US, by the posting's country; another
jurisdiction answers `unknown`.

| Rule | Hard? | Posting fact (Stage 06 canonical) | Candidate fact | pass | fail | unknown |
| --- | --- | --- | --- | --- | --- | --- |
| `work_authorization` | yes | `workAuthorization`: null · `authorization_required` · `citizenship_or_pr_required` (· clearance, treated as authorisation for this rule) | `WorkAuthorization.country`, `.status`, `.permitExpiresAt` | posting silent; citizen / PR in the posting's country; valid work permit for an authorisation requirement | wrong country recorded; requires sponsorship; expired work permit; work or study permit against a citizenship requirement | not recorded / unspecified; study permit against an authorisation requirement (limited work); unmodelled jurisdiction; an unrecognised status |
| `sponsorship` | yes | `sponsorship`: offered · not_offered · unknown | `sponsorshipNeeded` or status `requires_sponsorship` | not needed; needed and offered | needed and not offered | needed and the posting is silent |
| `security_clearance` | yes | `workAuthorization = security_clearance_required` | none (clearances are not on the profile yet) | posting silent | — (never: the profile cannot say) | posting requires a clearance |
| `location` | yes | `workMode`, `country`, `postalRegion`, `location` | `CareerPreferences.countries`, `.locations`, `.relocation` | remote; no preference recorded; country and place listed (province name, code or city); outside the list but open to relocating | another country or another place with relocation `no` | a place listed but the posting's location unparseable |
| `licensure` | title-dependent | `certificationRequirements` | `Certification.name` | every listed designation held; none listed | a licensed designation (RN, LPN, P.Eng., CPA) the TITLE demands, not held | a certification merely mentioned and not held (the posting may prefer it) |
| `language` | no (advisory) | `languageRequirements` ("bilingual" = English + French in Canada, English + Spanish in the US) | `CandidateLanguage` at conversational or better | none listed; all held at a working level | — (never) | a listed language not held at a working level |

**Verdict:** any hard `fail` → `ineligible`; else any `unknown` → `unknown`;
else `eligible`. `unknown` never excludes: the posting reaches scoring and
the page shows "eligibility unconfirmed" with the open question.

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
| One verdict per (user, job); reused while the profile and the rule set are unchanged; re-evaluated when the candidate's work authorisation changes (`profileVersion`) | PASS |
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
  version and the date. Evaluated on view when no current verdict is stored.
- **Scan result** — "(N excluded as ineligible — see the feed for why)".
- **`GET /api/eligibility/:jobId`** — the structured record: outcome, rules,
  `rulesVersion`, `evaluatedAt`. Never a number.

## 6. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **959 / 959**, 0 skipped (Stage 06: 942) — new: `eligibility-engine` 12, `eligibility-gate` 4 |
| Build | passes; `/dashboard/jobs/excluded`, `/api/eligibility/[jobId]` present |
| Migrations | twenty-one applied fresh; drift clean; 101/101 forced; RLS migration equals the generator output |

Run with the documented command only (the two test URLs; `DATABASE_URL` /
`DIRECT_URL` unset).

## 7. Exit gate — verdict

| Condition | State |
| --- | --- |
| Eligibility gates scoring | **MET** — evaluated in the scanner before `analyzeMatch`; an ineligible posting never becomes a match (tested end to end on the synthetic source) |
| Explanations human-readable | **MET** — every rule states a reason; no number anywhere; the page, the exclusions list and the API show them |
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

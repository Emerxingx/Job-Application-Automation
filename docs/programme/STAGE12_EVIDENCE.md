# Stage 12 — Application preparation (assisted, human-in-the-loop) — evidence

Recorded 2026-09-03 on branch `claude/stage-12-assisted-application`,
stacked on Stage 11 (PR #23) → 10 (#22) → 09 (#21) → 08 (#20) → 07 (#19) →
06 (#18) → 05 (#17) → 04 (#16) → 03 (#15) → 02 (#14) → 01 (#13, PARTIAL).
Every line was run or read; nothing is PASS on the strength of a mock, a
skipped test or a document. This stage's honest centre: **the assisted
path is now structurally human-in-the-loop — preparation never submits,
submission exists only as the applicant's instructed click, and
Auto-Apply has no setting, flag or role that reaches it. What is NOT
proven is a real submission to a real board: no sandbox credential exists
here, so the ATS channel is exercised only against the deterministic mock
and stays IMPLEMENTED-NOT-VALIDATED.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 12: make assisted apply excellent, not
autonomous. Preserve the apply providers and the assisted posture. Wire the
question bank with its policy states. Validate authorised ATS submission
with a consenting employer credential. Optional browser extension. Model
the four modes with Auto-Apply disabled and unreachable. No CAPTCHA bypass,
no ToS circumvention, no fingerprint evasion; `NEVER_AUTOMATE` questions
always require a human. Move `FieldMappings` out of the CMS into governed
administration with versioning, audit, approval, step-up, rollback and the
exact version recorded per application. Testing: mode enforcement proving
Auto-Apply cannot execute; ATS submission against a sandbox board.
Acceptance: assisted apply completes in one click after review;
autonomous submission is impossible. Exit gate: assisted path validated
end-to-end; ATS reclassified SANDBOX-VALIDATED; FieldMappings under
governed administration.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903200000_assisted_application` | `User.applicationMode` (default `review_submit`); `Application.preparedQuestions`, `applicationMode`, `fieldMappingVersion` (default `builtin:1`), `atsSubmittable`; `FieldMappingVersion` register | applied fresh and incrementally; drift clean; every column defaulted |
| `20260903200100_rls_field_mapping_table` | Generated (manifest `RLS_MANIFESTS[11]`): `FieldMappingVersion` system-only | determinism test; 117 public tables forced |

## 3. Modes — `PASS`

`src/lib/apply/modes.ts` (pure): three reachable modes; `approved_auto_apply`
is named and refused by `parseApplicationMode` with the reason (ADR-0016,
Stage 22) — the profile route parses through it, so no request stores it;
a stored value that is not a reachable mode reads back as the default. The
permission table names four actions; `submit_unattended` is false in every
mode and the unreachable mode has no row (`tests/application-modes.test.ts`).
Enforcement: the apply route and the applicator refuse `recommend_only`
before anything is generated (quota refunded); `submitThroughAts` refuses
any mode but `review_submit`. Settings shows the three modes and a
disabled, labelled "Approved Auto-Apply — not available" row.

## 4. Preparation never submits — `PASS`

Every provider's `apply()` returns a prepared package or `unavailable`.
`tests/apply-engine.test.ts`: with an employer credential set for
Greenhouse, `apply()` still returns `assisted` with no confirmation;
`canSubmit` is true for that board and false for one without a credential;
the assisted-only engine's `canSubmit` is false whatever exists; the mock
prepares first and "submits" only on `submit()`. The applicator writes
`ready_to_submit` or `failed` — never `submitted` — and records the mode,
the prepared questions, the mapping version and `atsSubmittable` (true only
in `review_submit` with an authorised board).

## 5. Submission on instruction — `PASS` (mock) · `IMPLEMENTED-NOT-VALIDATED` (real)

`POST /api/applications/:id/submit` → `submitThroughAts`: owner-scoped;
mode `review_submit` only; status `ready_to_submit` only; `atsSubmittable`
and the engine's `canSubmit` re-checked at click time; then the provider's
`submit`, a status-machine move to `submitted` with source `ats_api` and
the reason "on the applicant's instruction after review", the
confirmation recorded, the documents sealed (Stage 09). A refusal leaves
the record ready for the form with the reason stored. The manual path
(`/confirm`, "I submitted this on the employer's form") is unchanged.

**No real board has been submitted to.** `submitToAts` (Greenhouse, Lever)
is unchanged from Stage 00 and has never been called with a live
credential; there is no sandbox board credential in this environment. The
register keeps both at IMPLEMENTED-NOT-VALIDATED; "SANDBOX-VALIDATED" is
NOT MET and stated.

## 6. The question bank in the package — `PASS`

`src/lib/apply/prepare.ts` (pure): each stored question prepared with the
Stage 03 decision — `fill` (contact, or ASK_IF_CHANGED confirmed after its
last change), `ask`, `review`, `never`. **A `never` entry carries no value
and no evidence ids whatever is stored** (`carriesNeverAutomatedValue` is
the guard; tested with a stored answer on a NEVER_AUTOMATE row). A profile
fact stands in only where the active register maps the question to a
profile key and the policy allows a value — work authorisation and
sponsorship do; a salary never does ("no profile fact for a salary — never
a number"). Nothing is invented for an empty answer. The assisted panel
shows each question with its decision chip and hint; "Answer yourself" has
no copy button and no value.

## 7. Field mappings as governed data — `PASS`

`FieldMappings` is removed from the CMS (`src/cms/collections/FieldMappings.ts`
deleted; `payload-types.ts` and the import map regenerated with the repo's
tooling). `src/lib/apply/field-mappings.ts`: thirteen built-in mappings
(`builtin:1`); `validateMappings` (unique snake_case keys, compiling
patterns, select options, a fallback rule that may not say invent / assume
/ guess); `matchMapping` (first satisfied pattern, case- and
punctuation-insensitive); the lifecycle draft → second-admin approval →
active with a mandatory reason → retired, rollback recorded as rollback,
advisory-locked, audited, cache-invalidated; an invalid stored row falls
back to the built-in set and is not cached. `tests/field-mappings.test.ts`
(database) and the pure matcher / validator tests. Console:
`/console/field-mappings` (admin, step-up). Every application records
`fieldMappingVersion`. This closes the last Tier-1 migration of ADR-0019.

## 8. Surfaces

- Settings → "How applications are handled": the three modes with their
  meaning; the fourth shown disabled with why.
- Job feed: "N prepared for your review" — never "submitted" at preparation.
- Application folder → "Ready to send": profile fields (copy), the
  question bank with decisions, and — only when the employer has authorised
  it and the mode permits — "Submit through <ATS>" beside "I submitted this
  on the employer's form". The copy says nothing is sent otherwise.

## 9. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **1050 / 1050**, 0 skipped (Stage 11: 1033) — new: `application-modes` 4, `prepared-questions` 6, `field-mappings` 5; `apply-engine` +1 rewritten |
| Build | passes; `/api/applications/[id]/submit`, `/api/console/field-mappings`, `/console/field-mappings` present |
| Migrations | thirty-two applied fresh; drift clean; 117 public tables forced; RLS migration equals the generator output |

## 10. Exit gate — verdict

| Condition | State |
| --- | --- |
| Assisted apply completes in one click after review | **MET** on the mock engine (prepare → review → instructed submit → `submitted` with confirmation, sealed) |
| Autonomous submission is impossible | **MET** — no provider, mode, flag or route submits without the applicant's click; tested at the mode table, the providers and the routes |
| Question bank wired with its policy states; `NEVER_AUTOMATE` always human | **MET** |
| `FieldMappings` under governed administration with the exact version per application | **MET** |
| Assisted path validated END-TO-END against a real board; ATS reclassified `SANDBOX-VALIDATED` | **NOT MET — BLOCKED (CREDENTIAL)**: no sandbox board credential exists here; never called live |
| Browser extension | **NOT IMPLEMENTED** (optional in the plan; the `PreparedField` contract is the seam) |

**Verdict: Stage 12 passes every engineering gate that can be run here;
its exit is BLOCKED** on a sandbox ATS credential — the submission channel
is IMPLEMENTED-NOT-VALIDATED and the register says so — and PARTIAL on
the inherited causes. Merge posture inherited from the stack.

## 11. What a founder or operator has to do

1. Obtain a Greenhouse Job Board API sandbox credential (or a consenting
   employer's board token) and a Lever sandbox; set
   `ATS_GREENHOUSE_<BOARD>` / `ATS_LEVER_<BOARD>`; run prepare → review →
   submit against it and record the result in the register.
2. Decide whether a browser extension is wanted; the contract is in
   `providers/apply/types.ts`.
3. Review the built-in mapping set at `/console/field-mappings` and, if
   it is to be changed, do so through a governed version.
4. Staging — unchanged (R-34).

## 12. Independent review

PENDING — recorded here when done.

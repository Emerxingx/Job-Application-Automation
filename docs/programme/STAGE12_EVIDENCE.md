# Stage 12 — Application preparation (assisted, human-in-the-loop) — evidence

Recorded 2026-09-03 on branch `claude/stage-12-assisted-application` (PR #24),
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
mode `review_submit` only; then, under an advisory lock on the
application, the CLAIM — `ready_to_submit → applying` through the status
machine (source `ats_api`) — so a second click, a retry or a second tab
finds it `applying` and is refused before any engine call; `atsSubmittable`
and the engine's `canSubmit` re-checked; the provider's `submit`; on success
`applying → submitted` with the reason "on the applicant's instruction after
review", the confirmation recorded, the documents sealed (Stage 09), the
match marked `applied` (only now — a prepared match is `reviewed`). An
engine refusal releases the claim (`applying → ready_to_submit`) with the
reason on the record; nothing retries unattended. **Proven end to end
against the database with the deterministic mock engine**
(`tests/assisted-submission.test.ts`): the three moves in the history, the
seal, the match, a second click refused, another user / a non-permitting
mode / a record not awaiting review / an unauthorised board refused without
touching the engine, an engine refusal releasing the claim, and two
simultaneous clicks reaching the engine exactly once. The manual path
(`/confirm`) is unchanged and now also marks the match applied.

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
| Tests | **1054 / 1054**, 0 skipped (Stage 11: 1033) — new: `application-modes` 4, `prepared-questions` 6, `field-mappings` 5, `assisted-submission` 4 (database, end to end); `apply-engine` +1 rewritten |
| Build | passes; `/api/applications/[id]/submit`, `/api/console/field-mappings`, `/console/field-mappings` present |
| Migrations | thirty-two applied fresh; drift clean; 117 public tables forced; RLS migration equals the generator output |

## 10. Exit gate — verdict

| Condition | State |
| --- | --- |
| Assisted apply completes in one click after review | **MET** on the mock engine, proven against the database (`assisted-submission` test: prepare → review → instructed submit → `submitted` with confirmation, sealed, match applied) |
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

An independent adversarial pass over the whole diff (autonomous submission,
authorization, tenant leakage, data, migration, the register, contract
consumers, false PASS, dead code). One HIGH, three MEDIUM, three LOW — every
one fixed:

| Severity | Finding | Disposition |
| --- | --- | --- |
| HIGH | The evidence and the status file claimed the instructed submission was proven "end to end on the mock", but no test called `submitThroughAts` or the submit route — a false PASS by this document's own standard | **Fixed** — `tests/assisted-submission.test.ts` (database): the full path, every refusal, the engine-refusal release, the double click; the claims now cite it |
| MEDIUM | `submitThroughAts` checked the status without a lock and only wrote after the employer-facing call, so two near-simultaneous clicks could both reach the ATS | **Fixed** — an advisory-locked CLAIM (`ready_to_submit → applying`, a new machine transition) before any engine call; the second caller is refused; tested with two concurrent calls |
| MEDIUM | `FieldMappingError` was not mapped in `governanceRoute`, so every register refusal surfaced as an opaque 500 | **Fixed** — mapped like its siblings |
| MEDIUM | `JobMatch.status` became `applied` on mere preparation (and `/api/v1` exposes it), now that `apply()` never submits | **Fixed** — a prepared match is `reviewed`; `applied` is written only by the confirmation or the instructed submission (tested) |
| LOW | The `submitted` counter and its job-feed branch were unreachable | **Fixed** — removed from `BulkApplyResult` and the feed; the activity message says "prepared" |
| LOW | `carriesNeverAutomatedValue` guarded nothing at runtime | **Fixed** — the applicator refuses to persist a prepared set that carries a never-automated value |
| LOW | No screening of admin regexes for catastrophic backtracking | **Fixed** — a quantified group that is itself quantified is refused by `validateMappings` (tested) |

Found sound, with the line read: no path submits without the applicant's
click; `approved_auto_apply` cannot be stored by any route, seed or default;
the settings radio is inert; every new query is owner-scoped; the applicator
and the register stay on the system client by design; a never-automated
answer never reaches the prepared set, the UI or the ATS payload; both
migrations are additive with defaults; the CMS collection is fully gone.

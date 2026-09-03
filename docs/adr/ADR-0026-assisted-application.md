# ADR-0026 — Preparation never submits: application modes with Auto-Apply unreachable, the question bank in the prepared package, submission only on the applicant's instruction, and field mappings as governed data

**Status:** Accepted (Stage 12, 2026-09-03) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 12 · **Refines:** ADR-0016 (application automation), ADR-0019 (admin configuration boundary — last Tier-1 migration), ADR-0003 · **Depends on:** ADR-0006 (evidence, question bank), ADR-0023 (documents), ADR-0024 (folder)

## Context

The apply engine prepared an application and, where an employer credential
existed for the posting's board, submitted it in the same call — before
the applicant had seen the package. ADR-0016 names "Review & Submit" as the
default mode and Approved Auto-Apply as modelled, disabled and unreachable,
but no mode was stored, enforced or visible; the question bank (Stage 03)
with its policies existed but nothing read it at preparation time; and
`FieldMappings` — the rules that decide which canonical fact answers which
form question — still lived in the editorial CMS, unversioned and
unaudited, the last Tier-1 configuration ADR-0019 required to move.

## Decision

1. **Preparation never submits, in any engine and any mode.** `apply()` on
   every provider (default, assisted-only, mock) returns a prepared package
   (`assisted`) or `unavailable`. The bulk applicator's `submitted` count is
   therefore always zero at preparation; a record is `ready_to_submit` or
   `failed`, never `submitted`, until the applicant acts.
2. **Three reachable modes, stored per applicant, enforced in code.**
   `recommend_only` (nothing generated), `prepare` (documents and fields;
   JobPilot sends nothing), `review_submit` (the default; the applicant may
   instruct a programmatic submission where the employer has authorised
   one). The fourth, `approved_auto_apply`, is named so nothing mistakes a
   typo for it and refused by `parseApplicationMode` wherever a mode is
   set; a stored value that is not a reachable mode reads back as the
   default. The permission table has no row for it, and no mode permits
   `submit_unattended` — a test asserts both.
3. **Submission is a separate, instructed step.** `submitThroughAts`
   runs only from the applicant's click on a prepared application they can
   see, only in `review_submit`, only when the engine can submit to that
   board (an employer-issued credential; `assisted-only` never can), and
   moves the record through the status machine with source `ats_api` and
   the reason "on the applicant's instruction after review". A refusal by
   the ATS leaves the record ready for the form; nothing retries unattended.
4. **The question bank is in the package, under its policies.** Every
   stored question is prepared with a decision — fill, ask (confirm
   first), review, never — from Stage 03's `resolveAutomation`. A `never`
   entry carries no value whatever is stored, and no evidence ids; a
   profile fact stands in only where the active mapping register names one
   and the policy allows a value at all; nothing is ever invented for an
   empty answer. The prepared set is stored on the application as ids and
   values.
5. **Field mappings are governed data.** `FieldMappingVersion` in the
   transactional database (system-only), administered at
   `/console/field-mappings` with the register discipline: draft → approval
   by a second admin → active with a mandatory reason (an older version is
   the rollback, recorded as one) → retired; step-up authentication; an
   audit row per change. A fallback rule may not tell anyone to invent,
   assume or guess an answer (validated). Until a version is active the
   built-in set applies and is recorded as `builtin:1`. **Every application
   records the exact register version it was prepared with.** The CMS
   collection is removed.
6. **Not built, stated.** Programmatic submission to a real board is
   IMPLEMENTED-NOT-VALIDATED: no sandbox board credential exists in this
   environment, so the ATS path has been exercised only against the
   deterministic mock. A browser extension consuming `PreparedField` is
   NOT IMPLEMENTED.

## Consequences

- No path in the codebase sends an application without a person's click
  on a package they have reviewed; the "auto-apply" the README once
  promised is structurally absent, not merely toggled off.
- The applicant sees exactly what is ready, what to confirm, what to
  review and what they alone must answer — and the register version behind
  the mapping.
- A mapping change is a governed act with a name, a second approver and a
  reason, and can be rolled back; an application prepared under v3 says so
  forever, even after v4 is active.
- The demo build's mock now prepares first and "submits" only on
  instruction, so the walkthrough shows the real posture.

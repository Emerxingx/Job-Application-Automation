# Stage 10 — Job Folder / Application CRM — evidence

Recorded 2026-09-03 on branch `claude/stage-10-job-folder-crm`, stacked on
Stage 09 (PR #21) → 08 (#20) → 07 (#19) → 06 (#18) → 05 (#17) → 04 (#16) →
03 (#15) → 02 (#14) → 01 (#13, PARTIAL). Every line was run or read; nothing
is PASS on the strength of a mock, a skipped test or a document. This
stage's honest centre: **one application record now carries its whole
story — every status change as history, the people, the interviews, the
assessments, the follow-ups, the notes, the offer and a structured outcome
— written on the tenant path, audited without content, and checked against
the acceptance question on the page itself; the "real end-to-end
application" the plan asks for as evidence does not exist, because no
credentialed job source exists.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 10: one canonical, auditable record per
application. Complete the field set: employer and recruiter contacts,
submission confirmation, interviews, assessments, follow-ups, notes, full
status history, offer, rejection, structured outcome. Artefacts durable.
Security: RLS; every access audited; export honours retention and erasure.
Testing: status-machine tests; retention/erasure behaviour; folder
completeness. Acceptance: a folder answers "what exactly was sent, to whom,
when, and what happened" without reference to any other system. Exit gate:
canonical folder live; artefacts durable. Gap G-14.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903180000_application_folder` | `Application` gains the structured outcome (`outcome`, `outcomeAt`, `rejectedAt`, `rejectionReason`), the offer (`offerReceivedAt`, `offerDeadline`, `offerSalaryMin/Max`, `offerCurrency`, `offerDecision`, `offerDecidedAt`) and `lastActivityAt`; six child tables — `ApplicationStatusHistory`, `ApplicationContact`, `ApplicationInterview`, `ApplicationAssessment`, `ApplicationFollowUp`, `ApplicationNote` — each owned by the applicant and cascading from the application | applied fresh and incrementally; drift clean |
| `20260903180100_rls_crm_tables` | Generated (manifest `RLS_MANIFESTS[9]`): all six user-owned (`userId`) | determinism test; **110/110** public tables forced |

## 3. The status machine — `PASS`

`src/lib/applications/status-machine.ts` is the machine as data: every
allowed move is in `TRANSITIONS` and nowhere else. An application that was
never sent cannot be interviewing; the only ways out of `ready_to_submit`
are the applicant's confirmation and a withdrawal; `rejected` and
`withdrawn` are terminal; the applicant records only post-submission
statuses from the folder. `transitionApplication` (`service.ts`) refuses
anything else with the reason in words, and — in ONE transaction — updates
the row (stamping `appliedAt`, `respondedAt`, `rejectedAt`, the outcome)
and writes the history row. The applicator writes the first history row
(`'' → queued|submitted|ready_to_submit|failed`, actor `system`, source
`applicator`); the assisted confirmation goes through the machine (source
`confirm`); the folder UI goes through it (source `ui`), and the first
interview added to a submitted application moves it to interviewing with
its own row.

Tested: every allowed pair and a table of refused pairs, with the table's
size asserted so nothing is allowed by accident (`tests/application-status-
machine.test.ts`); the database suite proves the row, the history row and
the audit commit together and roll back together (a move followed by a
throw in the same transaction leaves the status, no history and no audit).

## 4. The folder — `PASS`

| Field set (plan §4) | Where | Tested |
| --- | --- | --- |
| Employer and recruiter contacts | `ApplicationContact` (role, name, email, phone, organisation, notes); add / update / remove | yes |
| Submission confirmation | `Application.confirmation` (from the apply engine) and the `confirm` history row; assisted applications sealed at confirmation (Stage 09) | yes |
| Interviews | `ApplicationInterview` (kind, when, duration, location, interviewers, outcome, result); the first one moves the application | yes |
| Assessments | `ApplicationAssessment` (kind, due, submitted, result) | yes |
| Follow-ups | `ApplicationFollowUp` (due, channel, note, done; optionally the Stage 09 drafted message — verified to belong to this application); the applicant sends them, JobPilot records that they did | yes |
| Notes | `ApplicationNote`, append-only; `Application.notes` stays the legacy summary | yes |
| Full status history | `ApplicationStatusHistory` on every move, from creation | yes |
| Offer | the offer columns; `recordOffer` only at `offer`; an accepted decision settles `outcome = hired`, a declined one `declined` | yes |
| Rejection | `rejectedAt`, `rejectionReason` (coded) on the move to `rejected` | yes |
| Structured outcome | `outcome` ∈ pending · hired · rejected · withdrawn · declined · ghosted · expired, with `outcomeAt`; ghosted/expired recordable without pretending a status change | yes |

**Completeness** (`src/lib/applications/folder.ts`): the acceptance question
as a checklist on the page — *what was sent* (sealed Stage 09 files, else
the database copies for a sent application), *to whom* (a disclosed
employer, with contacts noted), *when* (`appliedAt`), *how* (the channel,
and for an assisted application the applicant's confirmation), *what
happened* (a response, an interview, an assessment or a settled outcome).
An unsent folder says "prepared, not sent yet" rather than claiming a
record. Tested pure and against real rows (a folder with a confirmed
submission, a contact, an interview and an accepted offer answers all five).

## 5. Security — `PASS` (writes) · access audit `PARTIAL`

- Every folder write runs inside `run()` (tenant role, RLS) with the
  owner filter in the service; another tenant sees no child row and every
  write against someone else's application is "not found" (tested).
- **Every write is audited** (`application.status`, `.offer`, `.outcome`,
  `.contact.*`, `.interview.*`, `.assessment.*`, `.follow_up.*`,
  `.note.added`) with **ids and kinds only** — the test writes a contact's
  name and email, an interviewer, interview and follow-up notes, a note
  body and a salary, and asserts none of them appear in any audit row.
  `AuditLog` is system-only, so the entries are buffered on the actor and
  flushed on the system client after the transaction commits; a rolled-back
  change flushes nothing (tested); a failed flush after a commit is logged
  loudly (the AiRun stance).
- **Reads are not individually audited.** The plan says "every access
  audited"; this stage audits every mutation and does not write an audit
  row per page view or API read. Stated, not approximated: a read audit
  would be one row per folder view and is a Stage 20/23 decision on
  volume and retention.

## 6. Export, retention and erasure — `PASS`

- The applications export (CSV) gains outcome, rejection reason, offer
  decision, interview count and last activity; the dataset reads the real
  rows (tested: `Hired`, `Accepted`, 1 interview).
- Retention: the folder's child tables share the application's row in the
  retention matrix (Applications & Job Folders, CONFIDENTIAL, 7 years);
  nothing here shortens or extends it.
- Erasure: every child cascades from `User` (and from `Application`);
  tested by deleting a third user with a folder and counting zero.

## 7. Artefacts durable — inherited from Stage 09

The documents are Stage 09 `DocumentVersion` rows (hashed, sealed, in the
object store); the folder's text files go through the same
`StorageProvider`. Durability across deploys still rests on a validated
object store (IMPLEMENTED-NOT-VALIDATED S3; local filesystem REAL) — the
Stage 09 caveat applies unchanged.

## 8. Surfaces

The application page carries the folder: the completeness checklist,
the timeline, the offer card (at offer), people, interviews (with advanced /
not advanced / cancelled), assessments, follow-ups (linkable to a drafted
message; "mark done"), notes, and "no response" / "posting expired"
outcomes. The outcome control now shows the machine's reason when a move is
refused and returns to the real status.

## 9. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **1012 / 1012**, 0 skipped (Stage 09: 999) — new: `application-status-machine` 6, `application-folder` 6 |
| Build | passes; the folder routes (`contacts`, `interviews`, `assessments`, `follow-ups`, `notes`, `offer`, `outcome`) present |
| Migrations | twenty-eight applied fresh; drift clean; 110/110 forced; RLS migration equals the generator output |

## 10. Exit gate — verdict

| Condition | State |
| --- | --- |
| Canonical folder live (full field set, history, outcome) | **MET** |
| Artefacts durable | **MET as tested; NOT VERIFIED across deploys** (object store, inherited from Stage 09) |
| RLS; every write audited without content; export honours retention and erasure | **MET** |
| Every access audited | **PARTIAL** — mutations only; reads not audited per view (stated) |
| A complete folder for a real end-to-end application | **NOT MET — BLOCKED (EXTERNAL_SERVICE / CREDENTIAL)**: no credentialed source, no live ATS; the database suite exercises the full chain on synthetic rows |

**Verdict: Stage 10 passes every engineering gate; its exit is PARTIAL** on
read auditing (scoped down and stated), on durability across deploys
(inherited) and on the absence of a real application to evidence. Merge
posture inherited from the stack.

## 11. What a founder or operator has to do

1. Decide whether folder READS are audited per view (volume and retention
   consequences) — Stage 20/23.
2. The Stage 09 store validation and a credentialed source (Stage 05)
   unblock the "real end-to-end application" evidence.
3. Staging — unchanged (R-34).

## 12. Independent review

PENDING — recorded here when done.

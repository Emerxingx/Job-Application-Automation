# ADR-0024 — One canonical application record: a status machine as data, history on every move, children on the tenant path, audit without content

**Status:** Accepted (Stage 10, 2026-09-03) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 10 · **Closes:** G-14

## Context

An application was a status column and a free-text note. Its status could
be set to anything from the UI ("interviewing" on a record that was never
sent), nothing recorded when it changed, and the people, interviews,
assessments, follow-ups, offer and rejection that make up what actually
happened had nowhere to live. The plan's acceptance — a folder that answers
"what exactly was sent, to whom, when, and what happened" without another
system — could not be met by a column.

## Decision

1. **The status machine is data.** `TRANSITIONS` lists every allowed move;
   the service refuses the rest with the reason in words. An application
   that never reached the employer cannot be interviewing; the only ways
   out of `ready_to_submit` are the applicant's confirmation and a
   withdrawal; `rejected` and `withdrawn` are terminal.
2. **Every move writes history in the same transaction** as the row
   update — from the applicator's creation, through the assisted
   confirmation, to the applicant's own recording — so the timeline is
   complete and cannot disagree with the row.
3. **The folder's children are the applicant's rows on the tenant path.**
   Contacts, interviews, assessments, follow-ups and notes are user-owned
   tables under RLS, written only through `run()` with the owner filter;
   the offer, the rejection and the structured outcome are columns on the
   application. The first interview moves a submitted application to
   interviewing with its own history row; an accepted offer settles the
   outcome as hired.
4. **Every write is audited with ids and kinds, never content.** `AuditLog`
   is system-only, so the service buffers entries on the actor and the
   caller flushes them on the system client after the commit; a rolled-back
   change leaves no entry. Reads are not audited per view — a deliberate,
   stated scope (volume and retention are a Stage 20/23 decision).
5. **The folder checks itself against the acceptance question.** A pure
   checklist (what was sent · to whom · when · how · what happened) is
   computed from the real rows and shown on the page; an unsent folder
   says so rather than claiming a record.
6. **Nothing here contacts anyone.** A follow-up is something the applicant
   did; the platform records that they did it.

## Consequences

- The legacy `Application.notes` remains as the summary; structured notes
  are append-only rows beside it.
- The export carries the structured outcome; retention and erasure follow
  the application (7 years; cascade from the user).
- Durability of the folder's artefacts is Stage 09's object-store caveat,
  unchanged.

# ADR-0025 — Mailbox and calendar intelligence reads headers only, under per-connection consent, with encrypted tokens, explainable association and a purging revocation

**Status:** Accepted (Stage 11, 2026-09-03) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 11 · **Closes:** G-15 (engineering) · **Classification:** RESTRICTED (DATA_CLASSIFICATION.md)

## Context

Filing employer email and interview invitations into the right application
folder is the highest-value candidate capability not yet built, and the one
with the largest privacy surface: OAuth grants over a personal mailbox,
message content, retention, revocation. The plan requires least-privilege
incremental scopes, explicit per-connection consent, a confidence-scored
association that never auto-files a low-confidence match, encrypted token
storage, retention limits, a revocation that purges derived content, and no
mailbox content in a prompt without explicit consent.

## Decision

1. **Metadata scopes only, by construction.** A connection asks for
   `gmail.metadata` / `calendar.events.readonly` or `Mail.ReadBasic` /
   `Calendars.Read` — scopes that cannot return a message body. The content
   scopes are listed in the inventory as a separate, incremental grant that
   no code path in Stage 11 requests; a grant that comes back carrying one is
   revoked and refused (tested).
2. **One connection, one consent.** `mailbox_sync` and `calendar_sync` are
   versioned consent purposes; the OAuth flow does not start without the
   current version, and the connection records the consent that authorised
   it. The state parameter is signed and bound to the signed-in user, so a
   callback cannot attach someone else's mailbox.
3. **Tokens are encrypted at rest in a system-only table.** AES-256-GCM
   under `MAILBOX_ENCRYPTION_KEY`; without the key nothing can be stored and
   the connection is refused. `MailboxSecret` has no tenant policy: the
   tenant role cannot read a token at all. Only the sync service decrypts,
   on the system client, to call the provider.
4. **References, never bodies.** The platform stores a thread's subject,
   participants, dates and provider ids, and a calendar event's title,
   organiser, times and attendees. No message body is requested, stored,
   logged or passed on. The association and detection engines are pure and
   receive only those fields; nothing under `src/lib/mailbox` imports the AI
   gateway or a model provider (static test), and the gateway refuses any
   payload carrying a `mailbox` key (ADR-0007's RESTRICTED check). AI over
   mailbox content is therefore NOT IMPLEMENTED, by design, until a consent
   design for it exists — not merely gated.
5. **Association is scored by named signals and never auto-files a doubtful
   match.** Contact address, employer domain (a label that IS the company
   name, not one that starts with it), an ATS sender beside a subject match,
   the subject naming the company or the role, timing after the application
   — weighted, summed, capped. At or above 0.85 with no rival within 0.1 the
   thread is filed automatically (reversible); between 0.5 and 0.85, or with
   a rival, it is a suggestion the applicant confirms or rejects; below 0.5
   it is left alone. The applicant's decision sticks across re-syncs.
   Detections (interview, offer) read the subject and the invite flag and
   fire events only for a filed thread.
6. **Revocation purges.** In one transaction: the secret, every thread and
   message reference, every calendar reference and every integration event
   derived from the connection are deleted and the connection marked
   revoked; the provider is asked to invalidate the grant (best effort; the
   purge does not depend on the answer). References older than the 180-day
   window are pruned on every sweep.
7. **Both real connectors are IMPLEMENTED-NOT-VALIDATED.** No Google or
   Microsoft client credentials exist in this environment; the adapters are
   written against the documented APIs and exercised only by type-checking.
   The fixture-backed connector is what every test runs. The exit gate "both
   providers live" is therefore NOT MET and BLOCKED on credentials; the
   register says so.

## Consequences

- A mailbox connection delivers filing and detection without the platform
  ever holding a message body; the trade is recall on threads whose subject
  and sender say nothing (they stay unfiled or become suggestions).
- The applicant sees exactly what was asked for (the scope inventory), why a
  thread was filed (its signals), and what revocation deleted (the counts).
- The event rows (`EMAIL_RECEIVED`, `INTERVIEW_DETECTED`, `OFFER_RECEIVED`)
  are the seam for the folder and for the event bus ADR-0011 has not built;
  nothing consumes them automatically yet.

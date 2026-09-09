# Support process (Stage 24, ADR-0038)

**Status:** WRITTEN; no support address is configured and no ticket has
ever been handled from a real customer. What exists in code: the support
ticket model and the staff console's ticket queue (`/console/tickets`),
the audit feed per account, impersonation (read-only, audited), the
person's own erasure request and session list under Settings.

## Channels

| Channel | Exists | Notes |
| --- | --- | --- |
| In-product tickets (`SupportTicket`, `/console/tickets`) | yes | the record of every case; a customer's message is CONFIDENTIAL and never leaves the ticket |
| Support email | NO | the founder chooses the address; it is not in the code and must not be hard-coded |
| Status page | NO (`SLOS.md`) | |
| Phone | NO | |

## Tiers and response targets (proposed)

| Tier | Who | Examples | Target |
| --- | --- | --- | --- |
| 1 | founder / support | sign-in, billing questions, "where is my document", how-to | first reply within 1 business day |
| 2 | engineer | a page errors, a document refuses to open (hash mismatch), a mart says stale, an integration refused | 2 business days; an incident if it matches `INCIDENT_RESPONSE.md` |
| Privacy | founder + counsel | access request, correction, erasure beyond the self-service route, a complaint | acknowledge within 2 business days; statutory clocks apply (PIPEDA 30 days) |

## Rules that do not bend

- **Look, do not touch.** A support person reads a customer's account
  through impersonation (`/console/users`, read-only, an hour, a reason,
  audited) - never through a database session (`BREAK_GLASS.md`).
- **Never ask for a password or a token**; never accept one in a ticket.
  A customer who pastes one is told to rotate it and the ticket notes
  that it was pasted, not the value.
- **The sensitive schema is never opened for a support case** (ADR-0007).
  A self-identification question is answered with "you can see and change
  it under Settings; nobody else can".
- **A privacy request is a record, not a chat**: the ticket carries the
  request, the identity check performed, the date, and the outcome; the
  self-service erasure route is offered first; a request that needs more
  goes to the founder and counsel.
- **A security report goes straight to the incident process**
  (`INCIDENT_RESPONSE.md`), and the reporter gets an acknowledgement the
  same day.

## Escalation

Tier 1 → Tier 2 by reassigning the ticket; Tier 2 → incident when
`INCIDENT_RESPONSE.md`'s severities apply; anything with personal data
exposure is Sev 1 from the first minute.

## Not done, stated

- No address, no hours, no on-call, no SLA to a customer.
- No knowledge base; the CMS (`/admin`) can hold one and does not yet.
- No customer-facing status page.

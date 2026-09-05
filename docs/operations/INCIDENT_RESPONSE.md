# Incident response — the runbook (Stage 23, ADR-0037)

**Status:** WRITTEN; never exercised in a real incident; no on-call rota
exists (Stage 24). Readiness gate G4 "Monitoring & alerting: present with
on-call" stays FAIL until Stage 24; this document is what the person who
answers the alert follows.

## Severities

| Sev | Meaning | Examples | Response |
| --- | --- | --- | --- |
| 1 | Personal data exposed, or the platform down for everyone | cross-tenant read; database unavailable; secret leaked | Act now; founder informed within 1 hour; privacy assessment starts the same day |
| 2 | A product unusable, or a security control failed without known exposure | login broken; RLS policy dropped by a migration; a source scraped against its terms | Act within 4 hours; founder informed same day |
| 3 | Degraded, with a workaround | marts stale beyond SLA; a connector failing; slow pages | Next working day |

## First fifteen minutes

1. **Confirm** with primary sources: `GET /api/health` (status and the
   failing check), the provider's status page, the audit log
   (`/console/audit`, filter by action), the failed-payments queue if
   billing. Do not act on a single alert's text alone.
2. **Contain** before diagnosing when data may be exposed: revoke the
   affected sessions and keys (`/console/users` → sign out everywhere;
   SCIM/API keys per organisation), suspend the organisation if the
   exposure is organisational (`/console/organizations`), disable the
   connector (`/console/sources`), rotate the secret. Every one of these is
   audited; do not do them from a database shell.
3. **Communicate**: one message in the founder channel with severity, what
   is known, what was contained, who is acting. Update every 30 minutes for
   Sev 1, hourly for Sev 2.
4. **Record**: open an incident note (date-time, severity, timeline as it
   happens). The audit log is evidence; nothing in it is edited or deleted
   (`AuditLog` is append-only with a hash chain).

## Diagnosis

- Logs never carry an email, a token or a connection string
  (`src/lib/log.ts` redacts every unhandled error); if a log line does, that
  is itself a Sev 2 finding — fix the emitter.
- Impersonation is READ-ONLY and audited (Stage 20): use it to see what the
  person sees; never to change anything on their behalf.
- Do not query the `sensitive` schema during an incident unless the
  incident is about it; if you must, it goes through `src/lib/sensitive/`
  and the read is audited.

## Personal-data incidents (privacy breach assessment)

Applies to PIPEDA and BC PIPA obligations; the platform is a data
controller for candidates and a processor for organisations' client data.
Within the first day: what data, whose, how many, for how long, and whether
a real risk of significant harm exists. The founder decides on notification
with counsel (L-1 for public-sector clients). The affected organisations
are told through their owner; the affected people through the address on
their account. Keep the record of the assessment whatever the decision.

## After

- A written post-incident review within five working days: timeline,
  cause, what contained it, what would have prevented it, the action items
  with owners. Blameless.
- Every action item becomes a risk-register entry or a code change with a
  test; "we will be more careful" is not an action item.
- If a control failed, `PRODUCTION_READINESS_GATES.md` is re-measured for
  that row.

## Contacts and tools (to fill in at Stage 24)

| Role | Who | How |
| --- | --- | --- |
| Founder | — | — |
| Counsel | — | — |
| Provider support (database, storage) | — | — |
| Status page | — (none exists) | — |

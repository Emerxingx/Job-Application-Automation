# Break-glass access (Stage 24, ADR-0038)

**Status:** the procedure is WRITTEN and the audit command is BUILT
(`npm run ops:break-glass`); it has never been used on a production
system because none exists. Readiness gate G2 "Impersonation" is PASS
(Stage 20); this page covers the one access the application cannot
mediate: a person connecting to the production database or the object
store directly.

## What break-glass is

Every routine operation has an application path that is authorised,
audited and read-only where it must be: the staff console (`/console`,
two-lock, step-up on every write), impersonation (read-only, one hour, a
reason, both cookies bound), the operator commands (`retention:sweep`,
`analytics:rollup`, `jobs:freshness`, `db:backup`). Break-glass is the
exception: a human opening a direct session on the production database
(`DIRECT_URL`) or the bucket, outside every application control, because
an incident needs it (`INCIDENT_RESPONSE.md`) or a recovery does
(`DISASTER_RECOVERY.md`).

It is never used for a routine business change - those go through the
console; if the console cannot do it, the missing console feature is the
finding.

## The rules

1. **Record it first.** Before the session is opened:

   ```
   npm run ops:break-glass -- --actor <staff email> --reason "<incident id or recovery scenario>" --ticket <reference>
   ```

   writes one `ops.break_glass` row to `AuditLog` (the actor's email, the
   reason, the ticket, the time; never a credential, never what was read)
   and prints the row id. The row exists before the session; a session
   without a row is itself a Sev 2 finding.
2. **Two people.** The person with the credential and a second person who
   knows the session is open (the founder, until there is a team). One
   person alone never opens a production session outside an outage where
   nobody else is reachable, and then the row says so.
3. **The session-mode endpoint, never the pooler.** `DIRECT_URL` is the
   endpoint for a human; a session-level `SET ROLE` through the transaction
   pooler leaks into other connections (`DEPLOYMENT_ARCHITECTURE.md`).
4. **Read before write; write in a transaction.** `BEGIN`, the change,
   `SELECT` to prove it, `COMMIT` - or `ROLLBACK`. A `DELETE` or `UPDATE`
   without a `WHERE` clause is refused by the operator's own discipline;
   nothing in PostgreSQL stops it, which is why the row and the second
   person exist.
5. **Never the `sensitive` schema** (ADR-0007) except in a recovery that
   restores it whole; a value there is never read by a person.
6. **Close it.** Record the end with the same command and `--close <row id>`;
   the second row carries what was changed in words (table names and
   counts, never a value).
7. **Rotate after.** If the credential was pasted anywhere other than the
   terminal that used it (a chat, a ticket), rotate it the same day.

## Who holds the credential

Until the founder names a team: the founder, in the secrets manager
(`DEPLOYMENT.md` §Secrets), and nobody else. The build environment does
NOT hold a usable one (`CLAUDE.md` item 8) and this programme never
printed one.

## What the audit row proves

That a session was opened, by whom, why and when - and, on closure, what
changed in words. It does not prove what was read: PostgreSQL's own
`log_statement` on the provider is the only record of that, and turning
it on for the duration of a break-glass session is part of the procedure
where the provider allows it.

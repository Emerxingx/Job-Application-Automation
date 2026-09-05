# Backup and restore — procedure and rehearsal (Stage 23, ADR-0037)

**Status:** the operator's logical backup and restore are BUILT and
REHEARSED against local PostgreSQL 16 (log below). The managed provider's
continuous backup and point-in-time recovery are configured on the
provider's side and are **NOT VERIFIED** from this environment (the staging
project is not reachable from here — `CLAUDE.md` item 8). Readiness gates G3
"Backups" and "Restore rehearsal" move from FAIL to PARTIAL / PASS (local)
accordingly; they are PASS for production only when the provider's PITR has
been exercised once against a copy and the log is added to this file.

## What a backup is

`npm run db:backup -- <dir>` (`scripts/db/backup.sh`) writes
`jobpilot-<UTC>.dump` in `pg_dump` custom format plus a `.sha256`, from
`DIRECT_URL` (the session endpoint, never the transaction pooler), with
`--no-owner --no-privileges`. It includes every schema — the `sensitive`
schema (ADR-0007) included, because a backup that omitted it would be a
data loss on restore — so the file is RESTRICTED data: `umask 077`, stored
only where the residency decision allows (ADR-0015), never attached to a
ticket, never left on a laptop. It never prints a connection string.

## What a restore is

`RESTORE_URL=<empty target> npm run db:restore -- <dump>` (`scripts/db/restore.sh`):

1. verifies the checksum and refuses a damaged dump;
2. creates the `app_tenant` and `app_sensitive` roles if the target cluster
   lacks them (roles are cluster-level and are not in the dump; the RLS
   policies in the dump reference them by name);
3. `pg_restore --exit-on-error` into the EMPTY target;
4. proves the result: every migration in the restored history is applied
   and none pending or failed; the number of tables under forced row-level
   security; the row counts of eight tables to compare with the source.

A production restore goes to a FRESH instance and the application is
repointed at it after the checks pass; nothing is ever restored over the
live database. Recovery of a single table from a dump is
`pg_restore --table` from the same file.

## Rehearsal — 2026-09-05, local PostgreSQL 16 (port 5433)

Source: `jobpilot_test21` (the migrated test database, 56 migrations).
Target: `jobpilot_restore`, created empty.

```
== backup (2026-09-05T18:51:11Z)
backup written: jobpilot-20260905T185111Z.dump (678955 bytes), checksum e7932028b39062f8…
== source counts
User             1 rows
Organization     176 rows
Application      0 rows
Invoice          0 rows
Payment          0 rows
AuditLog         171 rows
ConsentRecord    2 rows
DocumentVersion  0 rows
== restore into a fresh database
checksum verified
restore completed
migrations applied: 56, pending or failed: 0
tables with forced row-level security: 157
User             1 rows
Organization     176 rows
Application      0 rows
Invoice          0 rows
Payment          0 rows
AuditLog         171 rows
ConsentRecord    2 rows
DocumentVersion  0 rows
== drift check on the restored database
schema matches prisma/schema.prisma (no drift)
== RLS mechanism on the restored database
102   (tenant_access policies present)
```

Outcome: the restored database carries the full migration history, the
same row counts, every table under forced RLS with its policies, and no
drift from `prisma/schema.prisma`. Time to restore: seconds at this size;
NOT measured at production size.

## What the first rehearsal missed, and the second rehearsal (review H2)

The independent review of Stage 23 found that the dump above was taken
with `--no-privileges`: every `GRANT` and `ALTER DEFAULT PRIVILEGES` the
RLS migration issued to `app_tenant` and `app_sensitive` was dropped, role
membership is never in a dump, and the restored history was marked applied
so `migrate deploy` would never re-issue them. The checks above (policy
count, drift, row counts, `/api/health`) all passed on a database the
TENANT PATH could not read: `SET LOCAL ROLE app_tenant` followed by any
query would have failed with "permission denied". A false PASS, caught by
review, not by the rehearsal.

Fixed: `backup.sh` keeps privileges (`--no-owner` only); `restore.sh`
grants `app_tenant` and `app_sensitive` to the restoring login and then
PROVES both paths inside a transaction (`set_config` + `SET LOCAL ROLE
app_tenant` + a read of a forced table; the same for the sensitive
schema), exiting non-zero if either fails. Re-run 2026-09-05 (source
`jobpilot_test21`, target `jobpilot_restore` recreated empty):

```
== backup 2026-09-05T19:39:45Z
backup written: jobpilot-20260905T193945Z.dump (726066 bytes), checksum 8523fe3aeed261d1…
== restore
checksum verified
restore completed
role membership granted to the restoring login
tenant path: tenant-path-ok:0
sensitive path: sensitive-path-ok:0
migrations applied: 56, pending or failed: 0
tables with forced row-level security: 157
User             1 rows
Organization     214 rows
AuditLog         219 rows
ConsentRecord    2 rows
== the application's own tenant path on the restored copy
tests/tenancy-isolation.test.ts + organizations + sessions, TENANCY_TEST_DATABASE_URL=<restored>: 31 / 31 pass
```

The last line is the proof the first rehearsal lacked: the real Prisma
client, through the migrated schema, with filters removed, isolating
tenants on the restored database.

## Schedule and retention (proposed, to be confirmed at Stage 24)

| What | Frequency | Retention | Where |
| --- | --- | --- | --- |
| Provider continuous backup / PITR | continuous | 7 days (provider default; 30 proposed) | provider, Canadian region |
| `db:backup` logical dump | daily, before every migration deploy | 35 daily, 12 monthly | object storage, Canadian region, `backups/` prefix, private |
| Object storage (documents, exports, warehouse) | provider versioning | 30 days of versions | provider |
| Restore rehearsal | monthly, and before every migration that drops or rewrites a column | log appended here | — |

Backups are exempt from immediate erasure (DATA_RETENTION_MATRIX rule 4):
an erased person's data leaves the backups on the backup schedule, and the
`DeletionRequest` row (retained) is the record that a restore must re-run
`executeErasure` for that account before the restored copy serves traffic.

## What is NOT done

- The managed provider's PITR has never been exercised (NOT VERIFIED).
- No restore has been timed at production size.
- No automatic scheduling exists; `db:backup` is an operator command until
  Stage 24 wires a job.

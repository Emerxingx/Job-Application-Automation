# Rollback (Stage 24, ADR-0038)

**Status:** the procedure is WRITTEN and REHEARSED locally (log below) for
the one case that needs more than a redeploy: a release that applied a
migration. A rollback on the managed provider, with its PITR, has NOT been
rehearsed (no production environment exists). Readiness gate G4
"Rollback: rehearsed" moves from FAIL to PARTIAL (local).

## The two kinds of rollback

1. **Application only** (the schema did not move in this release): redeploy
   the previous pinned commit. Nothing else. `npm run smoke -- <origin>`
   afterwards. Sessions, keys and data are untouched.
2. **Application and schema** (the release ran `db:migrate:deploy`):
   migrations are forward-only (`DATABASE_MIGRATIONS.md` - a rolled-back
   schema is a RESTORE, never a hand-written "down" migration). The deploy
   sequence (`DEPLOYMENT.md` §0) took a backup BEFORE the migration ran;
   that dump is the restore point.

   1. Stop the worker and put the application in maintenance (the platform's
      switch; the health check will answer 503 from a restored copy until
      the repoint).
   2. Restore the pre-migration dump into a FRESH database:
      `RESTORE_URL=<empty target> npm run db:restore -- <dump>`; the script
      proves the history, the RLS roles and grants, and the tenant and
      sensitive paths.
   3. Redeploy the previous pinned commit against the restored database
      (`DATABASE_URL` / `DIRECT_URL` in the secrets manager).
   4. `npm run smoke -- <origin>`; `GET /api/health` is `ok` or `degraded`.
   5. Restart the worker on the previous commit.
   6. **Data written between the migration and the rollback is lost** unless
      recovered by hand from the abandoned database; say so in the incident
      note (`INCIDENT_RESPONSE.md`). A migration that is additive (every
      Stage 24 migration is) can often be left in place instead - the
      previous application ignores columns and tables it does not know -
      which is why step 2 is a decision, not a reflex: roll the application
      back first, and restore only if the schema itself is the fault.

Never: a "down" migration written under pressure; `db:push`; editing
`_prisma_migrations` by hand; restoring OVER the live database.

## Rehearsal - 2026-09-05, local PostgreSQL 16 (port 5433)

Scenario: a release applied two migrations (`20260905220000_operations`,
`20260905220100_rls_operations`, the Stage 24 tables) and must be rolled
back to the previous release (Stage 23). Restore point: the dump
`backup.sh` wrote before those migrations existed (56 migrations).

```
== rollback rehearsal 2026-09-05T19:51:13Z: restore point = jobpilot-20260905T193945Z.dump (56 migrations)
checksum verified
restore completed
role membership granted to the restoring login
tenant path: tenant-path-ok:0
sensitive path: sensitive-path-ok:0
migrations applied: 56, pending or failed: 0
tables with forced row-level security: 157
User             1 rows · Organization 214 rows · AuditLog 219 rows · ConsentRecord 2 rows
== migrate status from the NEW code against the rolled-back database
Following migrations have not yet been applied:
  20260905220000_operations
  20260905220100_rls_operations
== the PREVIOUS application version serves the rolled-back database (its tenant path)
tests/tenancy-isolation.test.ts + tests/sessions.test.ts, from the Stage 23 checkout, TENANCY_TEST_DATABASE_URL=<rolled back>: 17 / 17 pass
```

What this proves: the restore point is usable, the new code sees exactly
the two migrations as pending (so a re-deploy forward is one command), and
the previous application version's tenant path works on the rolled-back
database. What it does not prove: timing at production size; the
provider's PITR as the restore point; the platform's own redeploy switch.
Those are rehearsed on the first staging environment (R-34).

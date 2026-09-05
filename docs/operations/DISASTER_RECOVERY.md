# Disaster recovery — objectives and procedure (Stage 23, ADR-0037)

**Status:** PROPOSED objectives and a written procedure; the local restore
is REHEARSED (`BACKUP_RESTORE.md`); a full recovery against the managed
provider has **NOT been rehearsed** and the objectives are **not yet
founder-approved**. Readiness gate G4 "DR plan with RPO/RTO: documented +
rehearsed" is therefore PARTIAL: documented, rehearsed locally, not
rehearsed on the provider.

## Objectives (proposed)

| Tier | What | RPO (data loss) | RTO (time to serve) | Basis |
| --- | --- | --- | --- | --- |
| 1 | Operational database (Prisma, incl. the `sensitive` schema) | 5 minutes with provider PITR; 24 hours from the last logical dump | 4 hours | A founder-stage product with no on-call rota; a longer RTO is honest. |
| 2 | Object storage (documents, exports, warehouse CSVs) | 0 for versioned objects (provider versioning) | 4 hours | Regional bucket, versioning on. |
| 3 | CMS database (Payload) | 24 hours | 8 hours | Marketing content; rebuildable from the repository's seed. |
| 4 | Application (stateless) | n/a | 1 hour | Redeploy from the pinned commit. |

Nothing above is a promise to a customer until the founder approves it and
Stage 24 has rehearsed it on the provider.

## Scenarios and the response

1. **Database instance loss (region intact).** Restore from provider PITR
   to a new instance at the latest consistent point → run
   `npm run db:migrate:status` (must be clean) → repoint `DATABASE_URL` /
   `DIRECT_URL` (secrets manager, never a file) → `GET /api/health` must be
   `ok` or `degraded` (never `unavailable`) AND the tenant path must work
   (the restore script proves it; the health check runs on the system
   client and would not notice missing grants - review H2) → re-run the
   erasures completed after the restore point (`npm run retention:sweep`
   does this: `unfinishedErasures()` finds every completed request whose
   person is not `anonymizedAt` and re-executes it - built in the Stage 23
   review, M4; tested) → run `npm run analytics:rollup`
   so the marts say a fresh "as of". Announce per `INCIDENT_RESPONSE.md`.
2. **Provider PITR unavailable.** Same, from the newest `db:backup` dump
   with `npm run db:restore`; the RPO is then the age of that dump (up to
   24 h), which the announcement must state.
3. **Regional outage.** The residency decision (ADR-0015) pins personal
   data to Canada; a cross-region failover is NOT designed. The response is
   to wait for the region, with the status page saying so; a second Canadian
   region is a Stage 24 decision with a cost.
4. **Object storage loss.** Restore from provider versioning; a document
   version whose object is missing is refused on read (hash verification,
   Stage 09) rather than served wrong, and the affected people are told
   which documents to re-upload.
5. **Corrupt deploy.** Roll back to the previous pinned commit; migrations
   are forward-only (`DATABASE_MIGRATIONS.md`), so a rollback that needs a
   schema reversal is a restore, not a redeploy.
6. **Secret compromise.** Rotate in the secrets manager; `AUTH_SECRET`
   rotation signs every session out (accepted); `MAILBOX_ENCRYPTION_KEY`
   and `SSO_ENCRYPTION_KEY` rotation re-encrypts through the key-version
   column each secret carries; revoke every API key of the affected
   organisation.

## Rehearsal record

| Date | Scenario | Where | Outcome |
| --- | --- | --- | --- |
| 2026-09-05 | 2 (logical dump → fresh database) | local PostgreSQL 16 | PASS — `BACKUP_RESTORE.md` (second run, after review H2: grants kept, tenant path proven, tenancy suite green on the restored copy) |
| — | 1 (provider PITR) | managed provider | NOT REHEARSED |
| — | 5 (rollback) | staging | NOT REHEARSED (Stage 24) |

## Open decisions for the founder

- Approve the RPO/RTO table, or change it.
- Whether a second Canadian region is worth its cost before public go-live.
- Who is reachable outside working hours (the RTO assumes someone is).

# Runbooks (Stage 24, ADR-0038)

Every operator procedure this platform has, in one place, with what is
rehearsed and what is not. A runbook that has never been exercised says
so at its top; this index does not upgrade it.

| Runbook | Covers | Rehearsed? |
| --- | --- | --- |
| [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) | configuration, the deploy sequence (`env:check` → migrate → deploy → `smoke`), the worker, the pre-launch checklist | locally (build, start, smoke); never on a production host |
| [`DATABASE_MIGRATIONS.md`](DATABASE_MIGRATIONS.md) | the migration history, review standard, recovery | applied to an empty database on every CI run; staging NOT rehearsed (R-34) |
| [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) | `db:backup`, `db:restore`, the rehearsal log | local PostgreSQL 16, 2026-09-05; provider PITR NOT VERIFIED |
| [`ROLLBACK.md`](ROLLBACK.md) | rolling the application back; rolling a migration back by restore; the rehearsal log | local, 2026-09-05 (scenario: a migration applied, then rolled back by restore, then the previous application version served against it) |
| [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) | RPO/RTO per tier, six scenarios | scenario 2 locally; the rest NOT REHEARSED |
| [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) | severities, first fifteen minutes, privacy breach assessment, review | never exercised |
| [`SLOS.md`](SLOS.md) | objectives, alert rules, the status-page decision | no monitor connected |
| [`BREAK_GLASS.md`](BREAK_GLASS.md) | direct production access, audited | never used |
| [`SUPPORT.md`](SUPPORT.md) | tiers, rules, escalation | no customer yet |
| [`PERFORMANCE_BUDGETS.md`](PERFORMANCE_BUDGETS.md) | budgets, `perf:load`, `perf:rollup` | local only |
| [`../governance/DATA_RETENTION_MATRIX.md`](../governance/DATA_RETENTION_MATRIX.md) | what expires when; `retention:sweep` | tested against the database; never run on production |

## The operator's commands

| Command | What | Runs on |
| --- | --- | --- |
| `npm run env:check` | validates the production configuration WITHOUT printing a value | before every deploy |
| `npm run db:migrate:deploy` | applies the versioned history (`DIRECT_URL`) | the deploy step, after a backup |
| `npm run smoke -- <origin>` | the production smoke suite against a deployed origin | after every deploy |
| `npm run worker` | the scheduler: freshness, rollups, retention, case retention, on leased runs | one long-running process per deployment |
| `npm run db:backup -- <dir>` | logical backup with checksum | daily, and before every migration |
| `npm run db:restore -- <dump>` | restore into an EMPTY target and prove it | recovery and the quarterly rehearsal |
| `npm run retention:sweep` · `analytics:rollup` · `jobs:freshness` · `cases:retention` | the sweeps the worker schedules, by hand | when the worker is down or a freshness line asks |
| `npm run ops:break-glass` | records a direct-access session | before and after any direct production session |
| `npm run perf:load` · `perf:rollup` · `a11y` | measurements | after a deploy (perf); every CI run (a11y) |

## Contacts

`INCIDENT_RESPONSE.md` §Contacts is the one table; it is empty until the
founder fills it in.

# Service level objectives, alert rules and the status page (Stage 24, ADR-0038)

**Status:** objectives PROPOSED (the founder approves or changes them);
alert rules DEFINED as data below and consumable by any monitor that can
poll an HTTP endpoint; **no monitor is connected, no alert has ever
fired, and nobody is on call.** The readiness gate G4 rows "Monitoring &
alerting" and "SLOs" move from FAIL to PARTIAL on the strength of this
document and the signals the application now exposes - not to PASS.

## What the application exposes for a monitor

| Signal | Where | Meaning |
| --- | --- | --- |
| `status` | `GET /api/health` (public, 60/min per address) | `ok` (serving, nothing operational off), `degraded` (serving; a check below is off), `unavailable` (HTTP 503; the database or the migration history is not there) |
| `checks.database.ok` | same | `SELECT 1` succeeded |
| `checks.migrations.ok` | same | no migration pending or failed |
| `checks.cache.detail` | same | `local` (in-process) or `shared` (Redis) |
| `checks.storage.ok` | same | the object-storage provider constructed (credentials and region present) |
| `checks.jobSources.ok` | same | at least one job source is enabled |
| `checks.marts.ok` | same | every mart is inside its refresh SLA (`MART_REGISTRY`) |
| `checks.worker.ok` | same | every scheduled job has succeeded inside twice its interval (Stage 24); `detail` is `current`, `overdue` or `never ran` - never a name or a count |
| `checks.rateLimitStore.detail` | same | `local` (per instance) or `shared` (the PostgreSQL store) |
| Response headers | every route | the security header list (`security-headers.mjs`) plus the per-request `script-src` nonce policy |
| `npm run smoke` | operator, after a deploy | the production smoke suite (below) |

Nothing in the health body names a host, a version, a count of people or
an error message. A monitor that needs more than a boolean per check is a
Stage 24+ item with a cost (an APM agent) and is not installed.

## Objectives (proposed, per calendar month)

| SLO | Target | Measured by | Why this number |
| --- | --- | --- | --- |
| Availability of the web application | 99.5 % (≈ 3 h 39 min of downtime per month) | the monitor's `/api/health` probe from one region every 60 s; a minute counts as down when the probe returns 503 or does not answer in 10 s | A founder-stage product on one instance and one managed database with no on-call rota. 99.9 % is a promise nobody can keep without someone reachable at 03:00. |
| Latency of the candidate pages | p95 under 1.5 s at the origin (`PERFORMANCE_BUDGETS.md`) | the same budgets measured on the deployed origin by `npm run perf:load` after each deploy | The local measurement is within budget; production is NOT measured until the first deploy. |
| Freshness of every dashboard | every mart inside its SLA (`MART_REGISTRY`: 26 h for daily marts) | `checks.marts.ok` | A stale dashboard says so (Stage 21); the SLO is that it rarely has to. |
| Scheduled work | every job succeeds inside twice its interval | `checks.worker.ok` | The worker (Stage 24) runs freshness, rollups and retention on a lease; one missed run is tolerated, two are an alert. |
| Erasure | every due erasure executed within 24 h of its due date | `retention.swept` audit rows carry `erasuresDue` and `erasuresExecuted` | A statutory expectation, not a preference. |
| Backups | one successful logical backup per day, restore rehearsed quarterly | the backup job's exit status and `BACKUP_RESTORE.md`'s record | The RPO in `DISASTER_RECOVERY.md` depends on it. |

Error budget: 0.5 % per month. When it is spent, feature deploys stop
until the post-incident review (`INCIDENT_RESPONSE.md`) has named the
cause.

## Alert rules (data for whatever monitor is chosen)

Severity follows `INCIDENT_RESPONSE.md`. "Page" means wake the on-call
person, who does not yet exist; until one does, every rule below lands in
the founder's inbox and the SLO above is unenforced - stated.

| Id | Condition | For | Severity | First action |
| --- | --- | --- | --- | --- |
| A1 | `/api/health` returns 503 or does not answer | 3 consecutive minutes | Sev 1 - page | `INCIDENT_RESPONSE.md` first fifteen minutes; scenario 1 or 2 of `DISASTER_RECOVERY.md` if the database is gone |
| A2 | `checks.migrations.ok` is false | 1 minute | Sev 1 - page | a deploy applied a migration that failed half-way; `DATABASE_MIGRATIONS.md` recovery |
| A3 | `status` is `degraded` | 60 minutes | Sev 3 - ticket | read the failing check; a stale mart means the worker did not run (A4) |
| A4 | `checks.worker.ok` is false | 30 minutes | Sev 2 - notify | the worker process is down or a job is failing; `WorkerRun` rows carry the error; restart the worker |
| A5 | `checks.storage.ok` is false | 5 minutes | Sev 2 - notify | credentials rotated without the deployment following; documents are refused, never served wrong |
| A6 | HTTP 5xx rate over 1 % of requests | 5 minutes | Sev 2 - notify | the platform's request log; every unhandled error is logged redacted with its request id |
| A7 | p95 latency over twice the route's budget at the origin | 15 minutes | Sev 3 - ticket | `PERFORMANCE_BUDGETS.md`; the database is the usual suspect |
| A8 | the daily backup job did not succeed | 26 hours | Sev 2 - notify | run `npm run db:backup` by hand; the RPO is now the age of the last dump |
| A9 | `retention.swept` audit row absent | 48 hours | Sev 2 - notify | the worker's retention job is not running; erasures are falling due |
| A10 | a log line matches a credential shape (`src/lib/log.ts` patterns) | immediately | Sev 2 - notify | a redaction gap; rotate what leaked, fix the pattern |
| A11 | certificate expiry within 14 days | daily | Sev 3 - ticket | the platform or CDN renews; verify |

The rules are deliberately expressed against `/api/health` and the
platform's own request log so that any of the common hosted monitors can
implement them without an agent in the application.

## Status page

There is none. The decision recorded here: a hosted status page (the
usual providers offer one free tier) fed by the A1 probe, at a subdomain
the founder chooses, updated by hand during a Sev 1 or Sev 2 per
`INCIDENT_RESPONSE.md`'s communication rule. The health endpoint is not
a status page: it says nothing about a partial outage a person would
want explained.

## What is NOT true yet, stated

- No monitor polls anything. The rules above have never fired.
- Nobody is on call; the RTO in `DISASTER_RECOVERY.md` assumes someone is.
- Production latency has never been measured (`PERFORMANCE_BUDGETS.md`).
- The error budget is a rule with no enforcement.

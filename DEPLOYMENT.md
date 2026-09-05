# Deploying JobPilot AI

**Status of this page (Stage 24, ADR-0038):** the procedure below is what
the code supports and what was rehearsed on a local build. **No production
environment exists**; nothing here has run on a production host, and the
managed staging project is not reachable from the build environment
(`CLAUDE.md` item 8). The readiness gates (`docs/programme/PRODUCTION_READINESS_GATES.md`)
say which rows are proven and which are not. Every operator procedure is
indexed in `docs/operations/RUNBOOKS.md`.

The app runs locally with no third-party accounts: every provider falls
back to a mock. Going to production means a PostgreSQL database with the
migration history applied, an object store in Canada, two generated
secrets, one long-running worker process, and a monitor polling
`/api/health`.

## 0. The deploy sequence

Every deploy, in this order, and nothing skipped:

```bash
npm run env:check                       # 1. the configuration is production-shaped (prints no value)
npm run db:backup -- <backup dir>       # 2. a restore point BEFORE the schema moves
npm run db:migrate:deploy               # 3. the versioned history, against DIRECT_URL, as a SEPARATE gated step
npm run db:migrate:status               # 4. nothing pending or failed
# 5. roll the application (blue/green or canary on the host; the previous version stays deployable)
npm run smoke -- https://<origin>       # 6. the production smoke suite against the new version
# 7. restart the worker on the new version (npm run worker)
# 8. watch /api/health and the request log for fifteen minutes (SLOS.md A1-A6)
```

A failing step stops the deploy. Rolling back is `docs/operations/ROLLBACK.md`:
the application rolls back by redeploying the previous commit; a schema that
must be reversed is a restore from the step-2 backup, never a hand-written
down migration.

Migrations are **never applied at boot** and never by `db:push`
(`docs/operations/DATABASE_MIGRATIONS.md`).

## 1. Database — required

The transactional store is **PostgreSQL 16 only** (ADR-0002). Two
connection strings:

| Variable | Used by | On the managed provider |
| --- | --- | --- |
| `DATABASE_URL` | the application at runtime | the **transaction-mode pooler** (port 6543, `?pgbouncer=true`) |
| `DIRECT_URL` | `prisma migrate`, backups, a break-glass session (the worker runs on `DATABASE_URL` like the app; its leases are rows, never a session lock) | the session-mode endpoint (port 5432) |

**Both must authenticate as the same database role** (the RLS migration
binds the system policy to the role that ran it; a different application
role sees nothing). A password with URL-reserved characters is
percent-encoded for you (`src/lib/db-url.ts`, `scripts/db/with-encoded-env.mjs`).
`npm run env:check` verifies the shape of both (pooler vs session, same
role, same host) **without printing either** - they are confidential and
never appear in a log, an evidence document or a chat.

```bash
DIRECT_URL="..." npm run db:migrate:deploy   # apply the history
DIRECT_URL="..." npm run db:migrate:check    # fail on drift
DATABASE_URL="..." npm run db:seed           # the three plans (+ the demo account: NOT on production)
```

The seed creates the Starter / Professional / Executive plan rows AND the
demo account (`demo@jobpilot.ai`, a published password, `admin` role).
**Do not run the seed as-is against production**: create the plans through
it on a copy and load them, or set the plans by hand, and never let the
demo account exist where `STAFF_EMAILS` could name it.

The CMS keeps its **own** database (`PAYLOAD_DATABASE_URI`, a separate
logical database on the same instance, never the same one; §4).

## 2. Object storage — required

`STORAGE_PROVIDER=s3` with `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`
(`ca-central-1` or `ca-west-1`; anything else is refused at start,
ADR-0015), `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`,
`STORAGE_S3_SECRET_ACCESS_KEY`. Bucket versioning on; private; the
application serves every file through a signed ten-minute link (Stage 09).
`local` (the default) writes under `STORAGE_ROOT` and is for a host with a
persistent disk only; `env:check` warns when production runs on it.

## 3. Secrets — required

| Variable | What | Rule |
| --- | --- | --- |
| `AUTH_SECRET` | signs session cookies | `openssl rand -base64 32`; the `.env.example` value is refused by value at server start |
| `PAYLOAD_SECRET` | signs CMS editor sessions | a different generated value; the two must never be equal |
| `MAILBOX_ENCRYPTION_KEY` | OAuth tokens at rest (Stage 11) | 32 random bytes; only if mailbox connections are offered |
| `SSO_ENCRYPTION_KEY` | SSO client secrets at rest (Stage 20) | 32 random bytes, distinct from the mailbox key |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | payments | only when `PAYMENT_PROVIDER=stripe`; never validated from this codebase |
| `DATABASE_URL`, `DIRECT_URL` | above | never printed |

They live in the host's secrets manager and reach the process as
environment variables. Nothing is read from a file in the repository;
`tests/hardening-static.test.ts` fails the build if a secret-shaped string
or a `.env` is ever tracked. Rotation: `AUTH_SECRET` signs everyone out
(accepted); the encryption keys carry a key version so re-encryption is a
sweep; `DISASTER_RECOVERY.md` scenario 6.

## 4. The application, the CMS, the worker

**One deployable** serves the web app, the API and the CMS (`/admin`,
`/api/cms`). Build with `npm run build`, run with `npm run start` behind
TLS; `NEXT_PUBLIC_APP_URL` is the real origin (every signed link and
checkout return is built from it, never from the request's `Host`);
`TRUSTED_PROXY_HOPS` is how many proxies append to `X-Forwarded-For`
(default 1). `STAFF_EMAILS` names the staff allow-list; unset, the console
denies everyone.

**The worker** is the same codebase started as `npm run worker`
(`scripts/ops/worker.ts`): one long-running process that runs job-source
freshness (every 6 h), the analytics rollups (daily), the retention sweep
and due erasures (daily) and case retention (daily) on **leased runs**
(`WorkerRun` rows: a second worker, or a restart, can never run the same
window twice). One is enough; a second worker is not idle - the two share
the windows between them, and each marks the other's run abandoned if it
outlives its job's timeout. Every job is bounded by its timeout; a job
that overruns it is recorded `failed: timed out` and its late result is
discarded. Daily windows start at 00:00 UTC (20:00 Eastern the evening
before). `/api/health` reports `checks.worker` and `SLOS.md` A4 fires when
a job is overdue. There is no queue and no dead-letter queue; **a failed
window is not retried until the NEXT window** (six to twenty-four hours)
or the operator's command - a failed row holds the lease. Every due
erasure executes on the worker's first daily tick after its date, without
an operator watching (`DATA_RETENTION_MATRIX.md`).

**Rate limiting and cache across instances.** One instance needs nothing.
Before a second instance: `RATE_LIMIT_STORE=postgres` (the shared counter
table, Stage 24) so the limits are per platform and not per instance
(R-16), and `REDIS_URL` with `ioredis` installed for the shared cache
(optional; the in-memory cache is correct but not shared).

**Response headers** are `security-headers.mjs` on every route plus a
per-request `script-src` nonce policy set by the edge gate
(`src/proxy.ts`); the Playwright run asserts no CSP violation on any
rendered page.

## 5. Providers

| Variable | Effect | Validated live? |
| --- | --- | --- |
| `JOB_PROVIDER` | names a `JobSource` register row; the source must also be ENABLED at `/console/sources` with its policy record complete | Adzuna: NO (registered disabled) |
| `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | reaches the gateway; a task is served by a model only once a `PromptVersion` is promoted after an evaluation (`/console/prompts`) | NO |
| `PAYMENT_PROVIDER=stripe` + keys + `STRIPE_PRICE_MAP` | checkout and the webhook at `POST /api/webhooks/stripe` | NO |
| `MAILBOX_CONNECTOR` | Google/Microsoft metadata-scope connectors need their OAuth client ids and secrets; `mock` is refused in production | NO |

`docs/governance/INTEGRATION_REGISTER.md` is the truth for every one of
these; each is IMPLEMENTED-NOT-VALIDATED until a live run is recorded there.

**Apply mode.** `APPLY_MODE` is `mock`, `auto` or `assisted`; preparation
never submits under any of them (ADR-0026); `auto` permits the applicant's
own instructed submission through an employer-authorised ATS credential
and behaves as `assisted` without one. There is no autonomous submission
(ADR-0016, Stage 22 gate).

## 6. Monitoring, on-call, status page

`docs/operations/SLOS.md`: the signals `/api/health` exposes, the proposed
objectives, eleven alert rules a hosted monitor can implement, and the
status-page decision. **None is connected; nobody is on call.**

## 7. Pre-launch checklist

- [ ] `npm run env:check` passes on the production configuration
- [ ] `DATABASE_URL` (pooler) and `DIRECT_URL` (session) set, same role; `npm run db:migrate:deploy` and `db:migrate:status` clean
- [ ] Plans loaded; the demo account does NOT exist; `STAFF_EMAILS` names real staff only
- [ ] `AUTH_SECRET` and `PAYLOAD_SECRET` generated and distinct; the encryption keys generated if their features are on
- [ ] `NEXT_PUBLIC_APP_URL` is the real HTTPS origin; `TRUSTED_PROXY_HOPS` matches the host
- [ ] `STORAGE_PROVIDER=s3` in a Canadian region with versioning
- [ ] `PAYLOAD_DATABASE_URI` is a separate PostgreSQL database; first CMS editor created at `/admin`
- [ ] The worker is running; `/api/health` says `ok` or names why it is `degraded`
- [ ] A monitor polls `/api/health` with at least rules A1, A2 and A4; someone receives them
- [ ] `npm run db:backup` scheduled daily; a restore rehearsed on the provider (NOT yet)
- [ ] `npm run smoke -- <origin>` passes
- [ ] The consent wording for every purpose is counsel's (L-5); the `-draft` versions are refused in production
- [ ] The founder has read `docs/programme/RELEASE_VERDICT.md` and the external actions it lists

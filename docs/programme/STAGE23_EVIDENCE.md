# Stage 23 - Security, performance, accessibility and operational hardening - evidence

Recorded 2026-09-05 on branch `claude/stage-23-hardening` (PR #35, stacked
on Stage 22 (PR #34) - 21 (#33) - 20 (#32) - 19 (#31) - 18 (#30) - 17 (#29) -
16 (#28) - 15 (#27) - 14 (#26) - 13 (#25) - 12 (#24) - 11 (#23) - 10 (#22) -
09 (#21) - 08 (#20) - 07 (#19) - 06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) -
02 (#14) - 01 (#13, PARTIAL)). Every line was run or read; nothing is PASS
on the strength of a mock, a skipped test or a document. This stage's
honest centre: **every readiness-gate row that said NOT VERIFIED or FAIL
for want of evidence now has a measurement, a rehearsal, or a plain
statement that it cannot be measured from here** - and several of the
measurements found real defects that are now fixed. Decision record:
ADR-0037.

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 23: the §20 audit with evidence per item;
WCAG 2.2 AA; performance budgets and load testing; backup/restore
rehearsal; DR with RPO/RTO; incident response; third-party penetration
test; data deletion and retention enforcement end to end.
`PRODUCTION_READINESS_GATES.md` is the codified checklist and was
re-measured row by row.

## 2. Security controls added - `PASS`

- **Response headers** (`security-headers.mjs`, `next.config.mjs`): CSP
  `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
  HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`,
  COOP, DNS-prefetch off, on every route. Verified live:
  `curl -D - /login` shows the three named headers. No `script-src`, stated
  (nonce policy is Stage 24). `tests/hardening-static.test.ts` reads the
  same list the config ships.
- **CSRF** (`src/proxy.ts` `isCrossSiteWrite`): a state-changing request
  with the session cookie is refused when `Sec-Fetch-Site` is cross-site or
  `Origin` names another host; bearer prefixes exempt; the check precedes
  the public-path decision. Eleven pure cases in the static test.
- **Health check** (`/api/health`): public, 60/min per address, booleans and
  fixed words only, `503` only when unable to serve. Live answer on the
  test database: `degraded` (3 of 7 marts stale - correct, no sweep had
  run), `200`. The database test proves no host or URL leaks.
- **Log redaction** (`src/lib/log.ts`): connection-string credentials,
  bearer/basic, JWTs, Stripe/AWS/Anthropic/GitHub/Slack/Google key shapes,
  our `jp_` keys, addresses and phone numbers; `route()` logs the redacted
  shape. Eleven redaction cases; a static assertion that the error object
  is never logged.
- **Secret hygiene**: a static test walks every tracked file for
  secret-shaped values (documented AWS example keys and the one deliberate
  redaction fixture allow-listed by name), refuses a tracked `.env`, and
  checks `.env.example` holds placeholders only. Result: clean.
- **SBOM**: `npm sbom --sbom-format cyclonedx --omit dev` produces 486
  components locally; the CI `sbom` job uploads it on every run.

## 3. Erasure and retention, end to end - `PASS`

- `src/lib/privacy/erasure.ts` and `retention.ts`; `/api/account/erasure`;
  the Settings control; `npm run retention:sweep`. Design in ADR-0037 §5-6.
- `tests/privacy.test.ts` (5 tests, database): a request schedules fourteen
  days out, is idempotent, is cancellable, refuses to run early; a live
  subscription blocks it; execution deletes the person's tables across
  fourteen models, removes the submitted résumé file and the folder,
  scrubs the user, the case, the representation, the support ticket and
  the workspace, keeps the invoice, the payment, the consent record and
  the placement pointing at the scrubbed row, audits with counts only,
  leaves another person untouched, and refuses to run twice; the sweep
  removes an expired session, a two-year-old AI run, a year-old rollup run
  and a 2020 mart row and keeps the recent ones, a consent record and an
  invoice, and audits itself.
- `DATA_RETENTION_MATRIX.md` now states enforcement per row; three rows
  (employer pipelines, staffing records, CMS) are NOT AUTOMATED and say so.
- The Stage 20 review's open item ("retention/erasure review across Stages
  17-19") is closed by this: a client's, a represented candidate's and a
  placed candidate's identity are scrubbed on those records; the records
  themselves are the organisation's, under its retention.

## 4. Accessibility - `PASS` (42 rendered pages, axe WCAG 2.0/2.1/2.2 A+AA, light theme)

`npm run a11y` (`a11y/`, Playwright + axe-core 4.13, Chromium) against the
built application on the seeded test database, one stored session:

| Run | Result | What it found |
| --- | --- | --- |
| 1 | 2 / 42 pages passed | `color-contrast` on 13 pages (tokens `--faint` 3.7:1, `--brand-500` 4.47:1 with white text, `--success` 4.1:1); `aria-valid-attr-value` (a combobox naming an unrendered listbox); 27 pages failed to sign in - the per-account rate limit, correct |
| 2 | 21 / 42 | after the token fixes and one stored session: no `<main>` on `/`, `/login`, `/signup`; `aria-allowed-attr` (the combobox lacked its role); an unlabelled disabled radio and 13 px checkboxes on Settings; `--warn` 2.6:1 on every console page; an inline link indistinguishable from its text |
| 3 | 32 / 42 | eleven console pages rendered the access-denied view for a support-rank account, whose own `<main>` nested inside the shell's |
| 4 | 41 / 42 | unlabelled audit filters; underline-less external links on the taxonomy page |
| 5 | **42 / 42** | - |

Fixes: `--faint` 107 101 95 (5.7:1), `--brand-500` 11 102 207 (5.5:1),
`--success` 18 120 77 (5.5:1), `--warn` 133 88 0 (6.2:1); `role="combobox"`
with `aria-controls` only while the list is rendered; `<main>` on the
landing and auth pages; the access-denied view is a `section`; labels on
the audit filters and the disabled auto-apply radio; 24 px checkboxes;
underlined inline links. The CI `accessibility` job repeats the run on
every push. NOT covered: the dark theme's contrast, interactions axe
cannot drive, reading order, the mobile app.

## 5. Performance - measured LOCALLY, within budget

`npm run perf:load` (concurrency 8, 8 s per route, local build on the
build machine, local PostgreSQL; `PERFORMANCE_BUDGETS.md`):

| Route | req | err | 429 | rps | p50 ms | p95 ms | p99 ms | budget p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/health` | 4232 | 0 | 4172 | 529 | 12 | 28 | 37 | 300 |
| `/` | 857 | 0 | 0 | 107 | 75 | 87 | 104 | 500 |
| `/login` | 1656 | 0 | 0 | 207 | 38 | 48 | 53 | 500 |
| `/dashboard` | 592 | 0 | 0 | 74 | 108 | 127 | 136 | 1500 |
| `/dashboard/jobs` | 749 | 0 | 0 | 94 | 85 | 103 | 117 | 1500 |
| `/dashboard/applications` | 807 | 0 | 0 | 101 | 79 | 91 | 97 | 1500 |
| `/dashboard/analytics` | 339 | 0 | 0 | 42 | 188 | 215 | 263 | 1500 |
| `/api/agents` | 2127 | 0 | 0 | 266 | 30 | 37 | 42 | 500 |
| `/api/account/erasure` | 2860 | 0 | 0 | 358 | 22 | 29 | 34 | 300 |
| `/console` | 495 | 0 | 0 | 62 | 130 | 153 | 175 | 2000 |
| `/console/revenue` | 360 | 0 | 0 | 45 | 177 | 203 | 286 | 2000 |

The health check's 429s are its rate limit doing its job - and, as the
review noted (L8), its latency row above is the latency of those 429s
(4172 of 4232 answers), i.e. the limiter's, not the check's. The script
now keeps a 429 out of the percentiles; the health row is RE-MEASURED at
Stage 24 with the corrected script and the memoised route. `npm run
perf:rollup` (20 000 submissions, 60 000 events, one organisation, 90
days, local database): `rollupOrganizations` read 58 446 rows and wrote
806 mart rows in 1.17 s (50 127 source rows/s; budget 60 s);
`exportMarts` wrote 90 files, 806 rows, 61 KiB in 0.12 s. This closes the
Stage 21 "throughput NOT VERIFIED" note for the local database only;
**production is NOT measured**, and per-route bundle weight is NOT
MEASURED (Next 16's build prints no size table).

## 6. Backup, restore, recovery, incidents - `PASS` (local) / `NOT VERIFIED` (provider)

- `npm run db:backup` / `db:restore` rehearsed TWICE: the first run
  verified 56 migrations, 157 forced tables, identical counts, no drift
  and a checksum - and, the review found (H2), had dropped every grant, so
  the tenant path could read nothing on the restored copy while every
  check passed. The second run keeps privileges, grants role membership,
  proves the tenant and sensitive paths in the script, and then runs the
  tenancy, organisation and session suites against the restored database
  (31/31). Full log in `BACKUP_RESTORE.md`.
- `DISASTER_RECOVERY.md`: proposed RPO/RTO per tier, six scenarios with the
  response, the rehearsal record (local PASS; provider PITR and rollback
  NOT REHEARSED), founder decisions listed.
- `INCIDENT_RESPONSE.md`: severities, first fifteen minutes, diagnosis
  rules, privacy-breach assessment, post-incident review; contacts to fill
  at Stage 24.

## 7. Gates

| Gate | Result |
| --- | --- |
| `npm run lint:ci` | 0 errors, 8 warnings (baseline 8) |
| `npx tsc --noEmit` | 0 errors |
| `npm test` (CI=true, both URLs on a fresh `jobpilot_test23`, 56 migrations) | 1302 / 1302, 0 skipped (25 new: 17 static, 7 database, 1 storage) - after the review |
| `npm run build` | exit 0 (worktree with its own dependencies) |
| `npm run a11y` | 42 / 42 pages |
| `npm run perf:load` | 11 / 11 routes within budget, 0 errors |
| Migration rehearsal | unchanged history (56); drift clean on the restored copy |

A note on the local full-suite run: the Digital Twin backfill test counts
users with résumés and no profile, so it fails on a database that has been
seeded with the demo account; the run above used a fresh database, as CI
does. The accessibility job seeds its own database.

## 8. The readiness gates, re-measured

`PRODUCTION_READINESS_GATES.md` was rewritten row by row with the current
evidence. Summary of movement in this stage: CSRF PARTIAL → PASS; log PII
redaction NOT VERIFIED → PASS; erasure PARTIAL → PASS; retention
enforcement FAIL → PARTIAL (three rows not automated, stated); health
checks FAIL → PARTIAL (app, database, cache, storage, connectors; no queue
exists); backups FAIL → PARTIAL (logical, rehearsed; provider PITR not
verified); restore rehearsal FAIL → PASS (local); DR plan FAIL → PARTIAL
(documented, rehearsed locally); accessibility NOT VERIFIED → PASS (light
theme, axe); dependency provenance NOT VERIFIED → PASS (SBOM); penetration
test NOT VERIFIED → NOT VERIFIED (external action recorded).

## 9. What is NOT done, stated

- **Third-party penetration test**: an external action for the founder
  (`AUTONOMOUS_STATUS.json` `external_actions` PEN-TEST); no self-assessment
  substitutes for it.
- A nonce-based `script-src`; a shared rate-limit store (single instance,
  R-16); monitoring, alerting, on-call, SLOs, a status page (Stage 24).
- Provider PITR rehearsal and production-scale restore timing.
- Production performance, Core Web Vitals, bundle weight.
- Dark-theme contrast and interaction-level accessibility; the mobile app.
- Retention automation for employer pipelines and staffing records
  (contract terms).
- Staging rehearsal (R-34).

## 10. Independent review

An independent adversarial review of `766ee35..HEAD` (read-only, the same
brief as Stages 19-21) returned 3 HIGH, 7 MEDIUM, 11 LOW and 5 INFO
findings. Every HIGH and MEDIUM is fixed; every LOW is fixed or stated;
the INFO items are recorded in ADR-0037. Two findings were false PASSes in
this stage's own evidence (H2, and the "hash-chained" audit claim under
INFO/H3), which is what an independent review is for.

| Id | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| H1 | HIGH | The Settings erasure control read `.data` from a bare payload, so a scheduled erasure never showed and could not be cancelled from the UI | Fixed: reads the payload; the copy now also states the payment provider's record is not reached |
| H2 | HIGH | `backup.sh --no-privileges` dropped the RLS grants; the restored database passed every rehearsal check and could serve nothing to the tenant path | Fixed: privileges kept; `restore.sh` grants role membership and proves the tenant and sensitive paths; re-rehearsed, tenancy suite green on the restored copy; gate row reworded |
| H3 | HIGH | Erasure missed `ApplicationQuestion`, `SupportMessage`, `Referral` (referee), `WebhookEndpoint`, `OutboundEvent`, `ApiIdempotencyRecord`, the person's own `AuditLog` actor identity, and an orphan submitted version's object | Fixed: deleted or scrubbed, each seeded and asserted in `privacy.test.ts`; the orphan's object is kept and counted; the matrix lists the new rows; the audit hash-chain claim corrected (columns unwired) |
| M1 | MED | A subscription taken out inside the grace period was erased around | Fixed: blockers re-checked at execution (deferred + audited); checkout and a trial refuse while scheduled; tested |
| M2 | MED | Nine server-side sites still logged the raw error; the "every unhandled error" claim was false | Fixed: all through `redactError`; a static scan of every `console.error`/`warn` under `src` refuses a raw argument or `.message` |
| M3 | MED | `/api/health` was an unauthenticated query amplifier with a bypassable per-address limiter, and printed counts and backend names | Fixed: memoised 10 s per instance, a per-instance budget across addresses, fixed words only; tested (memo, 61st request 429) |
| M4 | MED | The DR runbook described a re-execution after restore that did not exist | Fixed: `unfinishedErasures()` + sweep re-execution with `force`; tested by simulating the restore |
| M5 | MED | S3 `deletePrefix` read one listing page | Fixed: continuation-token loop, XML entities decoded; two-page fixture test |
| M6 | MED | `whsec_` not redacted; the "long hex/base64" claim had no pattern | Fixed: both patterns added and tested |
| M7 | MED | The seed re-elevated a public-password account to `admin` on every run, in any environment | Fixed: no demo account in production; role set on creation only |
| L1 | LOW | Cancel could race execution | Fixed: conditional claim inside the transaction; cancel is conditional too |
| L2 | LOW | Number rule redacted invoice and ticket numbers and timestamps | Fixed: phone shapes only; tested |
| L3 | LOW | `redactError` could throw; dropped `cause` | Fixed: never throws; one level of cause; tested |
| L4 | LOW | Unbounded sweep statements; opaque erasure failures | Partly: failures logged with the user id and redacted reason; batching NOT done (stated: first-run lock duration is a Stage 24 operational note) |
| L5 | LOW | Matrix wording vs code (sessions, documents, question bank) | Fixed in the matrix |
| L6 | LOW | Secret-scan host exemption porous | Fixed: only loopback or placeholder hosts/credentials exempt |
| L7 | LOW | CSRF scope: CMS cookie uncovered; `same-site` allowed; forwarded host | Fixed: both cookies; `same-site` refused; `Host` kept deliberately (a forwarded header is client-writable) and stated |
| L8 | LOW | Health perf row measured 429s; throughput script's cleanup and password | Fixed: 429s out of the percentiles (health re-measured at Stage 24); cleanup scoped to the run; production refused; unverifiable hash |
| L9 | LOW | Weak assertions (unscoped audit count; children of `/api/health` asserted public; no 429 branch) | Fixed |
| L10 | LOW | A sole owner's erasure orphaned the organisation | Fixed: blocker at request and execution; tested |
| L11 | LOW | 43 pages was 42 + the setup project | Fixed everywhere |
| INFO | - | `interest-cohort` removed; HSTS/COOP notes; payment-provider PII not reached; `force` has no staff path; `.includes` evades the entitlement regex | Header removed; the rest recorded in ADR-0037 |

After the fixes: lint 0 / 8, typecheck 0, `npm test` 1302 / 1302 on the
fresh database, build exit 0.

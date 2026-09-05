# Stage 21 - Advanced reporting and warehouse readiness - evidence

Recorded 2026-09-05 on branch `claude/stage-21-reporting-warehouse` (PR #33,
stacked on Stage 20 (PR #32) - 19 (#31) - 18 (#30) - 17 (#29) - 16 (#28) - 15
(#27) - 14 (#26) - 13 (#25) - 12 (#24) - 11 (#23) - 10 (#22) - 09 (#21) - 08
(#20) - 07 (#19) - 06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) - 01
(#13, PARTIAL)). Every line was run or read; nothing is PASS on the strength
of a mock, a skipped test or a document. This stage's honest centre: **every
number a staff member or an organisation sees is defined once, read from a
mart a rollup rebuilt, shown with the instant it was rebuilt, and refused
from a transactional table by a test - and the boundary a warehouse would
load is a tested CSV contract. No event stream, no scheduler and no
warehouse exist, and nothing has been measured at production volume.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 21: the founder/platform, financial, AI-cost,
connector-health, employer, staffing, case-outcome and career-transition
metrics defined once; marts with a stated refresh SLA; dashboards that read
marts only; a warehouse extraction boundary. Gap G-25 (the half Stage 13 left
open). Decision record: ADR-0036.

## 2. The dictionary and the registry - `PASS`

- `src/lib/analytics/platform/dictionary.ts`: `PLATFORM_METRIC_DICTIONARY` -
  53 metrics, each with key, product, label, kind, one-sentence definition and
  the mart column it is read from; `MART_REGISTRY` - seven marts with RLS
  scope, `day` partition, every job that writes them and a 26-hour SLA;
  `MIN_ORG_COHORT` = 5.
- `docs/governance/METRIC_DICTIONARY.md` carries a generated platform section
  (marts and SLAs, one table per product, the cuts and the suppression rule).
  `tests/reporting-static.test.ts` fails when a key, a definition, a mart or an
  SLA differs, when a metric sources anything but a registered mart, when a
  mart is not a Prisma model, is classified under RLS other than the registry
  says, is extracted with a column the model lacks, or is written by a job
  the operator sweep does not run.

## 3. The marts and the rollups - `PASS`

- Migrations `20260905210000_reporting_marts` (`OrganizationDailyMart`,
  `SubscriptionCohortMart`, payment outcomes on `DailyRevenueRollup`),
  `20260905210100_rls_reporting_marts` (generated from `STAGE_21_TABLES`:
  `OrganizationDailyMart` `org`, `SubscriptionCohortMart` `system`) and
  `20260905210200_revenue_invoice_count` (`invoicesBilled`,
  `failedPaymentCents` - added when the parity test showed the wide row could
  not answer the live totals' invoice count or the failed amount). Fifty-five
  migrations; applied to an empty database and drift-clean.
- `platform/rollup.ts` (`platform_metrics`): activity metrics attributed to
  their day and zero-filled; snapshot metrics (open and breached tickets,
  overdue invoices and amount, active organisations, live sessions) written
  for the as-of day ONLY; disjoint from the Stage 13 job so neither deletes
  the other's rows.
- `organization/rollup.ts` (`organization_reporting`): loads submissions and
  their events (member actors only), engagements, representations,
  placements, placement invoices, cases, outcomes and follow-ups - ids, kinds,
  dates, cents - folds them with the PURE builders in `organization/marts.ts`
  and replaces the (days x organisation x product) scope. The Stage 17 and 18
  boundary tests allow-list this one file and refuse a note, an assessment, a
  barrier, a disclosure, an interview or an offer from it.
- `finance/cohorts.ts` (`subscription_cohorts`): the retention grid per
  currency stored as rows with the as-of day; `gridFromRows` rebuilds the
  grid the page draws (round-trip proven).
- `rollupAll` runs seven jobs; `npm run analytics:rollup`; every run writes a
  `RollupRun`.

## 4. Every reporting surface reads a mart - `PASS`

- Console overview: `readDailyMetric`, `readLatestSnapshot`,
  `loadRevenueSummaryFromMarts`; the two live reads (failed-payments queue,
  recent signups) moved to `console/queues.ts`, which lists and may not count
  (static test); the overview imports no database client.
- Console revenue: `loadRevenueSummaryFromMarts` and `readCohortGrid`.
- Employer: `reporting()` -> `readEmployerReport`; the page says MEAN days
  (a median is not a mart quantity) and shows the mart's freshness.
- Staffing: `recruiterProductivity()` -> `readStaffingProductivity` (fees
  only for finance and admin, a recruiter's own row otherwise) and
  `readStaffingInvoices`.
- Cases: new `caseloadSummary` (supervisor and admin), `/api/cases/summary`,
  a dashboard card; outcomes withheld under five distinct clients, by kind
  and in total.
- `tests/reporting-static.test.ts` refuses a `count`/`findMany`/`aggregate`/
  `groupBy` on any source table, and an in-memory status count, on twelve
  reporting files.

## 5. Freshness - `PASS`

`src/lib/analytics/freshness.ts`: a mart's as-of is the OLDEST of the latest
succeeded run per job that writes it (null while any never ran); STALE past
the SLA. `MartFreshnessNote` on the employer and cases dashboards,
`describeFreshness` on both console pages; the static test requires it on
every mart page. There is no scheduler: the stale line is the operator's cue.

## 6. The warehouse extraction boundary - `PASS` (boundary) / `NOT ADOPTED` (warehouse)

`src/lib/analytics/warehouse/export.ts`: `MART_COLUMNS` (the contract, each
column checked against the model), `martCsv` (CRLF, RFC 4180 quoting, ISO
dates, formula cells neutralised), `exportMarts` writing
`warehouse/<mart>/<day>.csv` to the Stage 09 storage provider, a day without
rows writing no file, user-scoped marts opt-in (ADR-0015).
`npm run analytics:export`. `docs/architecture/WAREHOUSE_EXTRACTION.md` is the
recipe and states the limits.

## 7. Database proof - `PASS` (`tests/reporting-marts.test.ts`, 10 tests)

Against `jobpilot_test21` (55 migrations): the organisation rollup writes what
the fixture makes true and the employer report reads it on the tenant path
(funnel 2/2/2/1/0/1/1/0, mean days 4/7/17, source cuts, recruiter activity
excluding the candidates' own events); a second run changes nothing and each
run is recorded; a member of another organisation sees only their own rows
under RLS and a cross-organisation read returns nothing; the cohort mart is
invisible on the tenant path; staffing productivity with and without fees,
filtered to one recruiter, and the invoice summary; the caseload summary
withholds three clients' outcomes, shows the total at five and still
withholds a four-client kind; the platform rollup zero-fills 31 days, writes
six snapshot rows on the as-of day only and is idempotent (31 x 11 rows);
the mart revenue summary equals the live computation on totals, revenue
series, movement, opening MRR and subscribers, churn, subscriber series and
payment health (succeeded, failed, pending, rate, per-bucket amounts);
freshness reports the older of two jobs' successes; the extraction writes the
documented CSV per mart per day, none for an empty day, and refuses an
unknown mart; EXPLAIN with sequential scans disabled shows the organisation,
metric and cohort reads on their indexes.

## 8. Gates

| Gate | Result |
| --- | --- |
| `npm run lint:ci` | 0 errors, 7 warnings (baseline 8) |
| `npx tsc --noEmit` | 0 errors |
| `npm test` (CI=true, both URLs on `jobpilot_test21`) | 1276 / 1276, 0 skipped (32 new: 22 static, 10 database) |
| `npm run build` | run in the main tree at the squashed commit (recorded in the status-sync commit) |
| Migration rehearsal | 55 migrations applied to an empty database; `prisma migrate diff --exit-code` clean |

A Stage 20 static assertion (`tests/enterprise-static.test.ts`) was found
failing on PR #32 during this stage's full run: it still expected the
unconditional device-key ceiling that the review fix had made conditional.
Corrected on the Stage 20 branch (commit 4941af5, full gate 1243/1243) and
this branch was rebased onto it.

## 9. What is NOT done, stated

- **No event stream** feeds the marts (ADR-0011): the rollups scan the
  source tables once per sweep.
- **No scheduler**: `npm run analytics:rollup` and `npm run analytics:export`
  are operator commands; every page shows staleness instead.
- **No warehouse** is adopted; no loader has run.
- **Throughput at production volume NOT VERIFIED**: the rollups and the
  extraction have run against fixtures only (a Stage 23 item).
- The revenue mart's `mrr` is the end-of-range event reconstruction, not the
  live subscription table; the plan breakdown and the top failure codes are
  not in the wide row and come back empty.
- The staffing productivity report is API-only (no page renders it), so it
  carries no freshness line of its own; the API answer is read from the
  mart like the rest.
- No industry dimension exists (unchanged from Stage 13).
- Staging rehearsal NOT VERIFIED (R-34).

## 10. Independent review

Pending; recorded in AUTONOMOUS_STATUS.json `stage_21_progress.independent_review`
when processed.

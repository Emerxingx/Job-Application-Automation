# ADR-0036 — Advanced reporting: one platform metric dictionary, marts for every dashboard, published freshness, and the warehouse extraction boundary

**Status:** Accepted (Stage 21, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 21, gap G-25 (the staff and organisation half; Stage 13 / ADR-0027 closed the candidate half) · **Depends on:** ADR-0012 (reporting: no dashboard reads a transactional table), ADR-0027 (the candidate marts and dictionary pattern this generalises), ADR-0005 (RLS: the organisation mart is `org`-scoped), ADR-0015 (residency: per-person marts leave the platform only under it) · **Does not build:** ADR-0011 (an event stream) or a scheduler — both stated below

## Context

ADR-0012 set the rule in Stage 00: reporting reads marts, never the
transactional store, and every metric has exactly one definition. Stage 13
honoured it for the candidate's own dashboards. Everything a staff member or an
organisation saw still came straight from the source tables: the console
overview counted users, payments, tickets and invoices on every render; the
revenue page computed MRR, churn and cohorts live from subscriptions, events,
invoices and payments; the employer report walked submissions and their
events; staffing productivity walked engagements, representations and
placements; a supervisor had no outcome summary at all. Each of those was a
metric defined on a page, each a different way, and each a full scan of a
transactional table on a request path.

The brief for this stage asks for the founder, financial, AI-cost,
connector-health, employer, staffing, case-outcome and career-transition
metrics to be defined once, served from marts with a stated refresh SLA, and
for the boundary to be designed so that a warehouse, when volume justifies
one, is a change of destination rather than a rewrite.

## Decision

1. **One platform metric dictionary.** `src/lib/analytics/platform/dictionary.ts`
   (`PLATFORM_METRIC_DICTIONARY`) defines every non-candidate metric once —
   key, product, label, kind, one-sentence definition and the MART column it
   is read from. `docs/governance/METRIC_DICTIONARY.md` mirrors it and
   `tests/reporting-static.test.ts` fails when a key, a definition, a mart or
   an SLA differs. A metric whose source is a transactional table cannot be
   registered.

2. **A mart registry with scope, jobs and SLA.** `MART_REGISTRY` names the
   seven marts a dashboard may read, the RLS scope each has (`system`, `org`,
   `user`), its `day` partition, EVERY rollup job that writes it and its
   refresh SLA (26 hours). The registry, the Prisma schema, `rls-tables.ts`,
   the extraction column contract and the operator sweep are checked against
   each other by the static test, so one truth cannot drift from the others.

3. **Two new marts, two reused.** `DailyMetric` gains the platform activity
   and snapshot metrics (`rollupPlatform`, job `platform_metrics`; the Stage 13
   job keeps its three). `DailyRevenueRollup` gains payment outcomes, the
   failed-payment amount and the billed-invoice count so payment health and
   totals read the mart. `SubscriptionCohortMart` (system-only) holds the
   retention grid per currency, cohort month and offset, with the as-of day.
   `OrganizationDailyMart` (`org`-scoped under RLS: a member reads only the
   organisations they belong to) holds per-organisation facts by day, product,
   metric, dimension and key — the employer funnel and source cuts, staffing
   productivity by recruiter, invoice counts and amounts, case openings,
   closures, outcomes by kind and follow-ups — with a `people` column carrying
   the distinct clients behind an outcome row.

4. **Replace semantics, one reader, an audit of every run.** Each rollup is
   the ONLY code that reads the transactional tables for its metrics; it
   loads a bounded window on the system client, folds it with a PURE builder
   (`organization/marts.ts`, `platform/rollup.ts`, `finance/cohort-grid.ts`),
   and REPLACES the whole (days × scope) in one transaction, so any number of
   runs over any range converge on the same rows. Every run writes a
   `RollupRun`. Snapshot metrics (open tickets, overdue invoices, live
   sessions, active organisations) are written for the as-of day only —
   backfilling a past day's snapshot from today's state would be a fabricated
   history. The case rollup reads ids, kinds and dates and never a note, an
   assessment, a barrier or a name; the two Stage 17/18 boundary tests
   allow-list this one file and refuse anything more from it.

5. **Every reporting surface reads a mart, and the static test says which
   files those are.** The console overview and revenue pages, the employer
   dashboard and report, the staffing productivity API, the supervisor's
   caseload summary and every read module are refused a `count`, `findMany`,
   `aggregate` or `groupBy` on a source table and an in-memory status count.
   The one allow-listed module is `console/queues.ts`: the failed-payments
   work list and the recent signups are LISTS a person acts on, not metrics,
   and the test refuses a count or an aggregate inside it.

6. **Freshness is shown, not assumed.** A mart's "as of" is the OLDEST of the
   latest succeeded run of every job that writes it; a page prints it and
   says STALE past the SLA rather than silently showing old numbers. There is
   no scheduler: `npm run analytics:rollup` rebuilds every mart, and a stale
   line is the operator's cue. The freshness note is required on every mart
   page by the static test.

7. **Small cohorts are never a number.** The supervisor's outcome summary
   withholds an outcome figure — in total and by kind — under five distinct
   clients (`MIN_ORG_COHORT`, the Stage 13 threshold), and the case product
   has no cut but outcome kind, because a caseload cut by anything else could
   re-identify a client.

8. **The warehouse extraction boundary.** `src/lib/analytics/warehouse/export.ts`
   writes each mart's rows for a day range as one CSV per mart per day under
   `warehouse/<mart>/<day>.csv` in the platform's object storage, with a
   documented, tested column contract, RFC 4180 quoting, ISO dates and
   formula-cell neutralisation. The user-scoped candidate marts are opt-in.
   `docs/architecture/WAREHOUSE_EXTRACTION.md` is the loader's recipe. No
   warehouse is adopted.

## What the mart cannot say, said plainly

- The revenue mart's `mrr` is the end-of-range figure reconstructed from
  subscription events on that day, not today's live subscription table; the
  plan breakdown and the top failure codes are not in the wide row and come
  back empty rather than being read live.
- The employer `days_to_*` figures are MEANS (a sum with the count behind
  it); the page says "mean", because a median is not a quantity a daily mart
  can hold.
- The opening MRR for a range is the previous day's mart row; the sweep
  rolls up from the day before the window for that reason.

## Consequences

- G-25 closes on the engineering side: no dashboard, staff or candidate,
  reads a transactional table for a metric, and the static tests keep it so.
- Adding a metric is: dictionary entry, mart column or metric key, rollup
  fold, document row — never a `count()` on a page.
- The transactional tables are scanned once per sweep instead of once per
  page view; the request path reads indexed mart rows (the EXPLAIN test).
- Two more migrations (the marts; the revenue columns) and two more RLS
  classifications.
- Still not built, and stated: an event stream feeding the marts (ADR-0011),
  a scheduler, a warehouse, and any measurement of extraction or rollup
  throughput at production volume (**NOT VERIFIED**; a Stage 23 item).

## Alternatives considered

- **Materialised views** — rejected: they cannot carry per-run audit, cannot
  be replaced per scope, and a refresh is a full recompute the operator
  cannot bound.
- **Computing the organisation metrics on the tenant path from the source
  tables inside `run()`** — rejected: it is the flaw ADR-0012 names, and a
  supervisor's summary computed from case rows on a page is exactly where a
  small-cohort leak would occur.
- **A single generic mart for everything** — rejected: the RLS scope differs
  (`system` for finance, `org` for products), and a per-organisation table
  is what lets the policy do the isolation.

# Warehouse extraction — the boundary and the recipe (Stage 21, ADR-0036)

**Status:** the boundary is BUILT and tested; no warehouse is adopted, no
loader has run against one, and no extraction has been performed against a
production-sized volume (**load behaviour NOT VERIFIED**). ADR-0012 stage 3
says a warehouse is adopted only when volume justifies it; this document is
what makes that adoption a change of destination rather than a rewrite.

## The rule

Every number a staff or organisation dashboard shows is read from a **mart**
— a table rebuilt by a rollup job by REPLACEMENT over a (days × scope)
window, recorded in `RollupRun`, named in `MART_REGISTRY`
(`src/lib/analytics/platform/dictionary.ts`) with its RLS scope, its
partition key, its job and its refresh SLA, and defined metric by metric in
`docs/governance/METRIC_DICTIONARY.md`. A static test refuses a transactional
query on a reporting page or read module. So the transactional store is never
the reporting store, and the marts are the only thing a warehouse ever
needs.

## The marts

| Mart | Scope | Partition | Columns extracted |
| --- | --- | --- | --- |
| `DailyMetric` | system | `day` | `day, metric, dimension, valueInt, valueCents, valueParts` |
| `DailyRevenueRollup` | system | `day` | one wide finance row per day per currency (cash, MRR and movement, subscriber counts, payment outcomes) |
| `SubscriptionCohortMart` | system | `day` (as-of) | `day, currency, cohortMonth, monthOffset, subscribers, retained` |
| `OrganizationDailyMart` | org | `day` | `day, organizationId, product, metric, dimension, key, valueInt, valueCents, people` |
| `CandidateBenchmarkMart` | system | `day` | `day, dimension, key, users, applications, sent, responded, interviews, offers, hires` |
| `CandidateOutcomeMart` | user | `day` | opt-in only — see residency below; every count column of the model |
| `CandidateMatchMart` | user | `day` | opt-in only — see residency below; every column of the model |

The exact, ordered column list per mart is `MART_COLUMNS` in
`src/lib/analytics/warehouse/export.ts`; a test checks each column is a real
column of the model AND that every scalar column of the model (id and
timestamps aside) is extracted, so a loader never gets a key-only file. Treat it as the contract: a loader may rely on it, and
a change to it is an additive change to the document above plus the test.

## The extraction

`npm run analytics:export` (last 30 days), `-- --days 90`,
`-- --from 2026-08-01 --to 2026-08-31`, `-- --marts DailyMetric,CandidateOutcomeMart`
(`scripts/analytics/export-marts.ts` → `exportMarts`) writes, for each mart
and each day in the range that has rows, one CSV to the platform's object
storage (the Stage 09 storage provider — local disk by default, S3 when
configured) under

```
warehouse/<mart>/<day>.csv
```

- CRLF line endings, a header row of the contract columns, RFC 4180
  quoting, dates as ISO-8601 UTC, and **formula cells neutralised** (a STRING
  cell starting with `=`, `+`, `-`, `@` or a tab is prefixed with a quote;
  a number is never touched, so `-1500` stays a number) so an export opened
  in a spreadsheet cannot execute anything.
- Idempotent: the same day re-exported overwrites the same key.
- A day that never had rows writes no file (a loader treats a missing file
  as an empty partition, never as an error). A day whose partition exists
  and now has no rows (after a corrected re-rollup) is overwritten with a
  header-only file, so a loader never keeps stale rows.
- Every run writes an `analytics.exported` audit row naming the marts, the
  range, the file count and whether a user-scoped mart was included.
- The default mart set is the system- and organisation-scoped marts
  (`DEFAULT_EXPORT_MARTS`). The two user-scoped candidate marts are exported
  only when named with `--marts` — a per-person mart leaves the platform
  only under the residency decision that governs it (ADR-0015) — and the
  invocation is the operator's audited action, not a scheduled one.

## Loading (what a warehouse does; none is adopted)

Any engine that reads CSV from object storage loads the layout directly —
BigQuery external tables, Snowflake external stages, Redshift Spectrum,
DuckDB `read_csv_auto('warehouse/OrganizationDailyMart/*.csv')`. The
recipe is the same for each:

1. Create one table per mart with the contract columns, partitioned or
   clustered by `day` (and `organizationId` for the org mart).
2. Load or point at `warehouse/<mart>/`; re-loading a day is a partition
   replace, matching the rollup's own semantics.
3. Keep the metric dictionary as the semantic layer: a warehouse model
   that redefines `hires` is exactly the divergence ADR-0012 forbids.

Nothing in the marts, the rollups, the dashboards or the dictionary changes
when a warehouse is adopted. What changes is the destination of the CSVs
and, later, whether a dashboard reads the warehouse or the mart.

## What is deliberately not here

- **No event stream.** ADR-0011 (an outbox to a stream) is not built; the
  rollups read the transactional tables directly, once per sweep. A stream
  would feed the same marts.
- **No scheduler.** `npm run analytics:rollup` and `npm run analytics:export`
  are operator commands; every page shows its mart's freshness and says
  STALE past the SLA.
- **No load test.** The extraction and the rollups have been run against
  test fixtures only. Throughput at production volume is **NOT VERIFIED**
  and is a Stage 23 item.
- **No transactional table is ever extracted**, and no export carries a
  name, an email, a note or a case detail: the marts hold ids, kinds,
  counts and cents. The organisation mart's `recruiter` cut is keyed by
  MEMBER user ids (`stage_moves` and every staffing metric); an id of a
  natural person is personal data, so the default extraction is under the
  same residency decision as the rest (ADR-0015) and a destination outside
  that decision must hash or drop the `key` column for that dimension.
- The window the sweep and the export use ends at the end of today, never
  tomorrow.

# Reporting Architecture

**Decision:** `../adr/ADR-0012-reporting.md`

## Flow
```
TRANSACTIONAL DB ──► EVENTS ──► ANALYTICS MODELS / MARTS ──► DASHBOARDS
```
**No dashboard query touches a transactional table.**

## Current state
More capable than the rest of the product: 1,066 lines of revenue analytics, 821
lines of rollups, metric definitions, time handling, CSV and PDF export builders,
and rollup models (`DailyMetric`, `DailyUsageRollup`, `DailyRevenueRollup`,
`RollupRun`).

The flaw is structural: dashboards read the transactional store directly.

## Staged approach
1. **Now** — stay on PostgreSQL. Move dashboard reads onto materialized views and
   the existing rollup tables.
2. **Next** — feed marts incrementally from the event stream (`ADR-0011`) rather
   than full-scanning.
3. **Later** — extract to a warehouse only when volume justifies it. The mart
   boundary is designed now so extraction changes a destination, not a design.

**OpenSearch deferred.** PostgreSQL full-text plus pgvector covers current needs.

## Reporting products
Candidate · employer · recruiter/staffing · case manager · employment outcome ·
career transition · founder/platform · financial · AI cost · connector and system
health.

## Rules
1. **One definition per metric**, in a metric dictionary. Dashboards may not
   compute their own variants. Two definitions of "response rate" is how
   reporting loses credibility.
2. **Marts carry tenant scope.** A mart that drops `organization_id` is a
   cross-tenant leak RLS cannot catch.
3. **Small-cohort suppression** — critical in the WorkBC product, where a
   caseload cut by demographic could re-identify a client.
4. **Published refresh SLAs.** A stale dashboard says so rather than silently
   showing old numbers.
5. **AI cost is a first-class report**, sourced from `ai_runs` (`ADR-0006`).

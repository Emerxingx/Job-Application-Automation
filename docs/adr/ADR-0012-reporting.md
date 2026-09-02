# ADR-0012 — Reporting architecture

**Status:** Proposed · **Date:** 2026-09-02

## Context
Existing reporting is more capable than the rest of the product: 1,066 lines of
revenue analytics, 821 lines of rollups, metric definitions, time handling, CSV
and PDF export builders, `DailyMetric` / `DailyUsageRollup` / `DailyRevenueRollup`
/ `RollupRun` models, and `recharts` dashboards.

The flaw is structural, not qualitative: **dashboards query the transactional
database directly.** The brief warns explicitly against letting increasingly
expensive dashboard queries punish transactional workloads.

## Decision
Adopt `transactional DB → events → analytics models/marts → dashboards`.

Pragmatically staged:
1. **Now** — keep PostgreSQL. Move dashboard reads onto materialized views and
   the existing rollup tables. No dashboard query touches a transactional table.
2. **Next** — feed marts from the `ADR-0011` event stream so they are incremental
   rather than full-scan.
3. **Later** — extract to a warehouse only when volume justifies it. Design the
   mart boundary now so extraction is a change of destination, not a rewrite.

**OpenSearch is deliberately deferred.** PostgreSQL full-text plus pgvector covers
the current search need; adding a second datastore before it is justified is
operational burden the founder cannot absorb.

**Reporting products:** candidate, employer, recruiter/staffing, case manager,
employment outcome, career transition, founder/platform, financial, AI cost,
connector and system health.

## Consequences
- Every metric has exactly one definition in a metric dictionary, and dashboards
  may not compute their own variants. Two definitions of "response rate" is how
  reporting loses credibility.
- Marts carry tenant scoping. A mart that drops `organization_id` becomes a
  cross-tenant leak that RLS cannot catch.
- Aggregates over small cohorts are suppressed — especially in the WorkBC product,
  where a caseload cut by demographic could re-identify a client.
- Refresh SLAs are published per mart; a stale dashboard must say so rather than
  silently show old numbers.

## Revisit when
Mart refresh cost or dashboard latency exceeds budget on the managed instance.

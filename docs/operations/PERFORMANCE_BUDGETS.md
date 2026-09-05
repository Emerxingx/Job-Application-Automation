# Performance budgets and the load measurement (Stage 23, ADR-0037)

**Status:** budgets DEFINED; a repeatable measurement BUILT
(`npm run perf:load`, `npm run perf:rollup`); numbers RECORDED for a local
build on the build machine (`STAGE23_EVIDENCE.md`). **Nothing here is a
production measurement**: the managed database, the object store, the CDN
and the network are not in the loop, and the machine is not the production
instance. Readiness gate G4 has no "performance" row; this document is the
baseline Stage 24 measures against on the deployed environment.

## Route budgets (p95, local build, concurrency 8)

The budgets are the numbers `scripts/perf/load.ts` (`BUDGETS`) enforces; a
change here is a change there, and the evidence table names both.

| Route | Auth | p95 budget | Why this number |
| --- | --- | --- | --- |
| `/api/health` | no | 300 ms | Five checks against the database; a load balancer polls it. Rate-limited to 60/min per address, so under load most answers are 429 - counted apart from errors, and the latency measured is of every answer. |
| `/` | no | 500 ms | Static marketing page; server-rendered once per request. |
| `/login` | no | 500 ms | Same. |
| `/dashboard` | yes | 1500 ms | Reads the candidate's marts and the tenant context; the heaviest common page. |
| `/dashboard/jobs` | yes | 1500 ms | Recommendation feed with eligibility filter. |
| `/dashboard/applications` | yes | 1500 ms | Folder list. |
| `/dashboard/analytics` | yes | 1500 ms | Mart reads only (Stage 13). |
| `/api/agents` | yes | 500 ms | One tenant-path list. |
| `/api/account/erasure` | yes | 300 ms | One indexed read (Stage 23). |
| `/console` | yes (staff) | 2000 ms | Mart reads plus two operational queues. |
| `/console/revenue` | yes (staff) | 2000 ms | Mart reads. |

Error rate budget: 0 on every route. A 429 from the sign-in rate limit is
a correct refusal, so the measurement signs in once.

## Batch budgets (local database)

| Job | Volume | Budget | Why |
| --- | --- | --- | --- |
| `rollupOrganizations` (one organisation) | 20 000 submissions, 60 000 events, 90 days | 60 s (the replace transaction's ceiling, Stage 21 review M9) | The sweep must finish inside its own transaction timeout. |
| `exportMarts` (`OrganizationDailyMart`) | the rows above | 30 s | One CSV per day; the boundary must not be the slow part. |

## How to run

```
# a built, started app on :3000 with the seeded demo account
PERF_BASE_URL=http://127.0.0.1:3000 PERF_CONCURRENCY=8 PERF_SECONDS=10 PERF_JSON=perf-load.json npm run perf:load
# the batch measurement, against DATABASE_URL (a LOCAL database in the evidence)
PERF_SUBMISSIONS=20000 PERF_JSON=perf-rollup.json npm run perf:rollup
```

`perf:load` exits 1 when any route misses its budget or returns an error;
`perf:rollup` seeds, measures, prints, and deletes what it created.

## Bundle and page weight

The budget is **under 200 kB first-load JavaScript for every candidate
page**, and no route may pull the Payload admin bundle (it is its own
segment). Next 16's Turbopack build does not print a per-route size table,
so this is **NOT MEASURED** at Stage 23; Stage 24 measures it on the
deployed site with real browsers (Core Web Vitals) and records the largest
three routes here.

## What is NOT measured, stated

- Production latency, tail latency under real traffic, cold starts.
- The managed database and pooler (the local database is on the same host
  as the app; `DATABASE_URL` in production is a pooled endpoint with its
  own limits, `DEPLOYMENT_ARCHITECTURE.md`).
- Concurrency beyond 8 clients, sustained load beyond 10 s per route, or
  any soak test.
- Client-side rendering time (Core Web Vitals); Stage 24 with real
  browsers on the deployed site.

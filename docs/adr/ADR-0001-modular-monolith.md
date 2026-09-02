# ADR-0001 — Modular monolith, not microservices

**Status:** Proposed · **Date:** 2026-09-02

## Context
Four products share one platform core. The team is small; the founder is
non-technical. The existing application is a single Next.js deployment with
~23,850 lines in `src/lib`, already organised by domain folder (`billing/`,
`crm/`, `analytics/`, `integrations/`, `providers/`, `services/`).

## Options
- **A. Modular monolith** — one deployable, enforced module boundaries.
- **B. Microservices per product** — four services plus shared platform services.
- **C. Monolith now, extract later** — A, with extraction seams designed in.

## Decision
**Option C: a modular monolith with deliberate extraction seams.**

Module boundaries follow the logical domains in `DATA_ARCHITECTURE.md`
(`identity`, `candidate`, `job`, `matching`, `application`, `talent`, `staffing`,
`case_management`, `career`, `billing`, `integration`, `governance`,
`analytics`). Cross-module access goes through a module's public interface and
its events — never by reaching into another module's tables.

## Consequences
- One deployment, one database, one transaction boundary. Distributed
  transactions are avoided entirely, which is the dominant early risk.
- Boundaries must be enforced by review and lint rules, or they erode. A
  dependency-direction check is added in Stage 00.
- The event bus (`ADR-0011`) is the extraction seam: a module already publishing
  and consuming events can be lifted out without rewriting its callers.
- Explicitly rejected for now: Kubernetes, service meshes, per-product databases.
  None is justified at current scale and each adds operational burden the founder
  cannot absorb.

## Revisit when
A single module's scaling profile, compliance boundary or release cadence
genuinely diverges — most plausibly job ingestion (bursty, CPU-heavy) or the
WorkBC product (public-sector data-handling obligations).

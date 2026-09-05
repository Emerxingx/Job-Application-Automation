# ADR-0020 — WorkBC integration boundary

**Status:** Accepted (Stage 17 ships Level 0, 2026-09-05; ADR-0032) · **Date:** 2026-09-02

## Context
Product 3 is initially a **companion platform** for WorkBC case managers and
employment-services organisations. There is **no internal WorkBC API access**, and
none may be assumed.

**Positive audit finding:** no fabricated WorkBC integration exists anywhere in
the codebase. The boundary can be built honestly from a clean start.

## Decision
**Progressive integration levels. The platform is fully useful at Level 0 and
never claims a capability it does not have.**

| Level | Capability | Precondition |
| --- | --- | --- |
| **0** | **No direct integration.** Case managers use the platform alongside WorkBC systems. Full standalone case management | None — this is the shipping target for Stage 17 |
| 1 | Structured export/import (CSV, defined schemas) so data moves without an API | Agreed file formats |
| 2 | Approved secure exchange (SFTP, signed transfer) | A written data-sharing agreement |
| 3 | Approved API integration | WorkBC-issued credentials and an integration agreement |
| 4 | Government SSO | A provincial identity federation agreement |

**Rules:**
1. **No fake integration.** No mock, stub, screen or marketing claim may present
   WorkBC connectivity that does not exist. This extends the repository's existing
   standard, which never misrepresented a mock as production.
2. **Level 0 must be genuinely complete.** The product's value cannot depend on
   an integration that may never be approved.
3. Each level is additive and separately gated. Advancing requires a written
   agreement recorded in `COMPLIANCE_REGISTER.md`.
4. **Case notes are `RESTRICTED`** (`DATA_CLASSIFICATION.md`): strict
   organisational isolation via RLS, every access audited, retention configurable
   per organisation, and never sent to an AI provider without explicit
   organisational consent.
5. Employment-outcome reporting is designed to satisfy plausible programme
   reporting needs without assuming a specific WorkBC schema, so Level 1 export
   is a mapping exercise rather than a redesign.

## Consequences
- Stage 17 targets Level 0 only.
- The AI copilot **recommends**; the case manager decides. No AI output is
  auto-applied to a client record.
- Per-organisation residency and retention policy is required (`ADR-0015`) —
  a public-sector contract can override platform defaults.
- Sales and marketing material must state the current level accurately.

## Revisit when
A service provider or the province offers a data-sharing agreement.

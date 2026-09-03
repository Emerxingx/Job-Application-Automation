# ADR-0006 — AI provider abstraction and model routing

**Status:** Proposed · **Date:** 2026-09-02 · **Implemented (Stage 03, 2026-09-03):** the task-shaped gateway exists at `src/lib/ai/gateway.ts` — policy resolved before dispatch, `RESTRICTED` payloads refused, deterministic engine always run as the grounded baseline, output grounded in code before render, an `AiRun` row per run with the exact prompt version. The Anthropic adapter is now a transport (`AnthropicModelProvider`) with no prompts, routing or fallback of its own; the fallback described in Context below moved into the gateway and is recorded, never silent. Evidence: `../programme/STAGE03_EVIDENCE.md` §6–7. Live-model path validated with a fake provider only.

## Context
What exists is a genuine asset and must be preserved:
- `AIProvider` with lazy adapter loading, mock default, warn-and-degrade.
- `AnthropicAIProvider` constrains output with a JSON schema, handles refusal
  stop reasons, and **falls back to the deterministic engine on failure**.
- The deterministic engine is a real keyword/semantic scorer, not random numbers —
  explainable, stable, testable.
- A CMS-backed **prompt registry** with slug, version, provider, model,
  parameters, declared variables, and a default flag.
- `interpolate()` is single-pass and non-recursive, so a user-supplied value
  containing `{{...}}` cannot smuggle in another variable. Missing variables are a
  hard error.

Gaps: the interface is **product-shaped** (`analyzeMatch`, `tailor`,
`prepareInterview`) rather than task-shaped; there are **no embeddings**, so no
semantic retrieval; there is **no model routing by cost**; and there is **no AI
run traceability** — nothing records which model and prompt version produced a
given output, on what evidence.

## Options
- **A. Keep the product-shaped interface.** Every new AI capability needs a new
  method on every adapter.
- **B. Task-shaped gateway.** `generate`, `structuredOutput`, `embed`,
  `classify`, `rank`, with product operations composed on top.
- **C. Adopt a third-party orchestration framework.** Adds a large dependency and
  a second abstraction over the one already working.

## Decision
**Option B.** Introduce an AI Gateway exposing task primitives; reimplement the
three existing product operations on top of it without changing their behaviour
or their tests.

**Model routing by task**, configurable in the admin (`ADR-0019`), not hardcoded:

| Task | Tier |
| --- | --- |
| Email classification | low-cost |
| Job parsing / requirement extraction | low–medium, structured output |
| Match explanation | medium |
| Résumé tailoring | advanced |
| Career transition reasoning | reasoning-tier |

**AI traceability is mandatory.** Every material AI action writes an `ai_runs`
record: run id, task, tenant, user, input references, **evidence references**,
provider, model, prompt version, parameters, output reference, confidence, human
override, timestamp, and cost. Without this, `AI_GOVERNANCE.md` cannot be
enforced and AI cost reporting is impossible.

## Per-tenant processing policy — enforced in the gateway

Cross-border AI processing is **not universally permissible** and must never be
treated as a platform-wide constant. The gateway resolves the calling tenant's AI
processing policy — `EXTERNAL_AI_ALLOWED`, `EXTERNAL_AI_RESTRICTED` or
`EXTERNAL_AI_PROHIBITED` (`ADR-0015`) — **before** selecting a route, and refuses
any non-compliant one. A missing or unreadable policy **fails closed** to
`EXTERNAL_AI_PROHIBITED`.

Each task therefore has four possible destinations, chosen per tenant:

1. an approved external provider;
2. a Canadian-resident or approved on-shore provider;
3. the **deterministic local engine**;
4. **explicit feature degradation** — the capability is disabled and says so.

Silently falling back to a non-compliant provider is a defect, not a degradation.
Every `ai_runs` record stores the policy state and the route actually taken, so
compliance is auditable after the fact.

This is the second reason the deterministic engine is retained permanently: it is
the compliant local path for tenants that prohibit external processing. Enforcement
is a **Stage 03 exit condition**; the policy itself is a Stage 01 schema obligation.

## Consequences
- Embeddings land in **pgvector** on the existing PostgreSQL instance
  (`ADR-0002`) — no separate vector database.
- The prompt registry gains `deployment status`, `evaluation status`,
  `created_by` and `approved_by`, and moves out of the content CMS into governed
  platform administration **before or during Stage 03** — before evidence-grounded
  AI becomes production-active — not at Stage 20 (`ADR-0003`, `ADR-0019`).
- The deterministic engine is **retained permanently** as the grounding input,
  the fallback path, and the scoring-consistency reference.
- Provider adapters stay lazy-loaded so a deployment without credentials never
  loads an SDK — the existing pattern, preserved.
- No product code may import a provider SDK directly. Enforced by review.
- Provider availability is **per tenant**, never assumed platform-wide. No AI
  provider may be described as universally permissible.
- Sensitive attributes never enter a prompt (`ADR-0007`); mailbox content never
  without explicit consent; one tenant's data never in another's context.

## Revisit when
A task's cost or latency profile justifies a self-hosted or fine-tuned model.

# ADR-0006 — AI provider abstraction and model routing

**Status:** Proposed · **Date:** 2026-09-02

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

## Consequences
- Embeddings land in **pgvector** on the existing PostgreSQL instance
  (`ADR-0002`) — no separate vector database.
- The prompt registry gains `deployment status`, `evaluation status`,
  `created_by` and `approved_by`, and moves out of the content CMS into the
  platform admin in Stage 20 (`ADR-0003` Option C).
- The deterministic engine is **retained permanently** as the grounding input,
  the fallback path, and the scoring-consistency reference.
- Provider adapters stay lazy-loaded so a deployment without credentials never
  loads an SDK — the existing pattern, preserved.
- No product code may import a provider SDK directly. Enforced by review.

## Revisit when
A task's cost or latency profile justifies a self-hosted or fine-tuned model.

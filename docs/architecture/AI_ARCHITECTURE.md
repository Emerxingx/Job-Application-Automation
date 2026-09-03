# AI Architecture

**Decision:** `../adr/ADR-0006-ai-abstraction.md` · **Governance:** `../governance/AI_GOVERNANCE.md`

**Implementation status (Stage 03, 2026-09-03):** the task-shaped gateway,
evidence grounding, traceability and the extended prompt registry below are
implemented — `src/lib/ai/gateway.ts`, `src/lib/ai/grounding.ts`,
`src/lib/evidence/vault.ts`, `src/lib/ai/prompt-registry.ts`. Model routing
is policy-first and currently resolves to the deterministic engine for every
task because no prompt version has passed evaluation. Evidence:
`../programme/STAGE03_EVIDENCE.md`.

## What exists (preserve)
- `AIProvider` abstraction with lazy adapter loading and a mock default.
- `AnthropicAIProvider` (since Stage 03: `AnthropicModelProvider`, a transport only): JSON-schema-constrained output, refusal handling, and a
  **fallback to the deterministic engine** on failure.
- A **deterministic keyword/semantic engine** that produces stable, explainable
  scores — used both as AI grounding and as the fallback. This is a genuine asset.
- A CMS-backed **prompt registry** with slug, version, provider, model,
  parameters, declared variables and a default flag.
- **Single-pass, non-recursive interpolation.** A user value containing `{{...}}`
  is inserted verbatim and never re-scanned. Missing variables are a hard error.

## Target: a task-shaped gateway

```
                     ┌──────────────────────────────┐
  product code ──────►        AI GATEWAY            │
  (never imports     │  generate()                  │
   a provider SDK)   │  structuredOutput()          │
                     │  embed()                     │
                     │  classify()                  │
                     │  rank()                      │
                     └───┬─────────┬─────────┬──────┘
                         │         │         │
                  Anthropic    OpenAI    Deterministic
                   adapter     adapter      engine
                                          (grounding + fallback)
```

Product operations (`analyzeMatch`, `tailor`, `prepareInterview`) are **composed
on top** of the primitives, preserving current behaviour and tests.

## Model routing
Configured in the admin (`ADR-0019`), never hardcoded:

| Task | Tier | Rationale |
| --- | --- | --- |
| Email classification | low-cost | High volume, low complexity |
| Job parsing / requirement extraction | low–medium, structured | Schema-constrained |
| Match explanation | medium | Reader-facing prose over computed inputs |
| Résumé tailoring | advanced | Quality directly affects outcomes |
| Career transition | reasoning-tier | Multi-step, high stakes |

## Evidence grounding — the central constraint
The gateway accepts **evidence references, not free text**, for any generation
that produces candidate-facing claims. A tailoring call receives evidence IDs;
the renderer rejects material claims without an evidence reference **before**
output reaches the candidate.

AI may prioritise, reframe, summarise, reorganise and truthfully adapt
terminology. AI may **not** invent employment, responsibilities, technologies,
years of experience, revenue, achievements, education, certifications, clients or
projects.

## Traceability
Every material AI action writes an `ai_runs` row: run id, task, tenant, user,
input references, **evidence references**, provider, model, prompt version,
parameters, output reference, confidence, human override, timestamp, cost.

Without this there is no AI cost reporting, no prompt regression analysis, and no
way to answer "why did the system say that?".

## Prompt registry (extended)
Existing fields — task/slug, prompt, version, provider, model, parameters,
declared variables, default flag — plus **structured schema**, **deployment
status**, **evaluation status**, `created_by`, `approved_by`.

A version cannot be marked default until it has passed evaluation. Prompts move from the content CMS to the platform
admin (`ADR-0003`) by Stage 03 because they are AI-operator configuration, not
editorial content.

## Boundaries
1. No product module imports a provider SDK directly.
2. Sensitive attributes never enter a prompt (`ADR-0007`).
3. Mailbox content never enters a prompt without explicit consent (Stage 11).
4. Job descriptions and emails are **untrusted input**.
5. Cross-border processing is a documented, consented exception (`ADR-0015`).
6. **Interview probability is not modelled** until sufficient real outcome data
   exists to calibrate it. Compatibility and interview likelihood stay separate.

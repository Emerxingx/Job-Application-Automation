# AI Governance

**Architecture:** `../architecture/AI_ARCHITECTURE.md` · **Decision:** `../adr/ADR-0006-ai-abstraction.md`

## The truthfulness rule

**AI may:** prioritise, reframe, summarise, reorganise, and truthfully adapt
terminology to a job's vocabulary.

**AI may not invent:** employment, responsibilities, technologies, years of
experience, revenue, achievements, education, certifications, clients, or projects.

This is enforced **structurally**, not by prompt wording. Prompts asking a model
to be truthful are a hope, not a control.

## Evidence grounding (the control)
1. The candidate approves atomic **evidence** items, each linked to a source.
2. Generation calls receive **evidence references, not free text**.
3. The renderer rejects any material claim without an evidence reference before
   output reaches the candidate.
4. The generated document records which evidence produced which claim.

A claim that cannot be traced does not ship. That is the whole design.

## Mandatory AI testing (`TEST_STRATEGY.md`)

| Test class | Asserts |
| --- | --- |
| **Truthfulness** | Given a fixed profile, no generated document contains an employer, technology, date, credential or metric absent from the vault |
| **Evidence grounding** | Every material claim carries a resolvable evidence reference |
| **Schema conformance** | Structured outputs parse deterministically against their schema |
| **Prompt regression** | A new prompt version does not degrade quality against a golden set |
| **Sensitive-data leakage** | No prompt payload contains a `RESTRICTED` field |
| **Scoring consistency** | Identical inputs produce identical scores |
| **Injection resistance** | A job description or email containing instructions cannot redirect a system prompt |

Truthfulness and leakage tests run against **both** the deterministic engine and
the live-model path. A model change that fails them does not ship.

## Prompt governance
Every prompt version records: task/slug, prompt text, version, provider, model,
parameters, structured schema, declared variables, **deployment status**,
**evaluation status**, `created_by`, `approved_by`.

**A version cannot be marked default until it has passed evaluation.** Prompt
changes are Tier 1 configuration (`ADR-0019`) but require approval, because a
system prompt is security-relevant.

Interpolation is **single-pass and non-recursive** (already implemented): a
user-supplied value containing `{{...}}` is inserted verbatim and never
re-scanned, so it cannot smuggle in another variable or cause unbounded
expansion. Missing declared variables are a **hard error**, never a silent gap.

## Traceability
Every material AI action writes an `ai_runs` record: run id, task, tenant, user,
input references, evidence references, provider, model, prompt version,
parameters, output reference, confidence, human override, timestamp, cost.

This is what makes it possible to answer "why did the system say that?" and to
report AI cost per tenant and per task.

## Human authority
- **Applications are prepared, never sent autonomously** (`ADR-0016`).
- **The case-manager copilot recommends; the case manager decides.** No AI output
  is auto-applied to a client record.
- Any AI-influenced decision affecting a person is reversible by a human, and the
  override is recorded.

## Per-tenant AI processing policy
Every organisation carries a governed policy state — `EXTERNAL_AI_ALLOWED`,
`EXTERNAL_AI_RESTRICTED` or `EXTERNAL_AI_PROHIBITED` (`ADR-0015`). Public-sector,
WorkBC and other restricted tenants must be able to prohibit external AI
processing outright while keeping the platform usable.

The gateway enforces it before dispatch; a missing policy **fails closed** to
prohibited. Under `EXTERNAL_AI_PROHIBITED` no candidate evidence, case note,
mailbox content or `RESTRICTED` tenant data leaves the permitted boundary — in any
form, embeddings and derived classifications included. Where no compliant
processor exists the feature is **explicitly degraded and says so**; it never
silently uses a non-compliant route.

**Cross-border AI processing is never assumed universally permissible.** L-3 in
`COMPLIANCE_REGISTER.md` stays OPEN until legal review resolves real customer
requirements.

## Data boundaries
- Never send `RESTRICTED` data to a provider. The gateway rejects such payloads.
- Never route a tenant's data to a provider its policy does not permit.
- Never send mailbox content without explicit consent.
- Send the minimum necessary — evidence references, not whole profiles.
- Never place one tenant's data in another's context.
- Cross-border processing is a documented, disclosed, consented exception
  (`ADR-0015`).

## Prohibited uses
No sensitive demographic attribute may influence compatibility, ranking,
eligibility or career recommendation. No AI-generated claim about a candidate may
be presented to an employer as candidate-asserted fact. **No interview
probability is published until real outcome data supports calibration** —
publishing an uncalibrated probability is a false precision the product cannot
support.

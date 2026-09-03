# CMS Architecture

**Decision:** `../adr/ADR-0003-headless-cms.md` — **keep Payload; do not migrate to Strapi.**

## Current implementation (measured)
- **Payload 3.88.0 in-process** inside the Next.js app. No separate service.
- **Own database** via `PAYLOAD_DATABASE_URI`, separate from the transactional store.
- Mounted at **`/api/cms`**, deliberately not Payload's default `/api`, so its
  catch-all can never shadow the 49 application routes.
- 11 collections, 3 globals, Lexical rich text, `sharp` wired for image sizes.
- Reached through `src/lib/cms.ts` and `src/lib/cms-fast/`, with a **verified
  fallback to hardcoded copy** when content is absent — the production build
  succeeded against an empty database during this audit.

## The boundary (normative)

**CMS owns content:**
marketing pages · SEO · career content · occupation guides · industry guides ·
certification guides · learning content · FAQs · help · employer resources ·
case-manager resources · legal and policy presentation · email template content ·
notification content.

**CMS is never the system of record for:**
candidate profiles · applications · sensitive data · employer pipelines · case
notes · placements · invoices · entitlements · evidence · audit.

**This boundary is already correctly implemented.** Nothing in the CMS reads or
writes a Prisma table, and no business logic depends on Payload being configured.
It is recorded here as normative so it is not eroded later.

## Planned refinement — staged by production-activation, not deferred to Stage 20
Three collections were **operational configuration, not editorial content**:
`AtsRulesets`, `PromptRegistry`, `FieldMappings`.

They move to the platform admin (`ADR-0019`) **as each becomes production-active**:

| Collection | Moves by |
| --- | --- |
| `PromptRegistry` | **DONE, Stage 03 (2026-09-03)** — removed from `payload.config.ts`; now `PromptVersion` in the transactional database, administered at `/console/prompts` (admin, step-up, approval, evaluation-gated promotion, rollback, audit). `prompt-engine.ts` deleted; `prompt-interpolate.ts` retained |
| `AtsRulesets` / job-source config | **DONE, Stage 05 (2026-09-03)** — `AtsRuleset` in the transactional database, `/console/ats-rulesets` (second-admin approval, activation / rollback, step-up, audit, no evasion setting); job-source config is the `JobSource` register at `/console/sources` |
| `FieldMappings` / automation config | before production use of **Stage 12** |

Each arrives with versioning, audit history, role-restricted administration,
step-up authentication where appropriate, prompt approval and evaluation status,
rollback to a prior version, and a record of the exact version used for every
affected AI or application output.

They move because:
- `PromptRegistry` defines **system prompts** — security-relevant configuration
  whose permissions should not sit with a marketing editor.
- All three are read by the engine on hot paths and belong with runtime config,
  versioning and approval workflow.

The CMS keeps the **narrative** content for career, learning and certification
topics; the transactional graph that answers *"will this credential improve my
eligibility?"* lives in `career.*` and `learning.*` (Stage 16).

## Operational notes
- Payload's database moves to PostgreSQL alongside the main store, remaining a
  **separate logical database** (`ADR-0002`).
- Payload's peer range constrains Next. Verify it before every Next upgrade —
  a standing obligation (`ADR-0017`).
- `importMap.js` and `payload-types.ts` are tracked generated files with a CI
  determinism check (`ADR-0014`).
- Editor accounts (`Editors` collection) are a **separate identity domain** from
  application users. Do not merge them.

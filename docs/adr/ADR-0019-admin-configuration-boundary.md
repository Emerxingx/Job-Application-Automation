# ADR-0019 — Admin configuration boundary

**Status:** Proposed · **Date:** 2026-09-02

## Context
The founder is non-technical and must be able to run normal business operations
without editing source code. Today, changing a plan price, a matching weight, a
job source, a feature flag, an AI model or a retention policy requires a
developer.

What exists: the Payload admin (content, plus `AtsRulesets`, `PromptRegistry`,
`FieldMappings`) and `/console` (customer CRM, invoices, tickets). Both are real
and useful.

The brief also warns: *do not make critical security rules casually editable.*
These two goals pull in opposite directions and need an explicit boundary.

## Decision
**Two tiers, with a hard line between them.**

**Tier 1 — business configuration. Admin-editable, versioned, audited.**
Plans, prices, entitlements, feature flags, matching weights, taxonomies,
templates, career pathways, learning catalog, notification and email content,
CMS content, job-source enablement and connector settings, AI model routing,
prompt versions, report definitions, organisation and user administration, role
assignment.

**Tier 2 — security-critical implementation. Code and migration only.**
Authentication logic, session handling, RLS policies, permission *definitions*
(as opposed to assignment), the sensitive-schema boundary (`ADR-0007`), the
apply-mode ceiling (`ADR-0016`), source-lawfulness rules (`ADR-0008`), residency
(`ADR-0015`), encryption, secret handling, audit-log integrity.

**Rules that make the boundary hold:**
1. Every Tier 1 change is **versioned and audited** — who, when, what changed,
   previous value. Matching weights and prompts additionally record the version
   used by each affected output, so a result can always be explained.
2. Tier 1 changes that affect money, AI behaviour or data retention require
   **step-up authentication** and, where destructive, a second approver.
3. **A Tier 1 control may never widen a Tier 2 boundary.** Concretely: no admin
   setting may enable auto-apply, disable RLS, expose the sensitive schema, or
   turn off audit logging. If a proposed setting could, it is Tier 2.
4. **Support impersonation is read-only, reason-required and time-boxed.** The
   `ImpersonationSession` model already encodes this intent and is unimplemented;
   it becomes real in Stage 20.
5. The `/console` two-lock pattern (`STAFF_EMAILS` allowlist **and** role,
   failing closed, unknown role degrading to least privilege) is the required
   pattern for every admin surface.

## Consequences
- `PromptRegistry`, `AtsRulesets` and `FieldMappings` move from the content CMS to
  the platform admin (`ADR-0003` Option C). Prompts are AI-operator
  configuration, not editorial content, and their permissions should not be a
  marketing editor's.
- Prompts gain approval and evaluation status before a version can be marked
  default.
- Every stage adds its admin surface as part of that stage, not afterwards.
  Retrofitting admin at the end is how founders end up dependent on developers.

## Revisit when
A Tier 1 control is requested that would cross into Tier 2 — the answer is an
ADR, not a config flag.

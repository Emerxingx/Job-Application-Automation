# ADR-0003 — Headless CMS: Payload vs Strapi

**Status:** Proposed · **Date:** 2026-09-02 · **Decision owner:** Founder · **Partially implemented (Stage 03, 2026-09-03):** `PromptRegistry` has moved out of the CMS (see the migration schedule below); `prompt-engine.ts` is deleted and the interpolation core (`prompt-interpolate.ts`) now serves the governed registry. Payload keeps content and, for now, `AtsRulesets` and `FieldMappings`.

## Context

The target technology baseline named **Strapi 5** as the CMS candidate. The
repository already runs **Payload 3.88.0**. The brief is explicit: *"Do NOT
migrate merely because Strapi was previously proposed."* This ADR evaluates the
choice on evidence.

### What is actually built (measured at `35d3491`)

- Payload 3.88.0 runs **in-process inside the Next.js application** using
  Payload's native Next integration. There is **no separate service to deploy**.
- **11 collections**: `Editors`, `Media`, `Pages`, `BlogPosts`, `LearningPaths`,
  `CareerGuides`, `Certifications`, `AtsRulesets`, `PromptRegistry`,
  `FieldMappings`, `SeoPages`.
- **3 globals**: `SiteSettings`, `PricingCopy`, `DashboardLayout`.
- Its own **separate database** (`PAYLOAD_DATABASE_URI`), deliberately isolated
  from the Prisma transactional store.
- Mounted at `/api/cms` — deliberately *not* Payload's default `/api`, so its
  catch-all can never shadow the 49 existing application routes.
- Lexical rich text; `sharp` wired so `Media` image sizes actually generate.
- Reached through `src/lib/cms.ts` and `src/lib/cms-fast/`, with a **graceful
  fallback to hardcoded copy** when no CMS content exists — verified during this
  audit: the production build succeeded against an empty database, logging
  `no such table: pages` and rendering built-in copy.

### Coupling assessment

Coupling to Payload is **low and well-contained**:

- Application code reaches the CMS through two modules (`cms.ts`, `cms-fast/`)
  plus `prompt-engine.ts`. It does not import Payload internals elsewhere.
- The CMS holds **no transactional data**. No Prisma table is read or written by
  Payload, and no CMS document is a system of record for candidates,
  applications, billing, case notes or placements.
- Payload-specific surface: `src/payload.config.ts`, 14 collection/global
  definitions, one admin component, the generated `importMap.js` and
  `payload-types.ts`, and three Next route files under `src/app/(payload)/`.

The brief's §12 boundary requirement — *CMS is for content, not the transactional
system of record* — is **already satisfied**. That is the substantive
architectural question, and the existing implementation answers it correctly.

## Options

### A. Keep Payload as the canonical CMS
- **Maturity:** built, working, 14 content types modelled, admin renders, fallback path proven.
- **Deployment:** zero additional services. Payload 3 is a set of Next routes.
- **Next.js compatibility:** native. `withPayload()` wraps the Next config.
- **Migration cost:** none.
- **Constraint:** Payload's peer range pins Next (see `ADR-0017`). This is real
  but bounded — the range already permits `next >=16.2.6 <17.0.0`.
- **Founder operability:** one admin UI at `/admin`, plus `/console` for CRM.
- **API-first:** REST at `/api/cms`, GraphQL at `/api/cms/graphql`.

### B. Migrate to Strapi 5
- **Deployment:** a **separate Node service** with its own database, deploy
  pipeline, scaling, monitoring, backup and upgrade path. For a non-technical
  founder this is a second operational system to keep alive.
- **Migration cost:** re-model 14 content types, re-implement `cms.ts`,
  `cms-fast/` and `prompt-engine.ts` against Strapi's API, migrate content,
  re-do the admin component, retest. Realistically weeks, delivering **no new
  user-facing capability**.
- **Benefit:** removes the Payload→Next peer coupling; larger plugin ecosystem;
  a standalone service can be scaled or replaced independently.
- **Cost:** a second auth surface, a second permissions model, cross-service
  latency on content reads currently served in-process, and a second thing that
  can be down.

### C. Separate concerns differently
Keep Payload for editorial content; move **operational configuration** —
`AtsRulesets`, `PromptRegistry`, `FieldMappings` — out of the CMS into the
transactional database behind the platform admin.

This is a real observation. Those three collections are not editorial content;
they are runtime configuration that the engine reads on hot paths, and
`PromptRegistry` in particular is **security-relevant** (it defines system
prompts). Governing them through the CMS's editor permissions model conflates
"marketing editor" with "AI operator".

## Decision

**Keep Payload as the canonical CMS (Option A), and adopt the configuration
split from Option C — migrated per collection as each one's runtime capability
becomes production-active, NOT deferred to Stage 20.**

Deferring the split to Stage 20 would leave security-relevant runtime
configuration governed by editorial CMS permissions for the entire period in
which it is actually driving production behaviour. The migration schedule is
therefore tied to when each collection goes live:

| Collection | Must move to governed platform administration | Because |
| --- | --- | --- |
| **`PromptRegistry`** | **before or during Stage 03** | Evidence-grounded AI becomes production-active in Stage 03. System prompts are security-relevant configuration and must not be governed by a marketing editor's permissions |
| **`AtsRulesets`** and job-source operational configuration | **before or during Stage 05** | Connector rules become production-active when lawful sources are enabled |
| **`FieldMappings`** and application-automation configuration | **before production use of Stage 12** | These drive what is placed into an employer's application form |

Each migrated collection must carry: versioning; audit history; role-restricted
administration; step-up authentication where appropriate; **prompt approval and
prompt evaluation status**; rollback to a prior configuration version; and a
record of the **exact configuration version used for every affected AI or
application output**, so any output remains explicable after a change.

Reasoning, in order of weight:

1. **The migration buys nothing the product needs.** The brief's CMS requirement
   is a correct content/transactional boundary. That boundary already exists and
   was verified. Migrating replaces a working implementation with an equivalent
   one at the cost of weeks and a new failure domain.
2. **Operational simplicity dominates for a non-technical founder.** Payload adds
   zero services. Strapi adds one service, one database, one deploy pipeline and
   one more upgrade treadmill. The brief prefers managed infrastructure and
   founder operability; a second self-managed service works against both.
3. **The Payload→Next pin is bounded, not a dead end.** It was previously
   recorded as the reason Next cannot be upgraded. Measurement shows Payload
   3.88.0 already declares support for `next >=16.2.6 <17.0.0`. The constraint is
   a version-sequencing obligation, not a structural defect — and it is not
   severe enough to justify replacing a working CMS.
4. **Coupling is low enough that the decision stays reversible.** Three modules
   and 14 definitions. If Payload later becomes a genuine constraint, migration
   remains a contained project.
5. **Option C addresses a real flaw** that migrating to Strapi would *not* fix —
   it is a boundary problem, not a product problem.

## Consequences

- Next.js upgrades must be sequenced against Payload's peer range. Verify the
  range before every Next upgrade. `ADR-0017` owns this.
- Payload's database moves from SQLite to PostgreSQL alongside the main store
  (`ADR-0002`), remaining a **separate logical database**.
- Payload's admin permissions govern **content only**. `PromptRegistry`,
  `AtsRulesets` and `FieldMappings` migrate to the platform admin under
  `ADR-0019` on the schedule above — Stage 03, Stage 05 and Stage 12
  respectively — not at Stage 20. Stage 20 consolidates the remaining admin
  surface; it does not own these three migrations.
- The CMS boundary in `docs/architecture/CMS_ARCHITECTURE.md` is normative: no
  candidate profile, application, case note, pipeline, placement or invoice may
  ever live in the CMS.
- Payload 4 exists only as `4.0.0-internal.*` prereleases and is not adoptable.
  3.88.0 is the current stable release and is what is installed.

## Revisit when

- Payload's peer range blocks a Next version needed for a security fix **and**
  no Payload release resolves it within one release cycle; or
- content operations need multi-service scaling independent of the app; or
- Payload 4 reaches stable and its migration path is documented.

# Integration Register

Every external system, its status, and what evidence supports that status.

**Status vocabulary:** `PRODUCTION-VALIDATED` · `SANDBOX-VALIDATED` ·
`IMPLEMENTED-NOT-VALIDATED` · `MOCK` · `STUB` · `CONFIG-ONLY` · `PLANNED` · `DEAD`

**Rule: code existing is not evidence of working.** An integration is only
promoted on the strength of an observed run against the real service.

**As of `35d3491`, no integration is `PRODUCTION-VALIDATED`.**

## Data in

| System | Status | Data | Residency | Evidence |
| --- | --- | --- | --- | --- |
| Adzuna | IMPLEMENTED-NOT-VALIDATED | Job postings (CA/US) | Outbound queries only | Real client, documented endpoint, timeout, NOC inference. Never run live |
| Greenhouse / Lever | IMPLEMENTED-NOT-VALIDATED | Postings; authorized submission | — | Detection implemented; submission needs an employer-issued credential nobody holds |
| Ashby / SmartRecruiters | PLANNED | Postings | — | — |
| Employer career pages | PLANNED | Postings | — | — |
| Job Bank | **PLANNED — not implemented** | Canadian postings | CA | **No prohibited scraping.** Permitted datasets / approved feeds only (`ADR-0008`) |
| NOC 2021 / TEER | **REGISTERED, NOT INGESTED** (licence unrecorded) | Occupations | CA | Stage 04: loader, hierarchy, TEER, bilingual labels and classifier proven on an attributed test fixture; `requireIngestible()` refuses the real dataset until an admin records the licence at `/console/taxonomy` (L-2) |
| SOC 2018 | **REGISTERED, NOT INGESTED** | US occupations (NOC↔SOC crosswalk) | US | Stage 04: crosswalk loader proven on a fixture; gated as above |
| OaSIS | REGISTERED, NOT INGESTED | Occupation ↔ skills | CA | No loader yet; gated |
| Canadian Skills & Competencies Taxonomy | REGISTERED, NOT INGESTED | Skills | CA | No loader yet; gated |
| O*NET | REGISTERED, NOT INGESTED | US occupation ↔ skills | US | No loader yet; gated |

## Services out

| System | Status | Data sent | Residency | Evidence |
| --- | --- | --- | --- | --- |
| Anthropic | IMPLEMENTED-NOT-VALIDATED | The résumé projection, the posting, approved evidence claims, and a governed prompt version — never a `RESTRICTED` attribute (gateway refuses the payload) | **Cross-border — reachable only through the gateway, only for tenants at `EXTERNAL_AI_ALLOWED` (`RESTRICTED` permits no task until L-3 resolves), and only when a prompt version is `default`, which none is** | Real SDK as a transport only (`AnthropicModelProvider`: rendered prompt in, JSON or null out); routing, grounding and fallback live in the gateway and are recorded on every `AiRun`. **Never run with a live key**; the live-model truthfulness path is proven with a fake provider (Stage 03) |
| OpenAI | PLANNED | As above | **Cross-border — same per-tenant gating** | — |
| Canadian-resident / approved on-shore AI provider | PLANNED | As above | CA | Required to serve tenants at `EXTERNAL_AI_PROHIBITED` with AI features; absent one, those features degrade explicitly (`ADR-0015`) |
| Stripe | IMPLEMENTED-NOT-VALIDATED | Customer email, amounts, metadata. **No card data stored** | Cross-border | Real Checkout + verified webhook. Never run live. **Not idempotent** (Stage 01) |
| PayPal | IMPLEMENTED-NOT-VALIDATED | Payment data | Cross-border | 816 lines, unexercised |
| Manual payments | IMPLEMENTED-NOT-VALIDATED | Internal | CA | Unit-tested only |
| Customer webhooks | IMPLEMENTED-NOT-VALIDATED | Event payloads | Customer-controlled | Delivery state machine + SSRF guard + `redirect: 'error'`. **No worker runs it** |

## Communication and identity — PLANNED except where noted

Gmail · Microsoft Graph mail · Google Calendar · Microsoft Calendar (Stage 11,
`RESTRICTED`, least-privilege incremental scopes, revocation purges derived
content) · Google/Microsoft/Apple OAuth (delivered through Supabase Auth — see
Infrastructure) · Enterprise SAML/OIDC + SCIM (Stage 20).

## Infrastructure

| System | Status | Evidence |
| --- | --- | --- |
| Payload CMS | SANDBOX-VALIDATED | Admin renders; build verified against an empty database exercising the fallback |
| Redis cache | SANDBOX-VALIDATED | 206 ms → 0.389 ms measured (`HANDOFF.md` §5) |
| S3-compatible storage | PLANNED | Local filesystem today |
| Managed PostgreSQL (Supabase, Canada Central) | **IMPLEMENTED-NOT-VALIDATED** | Provider switched, migrations and RLS written and proven on PostgreSQL 16 locally, in CI, and through PgBouncer in transaction mode. **Never run against the Supabase project**: unreachable from the build environment (R-34). Credentials verified present and correctly shaped only |
| Supabase Auth (identity provider, ratified Stage 01 decision) | **IMPLEMENTED-NOT-VALIDATED** | Platform side only: token verification (`src/lib/identity/supabase.ts`), identity linkage (`src/lib/identity/link.ts`), exchange route. Exercised with locally-minted tokens of the same shape; **no real token has been verified**. Needs `SUPABASE_URL`, `SUPABASE_JWT_SECRET` (or JWKS reachability) and egress to the project host |
| WorkBC systems | **NOT IMPLEMENTED — Level 0** | No integration exists and none is claimed (`ADR-0020`) |

## Public API
`/api/v1` — IMPLEMENTED-NOT-VALIDATED. Strong key handling (SHA-256,
`timingSafeEqual`, prefix design, never re-displayed), structured error envelope,
**no CORS by design**. No external consumer yet.

## Promotion rules
1. `IMPLEMENTED-NOT-VALIDATED` → `SANDBOX-VALIDATED` requires an observed run
   against the provider's sandbox, with the trace recorded here.
2. `SANDBOX-VALIDATED` → `PRODUCTION-VALIDATED` requires an observed production
   run plus monitoring and alerting.
3. **No integration may be described to a customer above its recorded status.**
4. Every cross-border processor is listed in `COMPLIANCE_REGISTER.md`.

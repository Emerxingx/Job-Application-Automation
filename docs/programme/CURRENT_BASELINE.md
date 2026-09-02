# Current Baseline — Measured State of the Repository

**Audit date:** 2026-09-02
**Commit audited:** `35d3491675e124df8af661b51ce9fa00fbf473fa` (= `origin/main`)
**Branch:** `claude/career-employment-platform-v1`
**Environment:** Linux container, Node v22, npm 10, clean clone, `npm ci` from committed lockfile

This document records **what was measured**, not what was claimed. Every row is
reproducible with the command shown. Where a claim could not be verified, it is
marked `NOT VERIFIED` rather than assumed true or false.

`HANDOFF.md` (already in the repository) is a good-faith engineering handoff and
its §5 verification table reproduced exactly in this audit. It is treated here as
a **corroborated secondary source**, not as primary evidence. One material
correction to it is recorded in §6 below.

---

## 1. Build gates — measured

| Gate | Command | Result | Status |
| --- | --- | --- | --- |
| Install | `npm ci` | exit 0, 429+ packages | PASS |
| Typecheck | `npx tsc --noEmit` | exit 0, no diagnostics | PASS |
| Unit/integration tests | `npm test` | **670 pass / 0 fail**, 158 suites, 4.4 s | PASS |
| Production build | `npm run build` | exit 0, ~79 routes emitted | PASS |
| Lint | `npm run lint` | **exit 1 — drops into an interactive ESLint setup prompt** | FAIL |
| Dependency audit | `npm audit` | 14 advisories: 1 low, 7 moderate, 6 high, 0 critical | FAIL |

### 1.1 The lint finding is worse than "disabled"

`next.config.mjs` sets `eslint: { ignoreDuringBuilds: true }`, which reads as
"lint exists but is skipped at build time." That is not the situation.

Measured:

- **No ESLint configuration file exists** — no `.eslintrc*`, no `eslint.config.*`.
- **ESLint is not a dependency** — it appears nowhere in `package.json`.
- `npm run lint` therefore executes `next lint`, which **prompts interactively**
  ("How would you like to configure ESLint?") and exits non-zero.

Consequence: there is no lint debt to measure, because linting has never run.
Adding CI without first choosing a config would hang a CI runner on the prompt.
This changes the remediation shape — see `GAP_ANALYSIS.md` §G-02.

### 1.2 Build degrades correctly with no database

The build completed successfully against an empty database, logging
`no such table: pages` and `The table main.Plan does not exist` and falling back
to built-in copy. This substantiates the repository's "works with zero config"
design claim as **PASS** — the fallback path is real and exercised.

---

## 2. Stack — measured

| Layer | Actual | Notes |
| --- | --- | --- |
| Framework | Next.js **15.4.11** (App Router) | Last release in the 15.4.x line |
| UI | React **19.2.8**, React DOM 19.2.8, Tailwind 3.4 | |
| Language | TypeScript 5.7, `strict: true` | Typecheck clean |
| ORM | Prisma 6.19.3 (`@prisma/client` ^6.2.1) | |
| **Transactional DB** | **SQLite** (`provider = "sqlite"`) | Not PostgreSQL. See §4 |
| **Migrations** | **None** (`prisma/migrations/` absent) | `db push` only. See §4 |
| CMS | Payload **3.88.0**, in-process, **own SQLite database** | See `docs/architecture/CMS_ARCHITECTURE.md` |
| Auth | Custom: `jose` HS256 JWT in an httpOnly cookie, bcrypt cost 10 | |
| AI | Provider abstraction; Anthropic adapter + deterministic local engine | |
| Jobs | Provider abstraction; Adzuna adapter + mock | |
| Payments | Provider abstraction; Stripe + PayPal + manual + mock | |
| Cache | Abstraction: in-process map, optional Redis via `REDIS_URL` | `ioredis` deliberately not a dependency |
| Storage | Local filesystem under `STORAGE_ROOT` | Not object storage |
| Queue / workers | **None** | No scheduler, no background runner |
| CI | **None** — `.github/workflows/` absent | |
| Tests | `node --test` + `tsx`, 16 files, 7,668 lines | Unit/integration only; no E2E |

Scale: 252 tracked files, 154 `.ts`, 84 `.tsx`, ~23,850 lines in `src/lib`,
2,139-line Prisma schema, 27 pages, 49 API routes.

---

## 3. Data model — measured

68 Prisma models. Usage was measured by counting `db.<model>.`, `tx.<model>.`
and nested-write references across `src/`.

**33 models are referenced by application code. 34 are not.**

Unreferenced models fall into three distinct classes, and the distinction matters
because the remediation differs:

**Class A — designed, schema-complete, never wired (the notable ones):**

| Model | Why it matters |
| --- | --- |
| `Organization`, `Membership` | **Multi-tenancy is schema-only.** No code reads or writes either. The four-product vision depends entirely on this being real |
| `AgentSchedule` | Has `nextRunAt`, `lockedAt`, `lockedBy`, `autoAppliedCount` — a complete scheduler design with **no scheduler**. Nothing reads it |
| `WebhookEvent` | Exists for inbound webhook de-duplication. **The Stripe webhook handler does not use it** — see §5.2 |
| `ImpersonationSession` | Schema documents "impersonation must be read-only". No enforcement code exists |
| `DeletionRequest`, `EmailToken`, `EmailLog`, `EmailSuppression` | Privacy/erasure and email lifecycle designed but unimplemented |
| `Notification`, `NotificationPreference` | No notification delivery exists |
| `FeatureFlag`, `ExperimentAssignment` | No flag evaluation exists |
| `BillingProfile`, `PlanPrice`, `TaxRegistration`, `Refund`, `DunningState`, `CreditNoteLine`, `CreditLedgerEntry`, `Coupon`, `CouponRedemption`, `ReferralCode`, `Referral` | Commercial layer designed well beyond what is wired |

**Class B — written via nested relations (NOT dead):** `InvoiceLine`,
`InvoiceTaxLine`, `PaymentAllocation`, `DocumentSequence`, `TaxRate`. These are
reached through parent creates or `$transaction` blocks and are genuinely in use.

**Class C — reporting rollups, partially wired:** `DailyMetric`, `RollupRun`,
`DailyUsageRollup`, `DailyRevenueRollup`.

### 3.1 The domain is inverted relative to the product vision

Measured reference counts by domain:

- **Commercial/billing/CRM/integrations**: ~45 models, ~19,000 lines in `src/lib`.
- **Candidate job-search core**: 8 models (`User`, `Resume`, `Agent`, `Job`,
  `JobMatch`, `SavedJob`, `Application`, `InterviewPrep`), ~500 lines of service code.

The billing and back-office layer is markedly more mature than the product it
bills for. `Job` has only 3 code references. This is the single most important
structural observation in the audit and it drives the staging in
`MASTER_BUILD_PLAN.md`.

---

## 4. Database posture — measured

```prisma
datasource db { provider = "sqlite"; url = env("DATABASE_URL") }
```

- The transactional store is **SQLite**, not PostgreSQL.
- Payload's CMS store is a **second, separate SQLite file** (`PAYLOAD_DATABASE_URI`).
- **There are no migrations.** `prisma/migrations/` does not exist; the workflow
  is `prisma db push`, which is a schema-sync tool, not a versioned migration
  tool. There is no forward/rollback history and no way to reproduce a schema
  state deterministically.

A source comment says "For production, change `provider` to `postgresql`". That
is a manual, uncommitted step. Prisma's `provider` is not env-switchable, and
switching it without a migration baseline means the first production deploy has
no reproducible schema. This is `NOT VERIFIED` as production-ready and is
treated as a Stage 01 blocker.

---

## 5. Security posture — measured

### 5.1 What is genuinely strong (verified by reading the implementation)

| Control | Evidence | Status |
| --- | --- | --- |
| Password storage | bcrypt cost 10 (`src/lib/auth.ts`) | PASS |
| Production secret hygiene | `AUTH_SECRET` rejected by **value** if it equals the `.env.example` placeholder; throws in production | PASS |
| Secret separation | `PAYLOAD_SECRET` deliberately distinct from `AUTH_SECRET` | PASS |
| Staff console gate | Two independent locks (`STAFF_EMAILS` allowlist **and** `User.role`), fails closed, no wildcards, unknown role degrades to *least* privilege | PASS |
| API key storage | SHA-256 of the whole key, `timingSafeEqual` compare, prefix design prevents cross-key splicing, plaintext never re-displayed | PASS |
| Path traversal | `readFolderFile` applies `path.basename` + `path.resolve` + prefix containment | PASS |
| Stripe webhook authenticity | Signature verified via `constructWebhookEvent`; 500 on handler error so Stripe retries | PASS |
| Webhook SSRF | `validateWebhookUrl` blocks loopback/RFC1918/link-local/ULA; `redirect: 'error'` prevents signed-payload relay; residual DNS-rebinding gap is documented in-source | PARTIAL (honestly scoped) |
| Prompt injection | `interpolate` is single-pass and non-recursive; missing variables are a hard error | PASS |

This is above-average security engineering for a pre-production codebase and
**should be preserved, not rewritten**.

### 5.2 Verified weaknesses

| # | Finding | Evidence | Severity |
| --- | --- | --- | --- |
| S-01 | **No row-level security.** Tenant isolation is 63 hand-written `where: { userId }` clauses. One omission is a cross-account data leak, and nothing detects one | grep across `src/lib`; no RLS in schema or code | HIGH |
| S-02 | **No `middleware.ts`.** There is no edge/global auth gate; every route re-implements its own `requireUser()`. A new route that forgets it is public by default | `src/middleware.ts` absent | HIGH |
| S-03 | **Stripe webhook is not idempotent.** `WebhookEvent` exists for exactly this and is unreferenced. A replayed `checkout.session.completed` re-runs `activatePlan` | `src/app/(app)/api/webhooks/stripe/route.ts`; 0 refs to `db.webhookEvent` | HIGH |
| S-04 | **Sessions cannot be revoked.** The JWT is stateless with a 30-day expiry; logout only deletes the cookie. A stolen token stays valid for up to 30 days | `src/lib/auth.ts` | HIGH |
| S-05 | **No CSRF defence beyond `sameSite: 'lax'`.** Lax does not protect top-level `POST` from a form on another origin for all flows | `src/lib/auth.ts` cookie options | MEDIUM |
| S-06 | Unsanitised user input reaches a response header: `Content-Disposition: filename="${fileName}"` where `fileName` is `decodeURIComponent` of a URL segment | `api/applications/[id]/files/[name]/route.ts` | MEDIUM (runtime likely rejects CRLF — verify) |
| S-07 | **No MFA, no email verification, no account recovery, no device/session list, no OAuth.** All are required by the target and none exist | route inventory | HIGH (gap, not defect) |
| S-08 | Rate limiting is in-process only; ceiling multiplies by instance count | `src/lib/rate-limit.ts` (documented in-source) | MEDIUM |
| S-09 | **No sensitive-demographic segregation.** No EEO/self-identification fields exist yet — so there is no *defect*, but also no architecture to prevent them being added to `User` later | schema review | HIGH (design gap) |

---

## 6. Dependency security — measured, with a material correction

`npm audit` → **14 advisories: 1 low, 7 moderate, 6 high, 0 critical.**

| Package | Sev | Direct | Deployed? | Root cause |
| --- | --- | --- | --- | --- |
| `next` 15.4.11 | high | yes | **yes** | ~24 advisories: proxy/middleware bypass, SSRF via Server Actions, cache poisoning, CSP-nonce XSS, multiple DoS |
| `postcss` 8.4.31 | high | no | **build only** | Nested **inside `node_modules/next/`**. The project's own top-level `postcss` is **8.5.26 — already patched** |
| `sharp` 0.34.5 | high | no | **build only** | Nested inside `node_modules/next/`. Top-level `sharp` is **0.35.3 — already patched** |
| `deepmerge-ts` → `@prisma/config` → `prisma` | high | dev | no | Stack exhaustion; `fixAvailable: true`; dev CLI only |
| `esbuild` → `@esbuild-kit/*` → `drizzle-kit` → `@payloadcms/db-*` | moderate | no | **no** | GHSA-67mh-4wv8-2f99 affects the **esbuild dev server**, which is never run. Reaches us only through Payload's migration CLI |
| `dompurify` → `monaco-editor` | low/mod | no | admin only | Payload admin editor |

### 6.1 The correction to HANDOFF.md §7.1

`HANDOFF.md` states the Next pin exists because "`@payloadcms/next` required
`>=15.4.11`". The **actual** declared peer range, read from the installed package,
is:

```
next: ">=15.2.9 <15.3.0 || >=15.3.9 <15.4.0 || >=15.4.11 <15.5.0 || >=16.2.6 <17.0.0"
```

Three consequences the handoff did not draw, all verified against the npm registry:

1. **`next@15.4.11` is the final 15.4.x release.** There is no in-window patch.
   Staying in the 15.4 band means staying permanently unpatched.
2. **npm's suggested `next@15.5.25` is *outside* Payload's peer range** (15.5.x is
   excluded). `npm audit fix --force` would break the supported configuration.
   **Do not run it.**
3. **Payload 3.88.0 explicitly supports `next >=16.2.6 <17.0.0`,** and Next
   16.3.4 is published and sits outside the advisory range
   (`9.3.4-canary.0 – 16.3.0-preview.10`). **A sanctioned upgrade path exists
   today** and does not require changing Payload.

Also verified: `@payloadcms/next@latest` **is** 3.88.0 — the installed version is
current. Payload 4 exists only as `4.0.0-internal.*` prereleases and is not viable.

The remediation plan is `docs/adr/ADR-0017-dependency-remediation.md`.

---

## 7. Integration reality check

Classification per §24 of the audit brief. No integration was executed against a
live third-party service during this audit, and none was during the prior
engagement (`HANDOFF.md` §7.3 — corroborated by the absence of any recorded run).

| Integration | Classification | Evidence |
| --- | --- | --- |
| Anthropic | IMPLEMENTED-NOT-VALIDATED | Real SDK, JSON-schema-constrained, falls back to the local engine. Never run with a live key |
| Adzuna | IMPLEMENTED-NOT-VALIDATED | Real API client, documented endpoint, timeout, NOC inference. Never run against the live API |
| Stripe | IMPLEMENTED-NOT-VALIDATED | Real Checkout + verified webhook. **Revenue-critical and unproven.** Also not idempotent (S-03) |
| PayPal | IMPLEMENTED-NOT-VALIDATED | 816 lines, unexercised |
| Manual payments | IMPLEMENTED-NOT-VALIDATED | 603 lines, unit-tested only |
| Greenhouse / Lever (ATS submit) | IMPLEMENTED-NOT-VALIDATED | Requires an employer-issued credential nobody holds |
| Payload CMS | SANDBOX-VALIDATED | Admin renders; build exercises the fallback path |
| Redis cache | SANDBOX-VALIDATED | `HANDOFF.md` records a 206 ms → 0.389 ms measurement |
| Public API v1 | IMPLEMENTED-NOT-VALIDATED | Strong key handling; no external consumer |
| Outbound webhooks | IMPLEMENTED-NOT-VALIDATED | Delivery state machine + SSRF guard; **no worker runs it** |
| Email (Gmail / Graph) | NOT IMPLEMENTED | Required by target; absent |
| Calendar (Google / Graph) | NOT IMPLEMENTED | Required by target; absent |
| Object storage (S3) | NOT IMPLEMENTED | Local filesystem only |
| OAuth / SSO | NOT IMPLEMENTED | |
| WorkBC | NOT IMPLEMENTED | Correctly absent — no fake integration was found |
| Job Bank | NOT IMPLEMENTED | Correctly absent |

**No integration was found misrepresented as production-ready.** The repository
is honest about its mocks — a notable positive finding.

---

## 8. Auto-apply: current true state

The audit brief forbids implementing autonomous application. Measured state:

- `Agent.autoApply` and `Agent.autoApplyThreshold` exist in the schema.
- `src/components/agent-form.tsx` renders an **"Auto-apply above N%" toggle**.
- `src/lib/services/scanner.ts:126` uses the threshold **only to increment a
  counter** (`aboveThreshold`). It never applies.
- `AgentSchedule` — the model that would drive unattended runs — has **zero code
  references**. No scheduler, cron, or worker exists.
- `applyToJobs` is reachable only from `POST /api/apply`, an authenticated,
  rate-limited, user-initiated route.

**Conclusion: nothing applies autonomously today. The safety posture is correct.**

However, this is a **product-integrity defect**: the UI offers a control that
does nothing. A user can enable "Auto-apply above 85%" and reasonably believe
applications will be sent. This must be resolved — by disabling the control or
labelling it as forthcoming — and is tracked as G-11. It is a UI change, not the
implementation of auto-apply.

---

## 9. Generated files and line endings (§23)

Measured:

- **No `.gitattributes` exists.** `core.autocrlf` and `core.eol` are unset in this
  container. Git for Windows commonly defaults `core.autocrlf=true`.
- `src/app/(payload)/admin/importMap.js` is tracked, pure-LF ASCII, 54 lines,
  and carries Payload's generator marker `/** @type import('payload').ImportMap */`.
- Its content is fully derived from `src/payload.config.ts`. The config registers
  exactly one custom component (`afterNavLinks: ['@/cms/components/CrmLauncher']`),
  exactly one custom component exists on disk (`src/cms/components/CrmLauncher.tsx`),
  and the map contains exactly one non-package entry
  (`"@/cms/components/CrmLauncher#default"`). **The committed file is in sync.**
- **A full `npm run build` did not modify it.** Verified: `git diff` empty and
  mtime unchanged after a successful build.
- `src/payload-types.ts` is a second generated artifact (`typescript.outputFile`).

**Determination:** `importMap.js` is machine-generated, currently correct, and not
regenerated by `next build`. A working-tree modification on a Windows checkout is
therefore **generated output or line-ending normalisation, not a functional
change** — consistent with the earlier repository-control finding. The missing
`.gitattributes` is the root cause of the recurring-dirty-tree risk and is
addressed by `ADR-0014`.

---

## 10. Capability status summary

| Capability | Status | Note |
| --- | --- | --- |
| Email/password auth, sessions | PASS | Solid, but no revocation |
| Email verification, MFA, recovery, OAuth | NOT IMPLEMENTED | |
| Candidate profile | PARTIAL | ~12 fields on `User`; target requires ~40 structured entities |
| Career Evidence Vault | NOT IMPLEMENTED | No evidence model exists; AI grounding is unenforced |
| Application question bank | NOT IMPLEMENTED | |
| Sensitive-demographic isolation | NOT IMPLEMENTED | |
| Job search / agents | PARTIAL | Works against mock; Adzuna unvalidated |
| Job normalisation / dedup / freshness | PARTIAL | `Job` model is thin; no canonical hash, no `closed_at` lifecycle |
| Eligibility engine | NOT IMPLEMENTED | Distinct from scoring; does not exist |
| Compatibility scoring | PARTIAL | Deterministic keyword engine exists and is explainable — a genuine asset |
| Interview probability | NOT IMPLEMENTED | Correctly absent |
| Resume / cover letter | PARTIAL | Text + PDF; no DOCX, no version history |
| Job Folder | PARTIAL | Filesystem artefact exists; ~15 of ~30 target fields |
| Email/calendar intelligence | NOT IMPLEMENTED | |
| Candidate analytics | PARTIAL | Rich revenue analytics; thin candidate-outcome analytics |
| Corporate / Talent OS | NOT IMPLEMENTED | |
| Staffing / Placement OS | NOT IMPLEMENTED | |
| Employment Services / WorkBC OS | NOT IMPLEMENTED | |
| Career Change / Learning OS | PARTIAL | CMS collections only (`LearningPaths`, `Certifications`, `CareerGuides`) — content, no engine |
| Payments / entitlements | PARTIAL | Deep invoicing; entitlement is quota-only; Stripe unvalidated |
| Multi-tenancy | NOT IMPLEMENTED | Models exist, zero code |
| Admin operating system | PARTIAL | `/console` CRM + Payload admin; no platform admin |
| Background processing | NOT IMPLEMENTED | No queue, no worker, no scheduler |
| Reporting architecture | PARTIAL | Rollup models + revenue analytics; no separation from transactional load |
| Mobile | NOT IMPLEMENTED | |
| CI/CD | NOT IMPLEMENTED | |

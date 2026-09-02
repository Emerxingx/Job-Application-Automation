# CLAUDE.md — Working guidance for this repository

Read this before changing anything. It records how this codebase actually
behaves, not how it appears to behave.

## What this is
Today: **JobPilot AI**, a Next.js job-application product for the Canadian and US
markets.
Target: a **Career & Employment Intelligence Operating System** — four products
on one governed platform core. See `docs/product/PRODUCT_VISION.md`.

The architecture baseline is in `docs/`. **It is proposed, not approved. No
remediation has begun.**

## Start here
| You want | Read |
| --- | --- |
| Measured state of the code | `docs/programme/CURRENT_BASELINE.md` |
| What is missing and why | `docs/programme/GAP_ANALYSIS.md` |
| What to build, in order | `docs/programme/MASTER_BUILD_PLAN.md` |
| Why a decision was made | `docs/adr/` |
| Prior engineering handoff | `HANDOFF.md` |

## Commands
```bash
npm ci                # install from the lockfile
npm run dev           # http://localhost:3000
npx tsc --noEmit      # typecheck  — PASSES
npm test              # 670 tests  — PASSES
npm run build         # production — PASSES
npm run lint          # eslint directly — 0 errors, 2 warnings (baseline)
npm run lint:ci       # blocking variant: --max-warnings=2
npm run verify        # lint:ci + typecheck + test + build (the CI gate set)
npm run db:push       # schema sync (NOT migrations — none exist)
npm run db:seed       # plans + demo account
npm run cms:importmap # regenerate the tracked Payload import map
npm run cms:types     # regenerate payload-types.ts
```

## Things that will surprise you

1. **The database is SQLite, and there are no migrations.** `prisma/migrations/`
   does not exist; the workflow is `db push`. A comment says to switch the
   provider for production — Prisma's `provider` is not env-switchable, so that
   is an unversioned manual edit. `ADR-0002` replaces this.

2. **ESLint was never installed until Stage 00.** `next.config.mjs` still sets
   `eslint: { ignoreDuringBuilds: true }` — a leftover that is now redundant,
   since CI lints separately. Lint is configured as **flat config invoking
   `eslint` directly**, never `next lint` (deprecated in Next 15, removed in
   16). Baseline is **0 errors, 2 warnings**, locked by `--max-warnings=2`. The
   one rule exemption — `no-require-imports` for `src/lib/providers/**` — is the
   deliberate lazy-`require` pattern, not debt. See
   `docs/programme/LINT_BASELINE.md`.

3. **34 of 68 Prisma models have no application code references.** Some are
   nested-write models genuinely in use (`InvoiceLine`, `PaymentAllocation`,
   `DocumentSequence`). Most are designed-but-unwired — including
   `Organization`, `Membership` (multi-tenancy is schema-only), `AgentSchedule`
   (a complete scheduler with no scheduler), and `WebhookEvent` (idempotency
   that is never applied). Check before assuming a model does something.

4. **Nothing applies autonomously, and the UI now says so.** `scanner.ts` reads
   `autoApplyThreshold` only to increment a counter, and no scheduler exists
   (`AgentSchedule` has no code that reads it). Stage 00 disabled the auto-apply
   control and corrected the README. **Do not re-enable it** — autonomous
   submission is Stage 22 and is gated on lawfulness review plus an explicit
   founder decision (`ADR-0016`).

5. **There are two databases.** Prisma owns transactional data; Payload owns
   content, in its **own** database (`PAYLOAD_DATABASE_URI`). Deliberate.
   Nothing in the CMS reads or writes a Prisma table. Keep it that way.

6. **Tenant isolation is 63 hand-written `where: { userId }` clauses.** No RLS,
   no test. Omitting one is a cross-account leak. Until `ADR-0005` lands,
   **check the filter on every query you write.**

7. **`npm run cms:*` temporarily rewrites `package.json`.** `scripts/payload-cli.mjs`
   flips `"type": "module"` for the duration of the call and restores it, including
   on Ctrl-C. If a crash leaves it set, `git checkout package.json`.

8. **No integration has been validated against a live service.** Stripe, Adzuna,
   Anthropic, PayPal and ATS submission are all `IMPLEMENTED-NOT-VALIDATED`.
   Code existing is not evidence of working.

## Conventions worth preserving

- **The provider pattern** (`src/lib/providers/`): interface, mock default, lazy
  `require` of real adapters, warn-and-degrade on missing credentials. This is
  why a clean clone boots with no configuration. Extend it; do not replace it.
- **Two error envelopes, deliberately.** Internal routes return
  `{ error: string }`. `/api/v1` returns `{ error: { type, code, message, param } }`
  because a third-party client cannot branch on English. Do not unify them.
- **No CORS on `/api/v1`, deliberately.** An API key is a bearer credential and
  must never reach browser JavaScript.
- **The console two-lock gate**: `STAFF_EMAILS` allowlist **and** `User.role`,
  failing closed, unknown role degrading to the *weakest* staff level. Reuse this
  pattern for any new admin surface.
- **Scrub-in-place erasure.** Personal data is nulled; invoices, payments and
  audit rows are retained and carry their own bill-to snapshot.
- **In-source commentary explains *why*.** Match that standard.

## Hard rules

1. **Never claim a mock is production.** Update
   `docs/governance/INTEGRATION_REGISTER.md` instead.
2. **No autonomous application submission** (`ADR-0016`).
3. **No unlawful data acquisition** — no CAPTCHA bypass, no access-control
   circumvention, no fingerprint evasion (`docs/governance/SOURCE_ACCESS_POLICY.md`).
4. **No sensitive demographic attribute may reach a matching, scoring, ranking or
   recommendation path** (`ADR-0007`).
5. **Never skip, disable or delete a test to get a green run.** A failing test is
   a finding.
6. **Never run `npm audit fix --force`.** It installs `next@15.5.25`, which is
   outside Payload's peer range. Follow `ADR-0017`.
7. `importMap.js` and `payload-types.ts` are **generated**. Regenerate them; never
   hand-edit.

## Dependency constraint you must know
`@payloadcms/next@3.88.0` declares:
```
next: ">=15.2.9 <15.3.0 || >=15.3.9 <15.4.0 || >=15.4.11 <15.5.0 || >=16.2.6 <17.0.0"
```
Installed: `next@15.4.11` — the **last** 15.4.x release, so there is no in-band
patch. The supported upgrade target is **16.2.6+** (Payload already allows it).
**Check this range before any Next upgrade.**

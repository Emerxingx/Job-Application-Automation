# JobPilot AI — Engineering Handoff & Audit Pack

**Prepared for:** independent technical audit
**Repository:** `Emerxingx/Job-Application-Automation`
**Default branch:** `main` · **Feature branch:** `claude/job-automation-platform-58ufhj` (identical content)
**Document date:** 2026-09-02
**Build state at handoff:** `tsc --noEmit` clean · 670/670 tests pass · `next build` exits 0

---

## 0. How to read this document

This is written for an auditor who has **no prior context** and no reason to trust
the claims in it. Every "verified" statement below names the command that produced
the evidence, so you can re-run it. Section 7 is the important one: it lists what
was **not** verified, where the risk is, and which claims you should treat as
unproven. Section 8 lists decisions that look like bugs but are deliberate — read
it before filing findings, then disagree with it if you think it is wrong.

Two honesty notes up front, because they affect how much weight to give the rest:

- The developer of this codebase was an AI assistant (Claude) working in a remote
  sandbox across a single extended engagement. All code, tests and documentation
  were authored there.
- During this engagement at least one fix was announced as working and then
  disproven by the author's own re-testing (§6.1). The verification discipline in
  §5 exists because of that, not in spite of it. Treat any claim here that does
  **not** name a command as unverified.

---

## 1. What the product is

An AI job-application automation platform for the Canada/US market, positioned
against AIApply.co. A job seeker configures "agents" (saved searches), the system
scans job sources, scores each posting against their résumé, tailors a résumé and
cover letter per application, and either submits through an authorised ATS API or
prepares an assisted application for the applicant to confirm. Around that sits a
subscription business: tiered plans with application quotas, invoicing, payments,
a staff CRM/console, a headless CMS, and a public API.

---

## 2. Repository and access facts

| Item | Value |
| --- | --- |
| Tracked files | 251 |
| TypeScript/TSX lines | 55,183 |
| Commits | 13 |
| Test files | 16 |
| Prisma models | 67 |
| App pages | 26 |
| API route handlers | 49 |
| Routes emitted by `next build` | 79 |
| CMS collections + globals | 14 |

**Commit map** (all on `main`; `claude/…-58ufhj` is content-identical):

| Commit | Date | Subject |
| --- | --- | --- |
| `8f1a1ea` | 2026-08-05 | Initial commit (README only) |
| `4b2953a` | 2026-08-12 | Build JobPilot AI: automated job application platform |
| `1184b4f` | 2026-08-13 | Add live job data, apply engine and Stripe billing |
| `c7341e1` | 2026-08-13 | Add test suite, rate limiting and deployment hardening |
| `bf86d71` | 2026-08-14 | Add headless CMS (Payload) |
| `e08e375` | 2026-08-14 | Add pdfkit, date-fns, recharts |
| `cd7c232` | 2026-08-14 | Add the commercial platform layer |
| `c4e6c6b` | 2026-08-14 | Make the dashboard layout editable from the CMS |
| `d8f79da` | 2026-08-14 | Automation-platform CMS: ATS rulesets, prompts, field mappings, SEO |
| `60ae754` | 2026-08-14 | Subscription management in the client dashboard + CRM launcher |
| `25b2743` | 2026-08-14 | Update package-lock.json *(authored by the repo owner, not the AI)* |
| `262c5da` | 2026-08-14 | Make ioredis genuinely optional so a clean install boots |
| `ead9eb9` | 2026-08-14 | Document STAFF_EMAILS in .env.example |

**Provenance caveat for the auditor.** The sandbox's own git credential had read
but not write access to GitHub (HTTPS `403` on every `git push`; the egress proxy
recorded zero relay failures, confirming GitHub rejected the write rather than the
network). Later commits were therefore pushed through the GitHub API rather than
`git push`. Consequences you should be aware of:

- API-created commits are attributed to the repo owner's GitHub account, so **git
  authorship does not distinguish AI-authored from human-authored commits.** The
  table above marks the one commit (`25b2743`) that the owner actually authored.
- Commits `39fbe4e` and `088c57e` on `main` carry the same content as `262c5da`
  and `ead9eb9` on the feature branch; the SHAs differ because they were created
  through separate API calls.

---

## 3. Requirements as received

Recorded in the order the client gave them, because the architecture is legible
only against this sequence. Requirements 5–8 arrived after the core was built and
drove significant re-work.

1. **Core platform.** Job agents; live job scanning with match scoring; AI résumé
   and cover-letter tailoring; per-application folders; monthly/quarterly/annual
   subscriptions with tiered application quotas; live scraping with success-%
   display; bulk apply; interview prep; polished UI/UX; mobile-app-ready;
   architecture scalable to future modules (Learning Paths, Change Your Career,
   Certifications by NOC code).
2. **Autonomy.** "keep building" — proceed through remaining scope without
   check-ins.
3. **Get it onto GitHub.**
4. **Commercial platform parity with AIApply.co**, explicitly: "better architecture
   backend, UI/UX and fully editable CMS with complete database, reporting
   dashboards, downloadable reports, CRM, invoicing, payment gateways,
   integrations and other requirement that are applicable to similar commercial
   platforms."
5. **Headless CMS with full capability and expansion.** Client selected Payload
   over Strapi and scoped it as "Everything, build it for full expansion now."
6. **CMS must reflect the real site layout.** Client rejected a marketing-only CMS
   and chose, from the options offered, "Real drag-and-drop layout editing of app
   pages" — the highest-risk option, selected after the risk was stated once.
7. **Staff System Architect brief.** Four named CMS collections (ATS Selectors &
   Rulesets, AI Prompt Registry, Universal Form/Q&A Field Mapping, Content & SEO);
   a Payload-vs-Strapi stack recommendation; a Redis-cached fast-read API with a
   sub-10ms target; a prompt-interpolation engine with variable validation.
8. **Client Management Dashboard**, verbatim: "Manage all your clients from one
   centralized dashboard. Track usage, manage subscriptions, and monitor success
   metrics." Client chose it "reachable from /admin".
9. **Run it locally** — the closing thread of the engagement (§6).

**Standing constraint set by the client throughout:** every claim of "done" must be
independently verified before being reported, and every push confirmed against the
remote rather than assumed.

---

## 4. Architecture as built

**Stack.** Next.js 15.4.11 (App Router) · TypeScript · Prisma 6 · SQLite in dev,
Postgres-ready · Tailwind · Payload CMS 3.88.0 running natively inside the same
Next app · Node 22.

### 4.1 The two-database decision

Prisma and Payload own **separate databases** (`DATABASE_URL` vs
`PAYLOAD_DATABASE_URI`). Prisma owns transactional and billing data; Payload owns
editorial content. Nothing in the CMS reads or writes a Prisma table.

The load-bearing consequence: **plan prices, quotas and features live in Prisma,
not the CMS.** The CMS `pricing-copy` global holds only surrounding marketing
prose. This is deliberate — if amounts lived in both places a content edit could
silently disagree with what a customer is charged. **Auditor: verify this boundary
holds.** It is the single most important invariant in the codebase.

### 4.2 Provider abstraction

Every external dependency is pluggable and falls back to a mock, so the app runs
with zero credentials:

| Domain | Implementations | Selected by |
| --- | --- | --- |
| Jobs | `mock`, `adzuna` | `JOB_PROVIDER` + Adzuna keys |
| AI | `mock` (local keyword scoring), `anthropic` | `AI_PROVIDER` + `ANTHROPIC_API_KEY` |
| Payments | `manual`, `stripe`, `paypal` | `PAYMENT_PROVIDER` + keys |
| Apply | `mock`, `assisted`, `auto` (Greenhouse/Lever ATS) | `APPLY_MODE` + per-employer ATS creds |
| Cache | in-memory map, Redis | presence of `REDIS_URL` |

### 4.3 Security model

- **Job-seeker sessions** — `jose` JWTs signed with `AUTH_SECRET`; the committed
  default is rejected by value in production (`src/lib/auth.ts`).
- **CMS editor sessions** — `PAYLOAD_SECRET`, a deliberately *separate* guard with
  near-identical logic (`src/lib/cms-secret.ts`), so one leaked key cannot
  compromise both systems. Both guards intentionally do not fire during
  `next build` so CI can build without runtime secrets.
- **Staff console** (`/console`) — `authorizeStaff()` in `src/lib/crm/auth.ts`.
  Allowlist (`STAFF_EMAILS`) **plus** a role ladder (`support < billing_ops <
  admin`). **Fails closed**: unset allowlist denies everyone, including admins.
  The database `role` column is explicitly *not* the gate — there is a test named
  for this. Denial messages are identical across reasons so a prober cannot map
  the org chart.
- **Server Actions repeat the gate themselves**, because Next.js layouts do not
  run for actions. **Auditor: this is a classic bypass vector — verify every
  action in `src/app/(app)/console/**/actions.ts` calls the gate.**
- **Audit log** — append-only `AuditLog` with before/after JSON snapshots and a
  mandatory written reason (min 12 chars) on every staff mutation.
- **Public API** — `v1Route(scope, handler)` wrapper: API-key auth + scope check +
  rate limit.

### 4.4 Prompt-injection surface

`src/lib/prompt-interpolate.ts` is deliberately split from the registry read path (Stage 03: `src/lib/ai/prompt-registry.ts`; the former `prompt-engine.ts` is deleted) so
the security-critical logic is unit-testable without Payload. Two properties are
asserted by tests: substitution is **single-pass and non-recursive** (an injected
`{{placeholder}}` inside a value is not re-expanded, so one variable cannot leak
another), and a missing declared variable is a **hard error**, never silently sent
to the model as a literal placeholder. **Auditor: this is a high-value area.
CMS-editable prompts mean a CMS editor is, in effect, a privileged actor.**

---

## 5. Verification performed

All commands run in the sandbox on 2026-09-02 against `ead9eb9`, Node v22.22.2,
npm 10.9.7.

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | exit 0, no output |
| Tests | `npm test` | **670 pass / 0 fail**, 158 suites |
| Tests under hostile env | `STAFF_EMAILS=… npm test` | 670 pass / 0 fail |
| Production build | `npm run build` | exit 0, 79 routes |
| Clean-clone boot | fresh `.env`, no DB → `db:push`, `db:seed`, `dev` | `/`, `/login`, `/admin` = 200 |
| Real auth | `POST /api/auth/login` (demo account) | 200; `/dashboard` 200 with session cookie |
| Staff gate, positive | `STAFF_EMAILS` set, demo session | `/console`, `/console/customers` = 200 |
| Staff gate, negative | `STAFF_EMAILS` unset | `/console` redirects away |
| Optional-dep boot | `ioredis` removed from `node_modules` | build + dev clean, 0 resolve errors |
| Redis path | `ioredis` present, `REDIS_URL` set | `getCache().backend === 'redis'` |
| Cache benchmark | fast-read path | 206 ms (DB) → 0.389 ms (cached) |

**What "verified" means here:** the command was executed and its real output
observed. It does **not** mean the behaviour is correct for all inputs, that the
tests assert the right things, or that the feature is fit for production.

---

## 6. Defects found and fixed during this engagement

Included because the failure modes are instructive and the same classes may exist
elsewhere in the codebase.

### 6.1 `ioredis` broke every route on a clean install

**Symptom.** A fresh `npm install` produced a tree without `ioredis`; the app then
failed to compile entirely — `Module not found: Can't resolve 'ioredis'` at
`src/lib/cache/index.ts:77`. Because that module sits under `payload.config.ts` in
the import graph, and `payload.config.ts` is imported by a root layout, **every
route broke, not just the cache.**

**Two independent root causes:**

1. `package-lock.json` listed `ioredis` as a root dependency while `package.json`
   did not — a leftover from adding the Redis backend, silently reverted when the
   Payload ESM-toggle wrapper restored `package.json` via `git checkout`. Result:
   `npm ci` installed it, `npm install` pruned it. **Whether the app built
   depended on which npm command you last ran.**
2. The `require('ioredis')` was not lazy in the way its own comment claimed.
   Bundlers trace a literal `require()` string at compile time regardless of any
   runtime guard around it, so a dependency that was optional by design became a
   hard build-time requirement for every install.

**A fix was announced and was wrong.** Adding `'ioredis'` to
`serverExternalPackages` in `next.config.mjs` was reported as the fix. Re-testing
under a faithful repro (package physically removed, `.next` cleared, fresh dev
server) showed the identical error persisted. That change was reverted. **The
lesson generalises: `serverExternalPackages` does not make a package optional at
build time.**

**Actual fix** (`262c5da`): resolve through Node's own loader with a specifier
assembled at runtime, keeping the module out of the bundler's graph entirely, and
raise a runtime error naming the remedy when `REDIS_URL` is set but the package is
absent. Lockfile reconciled to `package.json`.

### 6.2 `/console` was unreachable and undiagnosable

`STAFF_EMAILS` gates the entire Client Management Dashboard and **fails closed**,
but the variable was documented nowhere — not in `.env.example`. A fresh clone
therefore rendered a silent redirect indistinguishable from a bug. Fixed in
`ead9eb9` by documenting it against the seeded demo account. **The security
behaviour was correct; the discoverability was the defect.**

### 6.3 A test passed only by accident (found while preparing this document)

`tests/crm.test.ts` → *"REFUSES EVERYONE when STAFF_EMAILS is unset"* called
`authorizeStaff(candidate, 'support', undefined)`. In JavaScript, passing
`undefined` to a parameter with a default **triggers** the default — so the test
read `process.env.STAFF_EMAILS` from the ambient environment rather than testing
the unset case. It passed only because no developer's environment happened to set
that variable.

Fixing §6.2 set it, and the test began failing (669/670). It is now hermetic
(`delete process.env.STAFF_EMAILS`, restored by the existing `afterEach`), and
passes both with and without the variable set.

**Auditor: treat this as a sampling signal, not a closed item.** One
environment-dependent test was found by accident. The suite has not been audited
for others. Run it on a machine with a fully-populated `.env` and again with an
empty one, and compare.

---

## 7. Known gaps, risks, and unverified claims

**This is the section to read first.** Ordered by my assessment of severity.

### 7.1 Dependency vulnerabilities — 14 advisories, 6 high

`npm audit` at handoff: **1 low, 7 moderate, 6 high, 0 critical.**

The dominant one is **Next.js 15.4.11**, which carries ~24 advisories including
middleware/proxy authorisation bypasses, cache poisoning, SSRF via Server Actions,
XSS, and multiple DoS vectors. Several are directly relevant to this app, which
uses App Router, Server Actions and middleware-style gating.

**This version is pinned deliberately**: `@payloadcms/next` required
`>=15.4.11`, and the pin exists to keep Payload working. Upgrading Next is
therefore **not** a one-line change — it needs a Payload compatibility check.
Others: `sharp`/libvips CVEs, `postcss` path traversal, `deepmerge-ts` stack
exhaustion, `@prisma/config`, `prisma`.

**Recommendation: treat this as the top pre-production blocker.** No upgrade was
attempted during this engagement.

### 7.2 No CI, no lint enforcement, no E2E suite in the repo

- **No CI configuration exists** (`.github/workflows` absent). Nothing runs the
  tests on push. Every verification in §5 was run by hand.
- **`next.config.mjs` sets `eslint: { ignoreDuringBuilds: true }` and no ESLint
  config file is committed.** Linting is effectively off.
- **No E2E tests are committed.** Browser checks during development were ad hoc
  (Playwright/curl in the sandbox) and are not reproducible from the repo. The
  16 test files are unit/integration level.

### 7.3 Nothing has run against real third-party services

Every provider was exercised **only through its mock**. Specifically unverified:

- **Stripe** — no live key was ever configured. Checkout, the webhook handler,
  signature verification, and the subscription-activation path are **untested
  against real Stripe.** The webhook is the component that actually activates a
  subscription, so this is revenue-critical and unproven.
- **PayPal** — same.
- **Adzuna** — live job sourcing never run against the real API.
- **Anthropic** — real résumé tailoring, match scoring and interview prep never
  run against a live key; all AI output seen to date came from the mock provider.
- **Greenhouse/Lever ATS submission** — never exercised against a real board.

### 7.4 Scale and durability limits (documented in DEPLOYMENT.md)

- **Rate limiting is per-instance**, in process memory. With N instances the
  effective ceiling is N × the configured limit. Not a shared store.
- **Application folders and CMS media are written to local disk.** On a serverless
  host they vanish. Partially mitigated — tailored résumé, cover letter and job
  description are also DB columns and the UI falls back to them — but generated
  `README.md` / `tailoring-report.md` are lost.
- **Scans are synchronous.** A user with many agents waits for the whole fan-out;
  no queue.
- **SQLite in dev**, Postgres requires a one-line `provider` edit in
  `prisma/schema.prisma` (Prisma rejects `env()` for that field).

### 7.5 Not assessed at all

No work was done on, and no claim is made about: **accessibility** (WCAG), **load
or performance testing** beyond the single cache benchmark, **penetration testing**,
**legal/compliance review** (PIPEDA and US state privacy law for handling résumé
PII; job-board Terms of Service for automated access), **backup/restore
procedures**, **observability/alerting**, or **disaster recovery**. The 67-model
Prisma schema has not been reviewed for index coverage or query performance under
realistic data volumes.

### 7.6 Product claims not substantiated

Requirement 1 asked for "live scraping with success-% display." A success
percentage is **computed and displayed**, but it has never been calibrated against
real submission outcomes, because no real submissions have occurred (§7.3). An
auditor should determine whether the displayed figure is defensible to end users
or whether it currently amounts to a mock-derived number in a customer-facing
surface. **I consider this the most likely place for the product to mislead a
paying user, and I flag it as the finding I would most want a second opinion on.**

### 7.7 Windows was never tested

All verification ran on Linux (Node 22). The client's environment is Windows +
Git Bash. Local-dev friction encountered there is documented in §9.

---

## 8. Deliberate decisions that may look like defects

Read before filing findings. Each was a considered trade-off; disagree on the
merits if you think the call was wrong.

1. **The app never auto-submits to major job boards.** `APPLY_MODE=auto` submits
   only through an ATS API where the *employer* has issued a credential
   (`ATS_GREENHOUSE_<BOARD>`, `ATS_LEVER_<BOARD>`). Without one it behaves exactly
   like `assisted`. Reason: the major boards prohibit automated submission and
   enforce it against the **applicant's** account, so the engine does not drive
   their forms. This is a deliberate product limitation with a user-protection
   rationale, not missing functionality.
2. **`/console` denies everyone when `STAFF_EMAILS` is unset** — including admins.
   Fail-closed by design (§6.2).
3. **Pricing is not editable in the CMS** (§4.1).
4. **Two secrets, two near-identical guards** (`AUTH_SECRET`, `PAYLOAD_SECRET`).
   The duplication is intentional; a shared validator that accepted either
   placeholder would let one leak compromise both systems.
5. **The CMS controls layout, never behaviour.** CMS blocks decide which widgets
   render, in what order, with what copy — never what a widget *does*. Auth, data
   loading and business logic live in the page shell, structurally out of CMS
   reach. This is what made requirement 6 safe to build.
6. **`ioredis` is not in `package.json`** (§6.1). Install it only where
   `REDIS_URL` is set.
7. **`scripts/payload-cli.mjs` temporarily toggles `"type": "module"`.** Payload's
   CLI needs ESM; the app builds correctly as CommonJS. The wrapper restores
   `package.json` afterwards, including on failure. Converting the whole project
   to ESM to satisfy a codegen tool would have meant rewriting the lazy `require()`
   provider loads for no runtime benefit. *(Note: this mechanism is what caused
   §6.1's lockfile drift — a real cost of the trade-off.)*

---

## 9. Reproducing the build

```bash
git clone https://github.com/Emerxingx/Job-Application-Automation
cd Job-Application-Automation
cp .env.example .env      # runs fully on mocks; no third-party keys needed
npm install
npm run db:push           # creates the SQLite schema (*.db is gitignored)
npm run db:seed           # seeds 3 plans + demo account
npm run dev
```

Then `http://localhost:3000`, sign in as **`demo@jobpilot.ai` / `demo1234`**.

| Surface | Path |
| --- | --- |
| Marketing site | `/` |
| Job-seeker app | `/dashboard` |
| Staff CRM | `/console` (requires `STAFF_EMAILS`) |
| CMS admin | `/admin` (prompts to create the first editor) |
| CMS REST / GraphQL | `/api/cms/*`, `/api/cms/graphql` |

Verification: `npm run check` (types + tests), `npm run build`.

The CMS is mounted at `/api/cms` rather than Payload's default `/api` so its
catch-all cannot shadow the app's own endpoints — verified: `/api/apply` returns
401, not a CMS 404.

---

## 10. Suggested audit focus, in priority order

1. **Dependency CVEs (§7.1)** — establish real exploitability of the Next.js
   advisories against this app's middleware/Server Action usage, and whether
   Payload permits an upgrade.
2. **Authorisation completeness (§4.3)** — every Server Action independently
   re-gated; no `/console` or `/api/console` path reachable without
   `authorizeStaff`; the `role` column genuinely not a gate.
3. **The billing/CMS boundary (§4.1)** — prove no CMS-authored value can influence
   a charged amount.
4. **Prompt-injection surface (§4.4)** — CMS editors are privileged actors over the
   AI pipeline.
5. **Stripe webhook correctness (§7.3)** — untested against real Stripe and
   revenue-critical.
6. **Test-suite integrity (§6.3)** — one accidental pass was found; assume others.
7. **The success-% claim (§7.6)** — customer-facing, uncalibrated.

---

## 11. Open items

Carried forward, not done:

- No PR is open; `main` and the feature branch are in sync.
- Live credentials never wired (Anthropic, Adzuna, Stripe).
- Never deployed to a real host; `DEPLOYMENT.md` is written but unexecuted.
- No email adapter — Payload editor password-reset emails go to the server console.
- Future modules named in requirement 1 (Learning Paths, Change Your Career,
  Certifications by NOC code) have **CMS collections but no application-side
  features**.

---

## 12. Document provenance

Assembled 2026-09-02 from the live repository at `ead9eb9`. Every figure in §2 and
§5 came from a command run against that commit at that time, not from memory or
from earlier runs in the engagement. Defect §6.3 was discovered *while* preparing
this document, by re-running the suite rather than citing a previous result — which
is the argument for doing it that way.

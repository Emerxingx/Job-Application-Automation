# Risk Register

Scored **Likelihood × Impact** (1–5). Owner is the stage that closes it.

## Critical (score ≥ 16)

| ID | Risk | L | I | S | Mitigation | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | **Cross-tenant data leak.** Isolation was 63 hand-written filters. **Reduced in Stage 01**: RLS policies on every table (`ENABLE`+`FORCE`, generated from a committed classification), transaction-scoped context, and a negative suite through the real Prisma client with filters removed (`tests/tenancy-isolation.test.ts`). Residual: handlers not yet on the tenant path rely on their filter alone (R-35), and the proof has not run through the staging project's pooler (R-34) | 2 | 5 | 10 | Complete tenant-path adoption; run the suite against Supavisor once reachable | 02 |
| R-02 | **AI fabricates candidate facts.** No evidence grounding exists. A fabricated claim on a submitted résumé is a career-damaging, trust-destroying failure | 4 | 5 | 20 | Career Evidence Vault; generation accepts evidence refs only; truthfulness suite | 03 |
| R-03 | **Deployed Next.js advisories.** Proxy/middleware bypass, SSRF, cache poisoning, XSS, DoS on a version with no in-band patch | 4 | 5 | 20 | Upgrade to 16.2.6+, inside Payload's peer range. **Never `audit fix --force`** | 01 |
| R-04 | ~~**No migrations + SQLite.**~~ **CLOSED in Stage 01** — PostgreSQL provider, three-migration history baselined from the existing schema, CI applies it to an empty database and fails on drift; procedure and recovery in `../operations/DATABASE_MIGRATIONS.md`. Residual: the staging rehearsal and a restore rehearsal are outstanding (R-34, Stage 23) | — | — | — | Done | 01 |

## High (10–15)

| ID | Risk | L | I | S | Mitigation | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| R-05 | ~~**Sensitive demographics influence outcomes.**~~ **CLOSED in Stage 02** — the fields now exist ONLY in the `sensitive` schema with no Prisma model, a separate role, own-row RLS and audited access; a static test fails if any decision-path module references them, and a payload test proves the AI projection carries none. Residual: a future field added to a public table would bypass this — the classification rule (`DATA_CLASSIFICATION.md`) and review are the guard | — | — | — | Done | 02 |
| R-06 | **Stripe unvalidated.** Revenue-critical path never run live. **Idempotency AND ordering now closed in Stage 01** (`webhook-events.ts`, 12 tests); live validation still outstanding | 4 | 3 | 12 | Live test-mode E2E | 15 |
| R-07 | ~~**Session theft persists 30 days.**~~ **CLOSED in Stage 01** — sessions are rows; logout, password change and the account holder's own revoke take effect on the next request, with no cache (a staff-initiated revoke is a Stage 20 console function — the reason code exists, no caller does yet). A pre-Stage-01 token (no `sid`) is refused outright. Residual: the edge gate still checks only the signature, by design | — | — | — | Done | 01 |
| R-08 | ~~**New route ships unauthenticated.**~~ **CLOSED in Stage 01** — `src/proxy.ts` (Next 16's middleware convention) denies by default; 9 negative tests including a lookalike-prefix test that caught a real fail-open bug (`/administrative-reports` matched `/admin`) | — | — | — | Done | 01 |
| R-09 | **Silent job loss.** No queue; two designed schedulers have no runner. In an automation product, silent loss destroys trust faster than an outage | 4 | 4 | 16 | Outbox + lease workers + dead-letter + admin visibility | 01/05 |
| R-10 | **Unlawful acquisition.** Commercial pressure to scrape prohibited sources | 3 | 5 | 15 | `SOURCE_ACCESS_POLICY.md`; per-source legal basis recorded before enablement; absolute prohibitions | 05 |
| R-11 | **Case-note exposure.** Most sensitive data on the platform; a public-sector breach is existential for the WorkBC product | 2 | 5 | 10 | `RESTRICTED` classification, org isolation, full audit, per-org retention | 17 |
| R-12 | ~~**Auto-apply UI over-promises.**~~ **CLOSED in Stage 00** — control disabled and labelled "Not available"; the "submitted without asking" sub-label removed; agents-list badge and README headline corrected | — | — | — | Done | 00 |
| R-13 | **Product/billing inversion.** ~19k lines of commercial code against ~500 lines of candidate core; effort continues to flow to the mature layer | 3 | 4 | 12 | Stage sequencing puts candidate core first; billing is re-scoped, not extended | 02–10 |

## Medium (5–9)

| ID | Risk | L | I | S | Mitigation | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| R-14 | ~~Lint backlog surfaces late~~ **CLOSED in Stage 00** — measured at 9 issues, of which 6 were the deliberate provider `require()` pattern (exempted with reasons, not "fixed"). Residual **0 errors / 2 warnings**, locked as a blocking gate via `--max-warnings=2` | — | — | — | Done | 00 |
| R-30 | **ESLint 9 is EOL upstream, and ESLint 10 is outside `eslint-config-next@15.4.11`'s peer range** (`^7 \|\| ^8 \|\| ^9`) — the same constraint shape as Next/Payload | 3 | 2 | 6 | Pinned to 9.x; Dependabot ignores `eslint >=10`; revisit with the Next 16 upgrade | 01 |
| R-15 | Payload peer range blocks a future Next security fix | 2 | 4 | 8 | Standing pre-upgrade check; `ADR-0003` revisit trigger | ongoing |
| R-16 | Rate limits multiply by instance count | 3 | 3 | 9 | Shared Redis store | 01 |
| R-17 | Artefacts lost on container restart (local filesystem) | 4 | 2 | 8 | Object storage | 05 |
| R-18 | Cross-border AI processing without adequate consent | 2 | 4 | 8 | Documented exception, disclosure, minimal content, no sensitive data | 01/15 |
| R-19 | Dashboards degrade transactional performance | 3 | 3 | 9 | Marts and materialized views | 21 |
| R-20 | Taxonomy licensing breach | 2 | 4 | 8 | Licence recorded before ingestion | 04 |
| R-21 | ~~Windows dirty-tree churn on generated files~~ **CLOSED in Stage 00** — `.gitattributes` added (renormalisation was a no-op; zero CRLF in tree) plus a CI determinism check and a line-ending job | — | — | — | Done | 00 |
| R-22 | 34 unreferenced models become permanent confusion | 3 | 2 | 6 | Explicit wire/keep/defer decision per model, recorded | 01 |

## Accepted with compensating controls
| ID | Risk | Rationale |
| --- | --- | --- |
| R-23 | `esbuild`/`drizzle-kit` moderate advisory, no fix available | Affects the esbuild **dev server** only; reaches us via Payload's migration CLI, never run in production. Development-machine exposure only. Revisit when Payload updates its adapter deps |
| R-24 | Webhook SSRF residual DNS-rebinding gap | Literal private addresses blocked and redirects refused; closing fully needs a custom agent that re-checks the resolved address at connect time. Documented honestly in-source. Revisit in Stage 23 |

## Open legal / compliance decisions (R-25 … R-29)

These are **not engineering risks to be mitigated by engineering**. They are open
decisions owned by the founder and counsel. Full detail, including why none
blocks the architecture baseline, is in
[`COMPLIANCE_REGISTER.md`](COMPLIANCE_REGISTER.md).

| ID | Open question | Status | Decision owner | Must be resolved by |
| --- | --- | --- | --- | --- |
| R-25 (L-1) | Does the WorkBC engagement make the platform a service provider to a public body, and which regime applies? | **OPEN** | Founder + BC public-sector privacy counsel | **Stage 17** (input needed by Stage 01) |
| R-26 (L-2) | Which Canadian taxonomy datasets may be redistributed commercially, and on what attribution terms? | **OPEN** | Founder + IP / data-licensing counsel | **Stage 04**, before ingestion |
| R-27 (L-3) | Are cross-border AI transfers acceptable under intended customer contracts, especially public-sector? | **OPEN** | Founder + privacy counsel | **Stage 03**; re-confirmed at Stages 11 and 17 |
| R-28 (L-4) | What recruiter / staffing licensing applies in BC and each target jurisdiction? | **OPEN** | Founder + employment / regulatory counsel | **Stage 19** |
| R-29 (L-5) | What consent language is required for agency representation and employer disclosure? | **OPEN** | Founder + employment / privacy counsel | **Stage 18** (disclosure); **Stage 19** (representation) |

**Handling rule.** An unresolved question is never converted into an engineering
assumption. A stage reaching its exit gate with its question still open is
**BLOCKED** at that gate.

## R-31 — automated dependency majors (found and closed in Stage 01)

Dependabot, enabled in Stage 00, immediately proposed `prisma` 6→7, `stripe`
17→22, `eslint-config-next` 15→16 and three GitHub Action majors. Any of the
first three would have broken the build: Prisma 7 removes the `package.json#prisma`
block still in use, the Stripe SDK major is coupled to an API version pinned in
code, and `eslint-config-next` must track `next`, which Payload pins.

The config constrained patch/minor grouping but not majors. Now closed:
`version-update:semver-major` is ignored for every npm dependency and every
Action, with named entries preserving the reasoning. None of the eight PRs was
merged. Detail in `../programme/DEPENDENCY_AUDIT.md`.

## R-32 — esbuild ETXTBSY on CI install (mitigated, Stage 01)

CI run 15 failed at `npm ci` with `ETXTBSY` from esbuild's postinstall: it writes
its binary then immediately execs it to check `--version`, and on a busy runner
the write handle may not be closed yet.

**Diagnosed, not assumed a flake.** The same lockfile installs cleanly from
scratch locally (exit 0), and the nested `esbuild@0.18.20` is byte-identical on
`main` and on the branch — the change did not introduce it. It arrives via
`@esbuild-kit/core-utils` → `drizzle-kit` → `@payloadcms/db-*`, a path no
application code touches (`drizzle-kit` is Payload's migration CLI and never runs
in production). That is the same chain already accepted as **R-23**.

**Mitigation:** one clean retry of `npm ci`, and only after a first failure. It
prints a `::warning::` so the retry is visible in the log rather than silent, and
a second failure still fails the job. This does not mask a genuine install
problem; it absorbs a known installer race.

**Proper fix:** the `@esbuild-kit/*` packages are deprecated upstream ("merged
into tsx"). They disappear when Payload updates its adapter dependencies —
tracked with R-23.

## R-33 — three ways RLS looks enabled and is not (found in Stage 01, encoded as tests)

Building the `ADR-0005` mechanism proof against a real PostgreSQL 16.13 surfaced
three failure modes that a schema review passes and a running system does not.
None is a defect in this repository yet, because no RLS policy exists yet. All
three are the reason the proof is a committed test rather than a paragraph.

**1. Session-level `SET` leaks tenant context across pooled requests.** The
obvious way to establish tenancy — `SET app.user_id = …` at the start of a
request — outlives the request. Test 2 reproduces a cross-tenant read on a
request that sets no context at all, caused by nothing but connection reuse; it
asserts `pg_backend_pid()` is unchanged, so the scenario cannot silently not
occur. The requirement is therefore not "set a GUC" but **set it with
`is_local = true`, inside the same transaction as the query** (tests 3 and 10).

**2. `ENABLE ROW LEVEL SECURITY` does not bind the table's owner.** For the
owner, policies exist, are attached, and are not applied. On a managed Postgres
the application's migration role typically *is* the owner, so this is the
realistic configuration, not an exotic one. Test 8 reproduces a complete bypass
with a correct policy enabled, then shows `FORCE ROW LEVEL SECURITY` closing it.
**Every policied table must be `FORCE`d**, and Stage 01's migration standard now
says so.

**3. "No tenant context" is not always `NULL`.** `current_setting(name, true)`
returns `NULL` on a connection that has never seen the setting and the **empty
string** on one where it has been set and cleared — which is every recycled
connection. A guard written as `IS NULL` fires on the first request a connection
ever serves and never again. Test 4 asserts both states and that both fail
closed. Policies must be equality against a real tenant id, never a `NULL` test.

A fourth, milder finding is recorded in the test rather than here: `SET` and
`SET LOCAL` take no bind parameters, so the only literal way to write them is to
interpolate the tenant id into SQL text. `set_config($1, $2, true)` is the
parameterised equivalent and is what the application must use — an injection site
in the statement that decides who can see what would be the worst possible place
for one.

**Residual, unchanged:** this proves the mechanism on a stock PostgreSQL. The
deployment-specific proof `ADR-0005` also requires — the same assertions through
the real connection pooler in its configured pool mode — needs the provisioned
project and is tracked as `SUPABASE-PROJECT` in
`../programme/AUTONOMOUS_STATUS.json`.

## R-34 — the build environment cannot reach the staging database (open, Stage 01)

`DATABASE_URL` and `DIRECT_URL` for the Supabase staging project are present
and correctly shaped (transaction pooler on 6543 with `pgbouncer=true`,
session endpoint on 5432, host in `ca-central-1` — verified without reading
the values). But the environment's egress proxy relays HTTPS only, the
project's HTTPS host is policy-denied (403 on CONNECT), and the pooler needs
raw TCP, which the gateway accepts and then black-holes (the PostgreSQL
`SSLRequest` never receives a reply; a plain startup gets a reset). Direct TCP
to the pooler times out.

Consequence: every proof that needs the *real* project — migration rehearsal
against Supabase, the pooled-runtime proof through Supavisor, region read from
a live query, Supabase Auth token exchange — is `NOT VERIFIED`, not `PASS`.
The mechanism, the migrations, the policies and the Prisma path are proven on
PostgreSQL 16 and through PgBouncer in transaction mode locally and in CI.

Mitigation: the exact requirement is recorded in `../programme/AUTONOMOUS_STATUS.json`
(allow TCP egress to the pooler host on 5432 and 6543, or run the recorded
commands from a network that has it, or add the connection strings as GitHub
Actions secrets so CI can run the same suites against staging). Owner:
founder / environment administrator.

## R-35 — tenant-path adoption is partial (open, Stage 01 → 02)

RLS protects a query only when the query runs on the tenant path
(`requireTenant()` → `run(tx => …)`). Stage 01 converted the candidate-facing
API routes and dashboard pages that query Prisma directly; the exact list of
what is and is not on the tenant path is in `../programme/STAGE01_EVIDENCE.md`.
Handlers still on the system client — chiefly those that go through library
functions such as billing, exports, the scanner and the apply engine — are
protected by their `where: { userId }` filters exactly as before Stage 01: no
regression, but no backstop either. Two failure modes remain possible until
adoption is complete: a forgotten filter in a library function, and a `db.`
call written inside a `run` callback (which silently escapes the transaction).
Mitigation: continue adoption as each library area is touched in Stages 02–10,
and add a lint rule or test that flags `db.` inside `run` callbacks (Stage 02).

## R-36 — the legal documents behind the consent records are not yet written (open)

Signup now records versioned consent to the Terms of Service and Privacy
Policy (`ConsentRecord`, version `2026-09-01`), and `/terms` and `/privacy`
exist so that consent is informed. Their **text is pending founder and
counsel** (L-5 and the `ADR-0015` disclosure obligations); the pages say so
explicitly and show the version identifier. A user who signs up today has
agreed to a document whose wording is not published — acceptable while there
are no real users, not acceptable at launch. Owner: founder + counsel; must be
resolved before any real signup (Stage 24 gate at the latest).

## R-37 — evidence grounding is lexical (accepted with compensating controls, Stage 03)

`src/lib/ai/grounding.ts` rejects any number, capitalised entity or
employment/education entry in generated output that the résumé and the
approved evidence do not contain, section by section, replacing the section
with the deterministic baseline and counting the rejection on the `AiRun`.
Résumé sections do not admit the posting's vocabulary, which is what stops a
posting from injecting claims into a résumé. What it does **not** catch: an
invented lower-case verb phrase built from words already present ("led the
migration" when the candidate only "supported" it), and a single Title-case
word at a sentence start ("Google hired me" — acronyms, mixed case and
proper-noun runs are still checked). Compensating controls: bullets belong
only to real roles and a rejected bullet falls back to the original at the
same position; the prompt forbids invention; every run records what was
rejected. Stage 09 adds claim-level citations, which closes the residual
structurally. Likelihood 2 · Impact 3 · Score 6. Owner: engineering.

## R-38 — no prompt version has passed evaluation, so external AI is off by construction (open, Stage 03)

`AI_GOVERNANCE.md` forbids a version from serving before an evaluation has
passed, and no live-model evaluation has ever been run from this codebase (no
key reaches the build). The three seeded prompts are `approved / pending`;
every task is served by the deterministic engine and recorded as
`deterministic` or `degraded / no_default_prompt`. This is the intended
fail-closed posture, but it means the product's "AI tailoring" is today the
deterministic engine for every tenant, and the truthfulness suite on the
live-model path has only been exercised with a fake provider. Resolution is
an operator action once L-3 is decided: evaluate, record with a note,
promote at `/console/prompts` (`AUTONOMOUS_STATUS.json` →
`external_actions[PROMPT-EVALUATION]`). Likelihood 5 · Impact 2 · Score 10.
Owner: founder (L-3) then operator.

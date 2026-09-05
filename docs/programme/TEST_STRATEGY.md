# Test Strategy

## Current state (measured)

Re-measured 2026-09-03, end of Stage 01. The baseline this document was written
against — 670 tests, no CI, lint never run — is superseded.

| | At the audit | Now |
| --- | --- | --- |
| Tests | 670 | **800+** with a migrated PostgreSQL available (the database suites skip with a reason without one, and throw in CI) |
| Suites | 158 | 180+ |
| Files / lines | 16 / 7,668 | 19 / 8,533 |
| CI | none | 3 jobs, all required (`.github/workflows/ci.yml`) |
| Lint | never run | 0 errors, 8 warnings, blocking at `--max-warnings=8` |

Runner: `node --test` with `tsx`. Added since the audit: webhook replay and
ordering (12), the deny-by-default edge gate (7), and the `ADR-0005` RLS
isolation proof (10, below).

- Coverage is still concentrated in **billing, analytics, integrations and CRM** —
  matching where the code is, not where the product is.
- Thin or absent: auth, matching, applications, jobs, storage.
- **No E2E tests.**

The suite is a genuine asset and the regression guard for the PostgreSQL
migration. It is not evidence that the product works — most of it tests the
commercial layer.

## Layers

| Layer | Scope | Runner | Introduced |
| --- | --- | --- | --- |
| Unit | Pure logic, scoring, tax, dunning, interpolation | `node --test` | **Exists** |
| Component | React components, states, a11y roles | Testing Library | Stage 00 |
| API | Route handlers: auth, validation, error envelopes | `node --test` + fetch | Stage 01 |
| Database | Migrations up/down, constraints, cascades | Postgres service container | Stage 01 |
| **Authorization / RLS** | **Cross-tenant denial per table** | Distinct DB roles | **Stage 01** |
| Integration | Module interactions with real Postgres/Redis | Service containers | Stage 01 |
| Contract | Public API vs OpenAPI | Schema validation | Stage 14 |
| Connector | Every adapter against one shared contract suite | Recorded fixtures + live smoke | Stage 05 |
| **AI evaluation** | Truthfulness, grounding, schema, regression, leakage, consistency | Golden sets | **Stage 03** |
| Document regression | Résumé/cover-letter goldens; ATS parse | Snapshot + parser | Stage 09 |
| E2E | Critical candidate journeys | Playwright | Stage 12 |
| Browser automation | Assisted apply, extension | Playwright | Stage 12 |
| Mobile | Device matrix, offline | Detox / Maestro | Stage 14 |
| Security | Authn/authz, injection, SSRF, upload safety | Automated + manual | Stage 23 |
| Accessibility | WCAG 2.2 AA | axe + manual | Stage 23 |
| Performance | Budgets, load, query plans | k6 | Stage 23 |
| **Backup / restore** | **Rehearsed restore from backup** | Runbook | Stage 23 |
| DR | Failover game day | Runbook | Stage 23 |
| Production smoke | Post-deploy critical paths | CI | Stage 24 |

## The two non-negotiable suites

**1. Negative authorization (Stage 01).** For every tenant-scoped table: prove
user A cannot read user B's row — **with application filters removed in the
harness**, so the test exercises RLS specifically. Without this, tenant isolation
is an assertion rather than a property.

*Progress:* **both halves are done.** The mechanism: `tests/rls-isolation.test.ts`,
10 assertions against a real PostgreSQL in CI. The per-table half:
`tests/tenancy-isolation.test.ts` runs through the real Prisma client on the
migrated schema with application filters removed — every table classified and
forced, cross-tenant read and write, missing/malformed context, connection
reuse asserted by backend PID, 40 parallel requests, organisation scope, and
the tenant role's write surface (own-row column privileges; no writes to the
roster or the organisation record). Membership authorisation negatives are in
`tests/organizations.test.ts`, identity linkage in `tests/identity-link.test.ts`,
sessions in `tests/sessions.test.ts`. What is NOT done: the same suite through
the staging project's pooler (R-34).

**2. AI truthfulness (Stage 03).** Given a fixed profile and evidence vault,
assert that no generated document contains an employer, technology, date,
credential or metric absent from the vault. Runs against both the deterministic
engine and the live-model path. Also asserts: every material claim has a
resolvable evidence reference; no prompt payload contains a `RESTRICTED` field;
identical inputs produce identical scores; and an injection attempt in a job
description cannot redirect a system prompt.

## Lint: measure, then ratchet

Done in Stage 00 and re-baselined in Stage 01. ESLint is installed, configured as
native flat config, and blocking in CI at `--max-warnings=8`; the count and the
justification for every warning are in `LINT_BASELINE.md`. The last step —
removing `eslint: { ignoreDuringBuilds: true }` from `next.config.mjs` — is
done: it stopped meaning anything once lint became its own gate, and Next 16
warned on the key. The plan is complete.

## The database suites

Since Stage 01 the transactional store is PostgreSQL, and these files need a
real one: `rls-isolation` (mechanism; creates its own schema and role),
`tenancy-isolation`, `organizations`, `sessions`, `identity-link`,
`sensitive-segregation`, `digital-twin-backfill` (Stage 02), and
`ai-gateway`, `evidence-vault`, `question-bank`, `prompt-registry` (Stage 03),
`taxonomy` (Stage 04), `connector-pipeline`, `ats-rulesets` (Stage 05) — all run
through the migrated schema (apply the history with
`npm run db:migrate:deploy` first).

**The connector contract suite (Stage 05).** `tests/connector-contract.ts` is
the admission gate ADR-0008 requires: seven cases every adapter runs
unchanged, from a `describe` per adapter in `tests/connectors.test.ts`. A
real source is wired to a recorded-shape fixture through a stubbed fetch —
rule 4 again: the fixture is written to the documented field names, and the
register says the live API has never been called.

**The AI suites (Stage 03).** `ai-grounding` is pure and runs everywhere: a
fixed profile, a posting carrying a prompt injection, adversarial "model
output" with an invented employer, degree, metric, technology and role, and
the deterministic engine's own output as the false-positive check.
`ai-gateway` runs the same fabrications through the real gateway with a
**fake external provider** against the database, and proves the per-tenant
policy routing, the `RESTRICTED`-payload refusal and the `AiRun` record. The
fake is the boundary rule 4 below describes: what a real model returns has
never been observed from this codebase, and the register says so.

**Running them.** Set `RLS_TEST_DATABASE_URL` (any PostgreSQL 14+ the test may
create and drop a schema and a role in) and `TENANCY_TEST_DATABASE_URL` (a
database the migrations have been applied to; the same one is fine):

```bash
RLS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test \
TENANCY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/jobpilot_test npm test
```

A suite that touches the database through the shared client must import
`tests/helpers/database-env.ts` **as its first import**: `src/lib/db`
instantiates the Prisma client from `DATABASE_URL` the moment it is
evaluated, so a static import chain that reaches it (a registry module, a
loader) binds the client before any `before()` hook can override the
variable. The helper points `DATABASE_URL` at `TENANCY_TEST_DATABASE_URL`
before anything under `src/` loads. Stage 05's review found three suites
that silently ran against the shell's `DATABASE_URL` without it (H2).

Without them, those files skip with an explicit reason and the rest of the
suite runs normally — a developer without PostgreSQL is not blocked.

**They cannot be skipped where it matters.** Each file throws when its URL is
absent and `CI=true` (or `RLS_TEST_REQUIRED=1`). CI
supplies a `postgres:16` service container, so deleting that service fails the
job rather than quietly turning the proof off. This is rule 1 below applied to a
test that is *conditional* by nature: conditional must not become optional.

**What it proves, and what it does not.** It proves the mechanism on a stock
PostgreSQL: transaction-scoped context, fail-closed behaviour, write containment,
`FORCE ROW LEVEL SECURITY`, and three specific ways RLS can be present and inert
(`../governance/RISK_REGISTER.md` R-33). It does **not** prove the deployed
configuration — the same assertions through the real connection pooler in its
configured pool mode are a separate, still-outstanding Stage 01 exit condition.
Nor does it prove any application table is protected: no policy exists on any
real table yet.

Connection reuse is asserted rather than assumed — the pooled tests compare
`pg_backend_pid()` across checkouts — so a green run cannot mean the scenario
never occurred.

## Rules
1. **No test may be skipped, disabled or deleted to obtain a green run.** A
   failing test is a finding.
2. A bug fix ships with the test that would have caught it.
3. Tests assert behaviour, not implementation.
4. External services are faked at the boundary; **live validation is a separate,
   recorded activity** — that distinction is what keeps
   `IMPLEMENTED-NOT-VALIDATED` honest.
5. Every stage's exit gate names its required evidence.

## Stage 06 — canonical job

- `tests/canonical-jobs.test.ts` (pure): every canonical field of fifteen
  fixture postings asserted exactly (`tests/fixtures/canonical-postings.json`);
  dedup precision and recall computed over every pair of the labelled set on
  every run and asserted at 1.0 / 1.0, so a change to the identity rule is a
  visible decision; unit cases for title, company, region, years,
  authorisation and sponsorship. A golden is changed by review, never
  regenerated.
- `tests/connector-pipeline.test.ts` (database): the acceptance case (one
  job, two provenance rows, a snapshot per capture), primary-source column
  ownership, the no-merge case, per-source closure and doubt, sweep
  progress, closed-job non-revival, primacy adoption, the job page's
  tenant-path include, and tenant read-only access to provenance.

## Stage 07 — eligibility

- `tests/eligibility-engine.test.ts` (pure): the coverage matrix — every
  rule × every candidate state it distinguishes, both jurisdictions for
  work authorisation; the aggregation laws (a hard fail excludes, unknown
  never does); a reason in words on every rule with no percentage;
  determinism.
- `tests/eligibility-gate.test.ts` (database): the audit-first tenant-path
  read (no value in the row), verdict storage and staleness against the
  profile, the scanner excluding an ineligible posting end to end on the
  synthetic source (no `JobMatch`, reason stored) while a citizen is
  excluded from nothing, and tenant read-only isolation of verdicts.

## Stage 08 — compatibility

- `tests/matching-pipeline.test.ts` (pure): scoring consistency (25 runs),
  the equivalence map's effect on matched/missing and its `semantic` label,
  a different weight version changing the score but not the breakdown,
  absent weights equalling the built-in baseline, weight validation, and
  evidence citation under the map and by kind.
- `tests/match-weights.test.ts` (database): the built-in baseline when no
  version is active; the scanner writing `weightVersion`, `pipelineVersion`
  and one cited dimension row per dimension (contribution = score × weight,
  weights summing to 1); the governance lifecycle with a second approver,
  the regression that matches scored before an activation keep their score
  and version while new ones carry the new version, rollback recorded, the
  active version unretirable; tenant isolation of dimension rows and the
  system-only register.

## Stage 09 — documents

- `tests/document-engine.test.ts` (pure): the model renders to exactly
  `renderResumeText`; a letter round-trips; the ATS report's checks
  (contact, headings, order, dates, single column, parse-back); PDF and
  DOCX determinism (same model + date → same bytes, DOCX a second apart;
  canonicalisation idempotent; core dates pinned) with parse-back of every
  model line; the upload scanner on right/wrong names, scripted PDF, macro
  DOCX, plain zip, empty, oversize, binary noise, invalid UTF-8; signed
  links (ok, boundary, expired, tampered owner/document/expiry/signature/
  secret); every message kind deterministic, free of the posting's text and
  passing letter-scope grounding.
- `tests/document-versions.test.ts` (database + a temporary local store):
  hash on write, next version, verified read; an altered or missing object
  refused; the six-version application set with ATS reports re-rendering to
  the same hashes; a submitted row immutable by the trigger (UPDATE, direct
  DELETE) while the owner's erasure cascades; assisted confirmation seals;
  RLS on the tenant path.

## Stage 10 — application folder

- `tests/application-status-machine.test.ts` (pure): every allowed move and
  a table of refused ones, with the transition table's size asserted; terminal
  statuses; the applicant's statuses; refusal wording; the folder completeness
  checklist on sent, unsent and undisclosed-employer folders.
- `tests/application-folder.test.ts` (database): a move writes the row, the
  history row and the audit together and rolls back together; dishonest
  moves refused; repeats idempotent; rejection settles the outcome; children
  on the tenant path, audited without content (names, emails, notes and the
  salary asserted absent from every audit row); the first interview moves the
  application; the offer settles hired; a foreign drafted message refused;
  confirmation through the machine; another tenant sees and touches nothing;
  erasure cascades; completeness from real rows; the export carries the
  structured outcome.

## Stage 11 — mailbox intelligence

- `tests/mailbox-association.test.ts` (pure): every thread of the labelled
  corpus (`tests/fixtures/mailbox-corpus.json`, 24 threads over three
  folders) files as labelled — status AND folder; precision and recall of
  automatic filing asserted as numbers; the near-tie is pending with its
  rival named; the pre-application thread is penalised; a look-alike domain
  is not filed; detections from subject and invite only ("special offer" is
  not an offer); the scope inventory holds no content scope; the encryption
  round-trips and refuses a tampered tag.
- `tests/mailbox-leakage.test.ts` (static + runtime): nothing under
  `src/lib/mailbox` imports the gateway, grounding, a model provider or the
  SDK; the gateway refuses a payload carrying a `mailbox` key at any depth.
- `tests/mailbox-sync.test.ts` (database): connect refused without consent;
  a signed state bound to another user refused; a grant carrying a content
  scope revoked and refused with nothing stored; no store without the key;
  the token unreadable on the tenant path; a sync files the corpus as
  labelled, emits `EMAIL_RECEIVED` / `INTERVIEW_DETECTED` / `OFFER_RECEIVED`
  only as promised and is idempotent (second sync: no rows, no events); the
  applicant's decision sticks across re-syncs and unlocks the detections it
  files; another tenant sees nothing; revocation purges every derived row
  and the secret and audits counts with no subject, address or token.

## Stage 12 — assisted application

- `tests/application-modes.test.ts` (pure): the unreachable mode refused
  wherever a mode is parsed, with the reason; an unknown stored value reads
  back as the default; no mode permits an unattended submission and the
  unreachable mode has no permission row; refusals in the applicant's words.
- `tests/apply-engine.test.ts` (pure): with an employer credential set,
  `apply()` still prepares and never posts; `canSubmit` follows the
  credential; the assisted-only engine never can; the mock prepares first
  and "submits" only on `submit()`.
- `tests/prepared-questions.test.ts` (pure): a NEVER_AUTOMATE question
  carries no value even with a stored answer (and the guard sees a leak);
  the policies map to fill / ask / review; a profile fact stands in only
  where a mapping names one and never for a salary; ordering; the matcher
  and the validator (duplicate key, bad regex, select without options, a
  fabricating fallback rule).
- `tests/field-mappings.test.ts` (database): the built-in set until a
  version is active; create → second-admin approval → activate with a
  mandatory reason, served by the read path, audited; rollback recorded as
  rollback with the demoted version approved; retirement rules; an invalid
  stored row falls back to the built-in set and is not cached.

## Stage 13 — candidate analytics

- `tests/candidate-marts.test.ts` (pure): the dictionary is complete, sources
  only marts, and is mirrored key-for-key and definition-for-definition in
  `docs/governance/METRIC_DICTIONARY.md`; every rate and value computed one
  way and never `NaN`; bands and seniority total; reach inferred from the
  history (an interview later rejected still counts; a withdrawal is not a
  send); the builders deterministic and order-independent; every dimension
  sums to `all` on every day; the assembled dashboard shape (totals, series
  zero-filled, cuts, rates); the match mart's bands and keyword tallies; the
  benchmark counts DISTINCT people and a cohort under five is suppressed; a
  static scan proves the read module, the analytics page and the overview
  query no transactional table for a metric.
- `tests/candidate-analytics.test.ts` (database): six applications with real
  histories, an interview, résumé versions and a match; the rollup writes
  the marts and a `RollupRun`; PARITY between the tenant-path read and the
  pre-existing pure engine over the same rows on every shared metric, with
  the deliberate differences (reach from history) named; a second run
  changes nothing; a single-user refresh does not shrink the benchmark;
  another tenant reads nothing and cannot reach the benchmark table; the
  benchmark suppresses a one-person cohort.

## Stage 14 — the candidate API contract

- `tests/candidate-api-contract.test.ts` (pure): the OpenAPI document is
  3.1 and semver, every operation carries a scope and a 2xx schema, every
  error references the one `Error` envelope, every path parameter is
  declared, every `$ref` resolves; the lock's hash equals the canonical
  document's (a change without `npm run api:freeze` fails); the contract's
  paths and the route files under `src/app/(app)/api/v1` are the same set
  both ways; the `Error` schema accepts exactly what `http.ts` emits.
- (database): with real API keys, every GET's body validates against its
  declared schema; a never-automated question carries no value through the
  API; a contact's address is absent from the folder; another key gets the
  404 envelope for the same ids and empty lists; a `read` key is refused
  `apply:write` with the `insufficient_scope` envelope; an unknown key gets
  401; `submit` on a non-permitting mode and on an unauthorised board is
  refused with the envelope and nothing moves; `confirm` with `apply:write`
  moves the record through the machine, seals the documents, returns a
  valid folder, and a second confirm is refused.

### Stage 14, second pass — version 1.1.0 and the app (2026-09-05)

- **Contract, closed.** The independent review showed an open schema waves a
  leaked column through, so every object schema is `additionalProperties:
  false` and `contractProblems()` refuses an open one or an `allOf`; a test
  proves `passwordHash` on `Me` fails. Every keyed operation documents 401,
  every operation 429; enforced. `conforms()` parses every `*At` string.
- **The device flow, end to end with a real password hash** (bcrypt in the
  test's `before`): mint, use, list as current, sign out, refused; a wrong
  password mints nothing; the supabase method without a provider is 503
  `unavailable`; an integration key cannot be signed out through the device
  route; a stranger's revoke is 404 and the device still works; the owner's
  revoke from another device works; a password change revokes all; no audit
  row carries a key. Consents (grant once, withdraw, required and L-3
  purposes refused), saved jobs (idempotent, ownership, `saved` on detail),
  the signed document link (verified with `verifyDocumentLink`, bound to the
  owner, 404 for a stranger), evidence (claims never facts).
- **The app (`mobile/tests`, node:test, no device):** the client against a
  fake fetch (bearer header on all but sign-in, envelope → `ApiError` with
  code / status / param / Retry-After, one 401 signal, network and
  non-envelope bodies as `NetworkError`, every write helper's method and
  path); the cache policy (allow-list of GETs, never a write / device list /
  signed link, age-out, corrupt entries dropped, cleared on sign-out);
  contract parity (every client path in the document, every document path
  in the client but the ATS lookup, generated types byte-identical to a
  fresh `openapi-typescript` run, no `fetch` or `/v1` literal outside the
  client, no AsyncStorage import, nothing that looks like a key or secret);
  formatting and the device descriptor; WCAG contrast of every token pair
  **computed**. CI: `api:types` diff, `tsc`, the suites, `expo export
  --platform web` as the compile gate.
- **NOT covered, by honesty:** anything that needs a device - the secure
  store, VoiceOver / TalkBack, dynamic type, a network drop mid-tap, deep
  links, the store build. Detox / Maestro remain the plan for a device
  matrix once one exists.

## Stage 15 — payments, subscriptions and entitlements

- **Pure:** the capability registry is well-formed; a plan's grants are
  deterministic and complete (the two quantities from the plan row, the rest
  from the matrix column of the plan code's family; a versioned code is its
  family); the merge rule (max quantity, any boolean, free baseline, revoked
  and expired rows ignored, a zero grant never lowers the baseline);
  `resolvePrice` in the customer currency from `PlanPrice` with the CAD
  fallback stated; a `cap` row is the only thing that lowers (lowest cap
  after every grant, a boolean cap blocks, an expired cap does not, a cap
  above the answer changes nothing); `resolvePrice` under
  `requireExternalPriceId` skips a cell with no gateway price id.
- **Database (`tests/entitlements.test.ts`):** a grant without a payment is
  what the quota reads and a revoke without a refund removes it, both
  audited without an amount, the same grant twice one row; activating a plan
  grants its rows, a replayed activation writes no audit row and hands out
  no second allowance, an upgrade revokes the old rows as `plan_changed` and
  the quota and the agent ceiling follow; past due keeps access, suspension
  revokes as `payment_lapsed` (the free baseline remains), recovery
  re-grants, cancel-at-period-end keeps access until the period end and the
  baseline after, a refund recorded from the gateway changes no row,
  immediate cancel revokes as `canceled`; a trial grants with the trial's
  expiry, the sweep records expiry, converting to a paid plan retires the
  trial rows; an organization's licence reaches accepted members and not
  removed ones or strangers; a staff revocation of a plan row holds across
  a plan re-sync and a recovered payment (`blocked: staff_revoked`) until
  staff grant it back; a non-plan grant without a `sourceRef` is refused; a
  cap lowers the quota and lifting it restores the grants; buying the same
  plan again after cancel-at-period-end clears the flag and lifts the
  rows' expiry; a second trial of a plan is refused on the trail; an
  account with no subscription row has a quota from its entitlement against
  the month's application rows, with nothing to consume; `quantitiesForMany`
  answers for many at once without organization rows; the rows are visible
  on the tenant path to the owner only.
- **Static (`tests/entitlements-static.test.ts`):** no feature module
  branches on `Subscription.status` or reads `plan.maxAgents` /
  `plan.applicationsPerMonth` / plan feature flags (payment-state readers
  named and allowed); `canApply` never reads status and the limit is the
  entitlement; the refund handler calls nothing that changes access and
  nothing under `src/lib/billing` can revoke.
- **NOT covered, by honesty:** any call to Stripe (no test-mode key here):
  checkout, the signed webhook end to end, Smart Retries, Stripe Tax. The
  entitlement consequences are proven against the functions the webhook
  dispatches to; the Stage 01 replay and ordering tests stand.

## Stage 16 — career transition, learning and certification

- **Pure (`tests/career-engine.test.ts`):** a skill is held by id or
  normalised name and a credential by any whole-word spelling (a substring
  is not one); transferable skills are separated from gaps, gaps ordered by
  importance, credentials priced by requirement (regulated 30, required 15,
  preferred 5), the score banded; the pathway is credentials first (via an
  offering when one leads to it, else the credential alone), then a greedy
  set cover of offerings over the remaining skill gaps, then an explicit
  "no licensed offering covers X yet" step with no provenance, then bridge
  roles - every other step carrying its dataset; the same input yields the
  same output; with no offerings and no dataset nothing is invented; an
  offering counterfactual closes exactly the gaps it states it teaches; the
  credential counterfactual turns an ineligible verdict eligible on exactly
  the licensure rule and a credential the posting does not ask for changes
  nothing. Static: nothing under `src/lib/career` imports the AI gateway, a
  provider SDK, the mailbox or the sensitive path.
- **Database (`tests/career.test.ts`):** the graph file is validated
  (unknown kind, provider, credential, NOC shape, importance range,
  duplicate slug refused); loading is refused until the licence is recorded
  AND approved; a load carries the dataset on every row, reports an unknown
  NOC and does not load it, and is idempotent; the engine on the tenant path
  shows transfers, gaps with stated recognition, a pathway of licensed
  offerings and the recorded bridge for the entitled, and withholds the
  offerings (gaps complete, reason stated) for the unentitled; a plan is
  versioned - create counts against the budget, refresh supersedes and
  archives and carries done milestones by title without counting, the
  budget refuses at the limit and the unentitled at zero, archived versions
  are not listed; a completed milestone may cite the person's own approved
  evidence and neither a draft nor another person's; RLS shows another
  tenant none of the plans or milestones and refuses their update while
  reference rows are readable by every tenant; the counterfactual on real
  rows (the regulated CPA) moves ineligible to eligible on the licensure
  rule with provenance; a prohibition purges the graph, the dataset's
  occupations go with it, plans keep their stored analysis and cited
  offerings are detached.
- **NOT covered, by honesty:** any real learning dataset (none is
  recorded), the UI beyond compile and lint, and any claim about what an
  employer accepts.

## Stage 17 — employment services / case management (Level 0)

- **Pure (`tests/cases-copilot.test.ts`):** a healthy search draws no
  recommendation; each of the nine patterns fires on its threshold with the
  numbers that triggered it, in a fixed order, deterministically, and not
  below the sample sizes; no suggested action claims to have changed
  anything; the case roles resolve as a named set over the ladder (owner and
  admin are admin; null or unknown is viewer; an unknown rung is not admin)
  and gate open / write / manage as the matrix says. Static: the copilot,
  the client view and the runner never name a case note, an assessment or a
  barrier and never import a provider or the sensitive path; nothing under
  matching, eligibility, analytics, career or the AI gateway names a case
  table; the gateway's RESTRICTED keys include the case vocabulary.
- **Database (`tests/cases.test.ts`):** the actor resolves only from an
  accepted membership of a service-provider organisation (another type, a
  non-member: 404); a supervisor invites (audited), a case manager cannot,
  no account and a duplicate are refused, and before consent the summary,
  the copilot and a note are refused; the client sees the invitation on
  their own tenant path and a stranger, another provider and the client's
  own UPDATE are refused; only the client answers and accepting writes a
  versioned consent record; assignment gates the case manager, a supervisor
  reads all and writes none, a viewer sees counts, another provider's admin
  gets 404, the viewer cannot be assigned; a note and an assessment are
  audited before the write and before the read with no text in the trail,
  the client and another provider see none, the viewer is kept out by the
  service; a referral needs a licensed offering, tasks move, an employed
  outcome creates the 4 / 12 / 24-week follow-ups and `not_employed` none;
  the copilot writes recommendations and nothing else (a snapshot of the
  client's and the case's other tables is byte-identical after a run), is
  audited along with the delegated read, refreshes without duplicates,
  supersedes a vanished pattern, keeps a decision, and the signals carry no
  note or barrier; accepting with a task cites the recommendation,
  dismissing creates nothing, deciding twice is refused; withdrawal closes
  the case, revokes the consent and refuses further reads; only an admin
  sets a retention policy within bounds, the purge removes expired notes
  and old closed cases with everything under them, and an organisation
  without a policy is untouched.
- **NOT covered, by honesty:** any WorkBC system (none exists), the UI
  beyond compile and lint, route-level status codes, and any public-sector
  regime (L-1).


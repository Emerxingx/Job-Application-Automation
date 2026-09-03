# Stage 05 — Job source connector framework — evidence

Recorded 2026-09-03 on branch `claude/stage-05-job-source-connectors`,
stacked on Stage 04 (PR #16) → 03 (#15) → 02 (#14) → 01 (#13, PARTIAL). Draft PR #17.
Every line was run or read; nothing is PASS on the strength of a mock, a
skipped test or a document. This stage's honest centre: **the connector
framework is built and proven on the synthetic source and a recorded-shape
fixture; the one real source (Adzuna) has still never been called with a
live key from this codebase.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 05: many lawful sources behind one contract.
Expand `JobProvider` into `JobSourceConnector` (ADR-0008) with per-connector
config, credentials, rate limits, health and audit; a contract suite every
adapter must pass; recorded-fixture replay; live smoke test per credentialed
source; **validate Adzuna against the live API**; object storage (ADR-0015);
`AtsRulesets` under governed administration. Exit gate: ≥ 2 lawful sources
live; Adzuna reclassified `PRODUCTION-VALIDATED`; `AtsRulesets` governed.

## 2. Schema and migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, inherited)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903110000_connector_framework` | `JobSource` (the per-connector record and gate: legal basis, terms review, robots position, rate limit, attribution, data categories, personal data, retention reference, approval, credential NAMES, health), `JobSourceRun` (audit of every run, query SHAPE only), `JobSnapshot` (the posting as captured, immutable by trigger), `AtsRuleset` (the governed registry); `Job.sourceId` / `firstSeenAt` / `lastSeenAt` / `activeState` / `closedAt` / `sourceHash`; classification comments | applied fresh; drift "No difference detected"; **99/99** public tables forced |
| `20260903110100_rls_connector_tables` | Generated policies (manifest `RLS_MANIFESTS[4]`): `JobSnapshot` is `reference` (shared like `Job`); `JobSource`, `JobSourceRun`, `AtsRuleset` are `system` | determinism test; tenants read snapshots, see neither the register nor the run audit, cannot insert a snapshot |

## 3. The contract — `PASS` on both adapters

`src/lib/connectors/types.ts`: `discover · fetch · normalize · validate ·
refresh · detectClosed · getApplicationRoute · healthCheck`, with the honesty
rules in the contract itself: `refresh` / `detectClosed` answer `unknown`
when a source cannot tell, and the pipeline never turns silence into
closure. `src/lib/connectors/base.ts` gives every adapter one normalisation,
one validation (stable reason codes) and one routing decision (an ATS API
only where one is published AND an employer-issued credential is held;
assisted for a detected ATS without one; external otherwise — ADR-0016).

`tests/connector-contract.ts` is the admission gate (ADR-0008); every adapter
runs the same seven cases:

| Case | mock | adzuna (recorded-shape fixture, stubbed fetch) |
| --- | --- | --- |
| Identity, class, credential NAMES (`^[A-Z][A-Z0-9_]+$`) | PASS | PASS |
| discover → normalize → validate well-formed; normalize deterministic | PASS | PASS |
| validate refuses a broken posting with stable reason codes | PASS | PASS |
| fetch returns a posting or null, never throws | PASS | PASS (always null: no by-id endpoint) |
| refresh / detectClosed answer active · closed · unknown, never infer | PASS | PASS (always unknown: no closure signal) |
| getApplicationRoute: ats_api only with a credential, assisted for a known ATS, external otherwise | PASS | PASS |
| healthCheck never throws, reports status + latency | PASS | PASS (`down` on a 503, credential absent from the detail) |

Adzuna additionally: search criteria only in the request (no identity
parameter), documented parameters honoured, predicted salary bands dropped,
the title-less record skipped. **The fixture is hand-written to the
documented field names, not captured from the live API.**

## 4. The source register and gate — `PASS`

`src/lib/connectors/registry.ts`. Every connector has a `JobSource` row;
`requireEnabledSource()` is the only way the pipeline obtains a connector,
and it refuses a source that is unknown, disabled, whose record is
incomplete (legal basis, terms reviewed by/when, approved by/when,
retention reference) or whose credentials are absent — each refusal is
itself a recorded run. The mock is the one source complete and enabled out
of the box, and its row says why. Adzuna is registered `disabled` with its
credential names and an EMPTY legal basis: the basis is a person's record.

| Assertion (`tests/connector-pipeline.test.ts`) | Result |
| --- | --- |
| mock enabled with a complete record; adzuna disabled, names only, incomplete | PASS |
| Unknown / disabled source refused; the refusal recorded as a run | PASS |
| Enabling requires a complete record AND present credentials; recording is not approval; a reason is required | PASS |
| Credentials removed after enabling: the gate refuses at run time | PASS |
| Audit: `source.policy.recorded` → `source.enabled` → `source.disabled` | PASS |

Recording and enabling are admin-only, **step-up re-authenticated** and
audited (`/console/sources`, `/api/console/sources/:key`). The per-connector
records themselves are in `SOURCE_ACCESS_POLICY.md`.

## 5. The pipeline — `PASS`

`src/lib/connectors/pipeline.ts`: discover → normalize → validate → upsert
(`firstSeenAt` on creation, `lastSeenAt` on every sighting, `activeState`)
→ a `JobSnapshot` on creation and on every CONTENT change (hash of the
normalised posting) → `JobSourceRun` with counts and the query shape. Three
consecutive failures mark a source `degraded`; a success clears it — both
transitions decided by the database against the row's current state, so a
source an admin disabled mid-run is never re-enabled by the run (§11 M6).
`activeState` / `closedAt` are WRITTEN here and consumed by nothing yet:
feeds, matches and applications still show closed postings until Stage 06
reads them (§11 L2). `runRefresh`, `fetch`, `detectClosed` and
`getApplicationRoute` likewise have no production caller yet; Stage 06 wires
the freshness sweep.

| Assertion | Result |
| --- | --- |
| A run records discovered / created / updated / rejected and the query SHAPE, never the query text | PASS |
| A new posting has one snapshot; an unchanged re-capture moves `lastSeenAt` and adds none; a content change adds exactly one; the database refuses an UPDATE on any snapshot | PASS |
| refresh: a posting the source no longer lists closes with `closedAt`; a listed one is re-seen; nothing is inferred | PASS |
| health runs for a disabled source and reports missing credentials as `down` | PASS |
| The scanner runs discovery through the pipeline (`JOB_PROVIDER` names the source) and scores the returned jobs | route code; scanner unchanged in behaviour otherwise |

## 6. `AtsRulesets` under governed administration — `PASS`

Moved out of the CMS (`src/cms/collections/AtsRulesets.ts` and
`src/lib/cms-fast/ats.ts` deleted, `payload-types.ts` regenerated) into
`AtsRuleset` with the PromptVersion discipline: draft → approved by a SECOND
admin → active (one per platform; activating an older approved version is
the rollback, recorded as one) → retired; step-up on every change; an audit
row per change with the selector KEYS, never the selectors. The v1 API reads
the active version cache-first (today its only consumer: the apply engine
does not read rulesets until Stage 12); activation invalidates.

**No stealth.** The CMS schema offered a "heavy stealth" anti-bot level.
ADR-0008 prohibits fingerprint evasion, so `pacing` is `standard` or
`human_delay` and the validator refuses anything else. A ruleset cannot
express evasion. `human_delay` is declared for the assisted flow; nothing
enforces it until Stage 12 (§11 L1).

| Assertion (`tests/ats-rulesets.test.ts`) | Result |
| --- | --- |
| Every selector key required; `heavy_stealth` refused | PASS |
| Author cannot approve; second admin can; activate serves; audit in order | PASS |
| Activating v2 demotes v1 and invalidates the cache; activating v1 again is `ats_ruleset.rollback` with the reason | PASS |
| The active version cannot be retired; exactly one active per platform | PASS |

## 7. Object storage — `PASS` for the abstraction; `IMPLEMENTED-NOT-VALIDATED` for S3

`src/lib/storage/`: a `StorageProvider` interface, the local filesystem as
the default (unchanged behaviour, key escapes refused), and an
S3-compatible adapter signed with SigV4 by hand (no SDK) whose **region
must be on the residency allow-list** (`ca-central-1`, `ca-west-1`;
ADR-0015) or the provider refuses to start. Selection by
`STORAGE_PROVIDER`, warn-and-degrade to local. The signer is deterministic
and never carries the secret; put/get/list go through an injected fetch
with signed headers. **No bucket has been contacted from this codebase.**

## 8. Gate status

Recorded at the review-fix head. The first recording of this table (commit
`a31661c`) was taken from a working tree in which three storage source files
were hidden from git by an unanchored `.gitignore` rule, so CI's typecheck
failed on the commit while the local tree passed; and its test run had
`DATABASE_URL` overridden in the recording shell, which the documented
command did not do (§11 H2, CI-1). Both are fixed; the numbers below were
produced with exactly the command in `CLAUDE.md` (the two test URLs and
nothing else) on a tree whose committed content was verified from
`git archive`.

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **914 / 914**, 0 skipped (Stage 04: 871) — new: `connectors` 22 (contract ×2 + base + register + mock determinism), `connector-pipeline` 8, `ats-rulesets` 5, `storage-provider` 7 |
| Build | passes; `/console/sources`, `/console/ats-rulesets`, their routes present |
| Migrations | applied fresh; drift clean; 99/99 forced; `20260903120000_connector_review_fixes` applied on top |
| Generated files | `payload-types.ts` regenerated; import map unchanged; RLS migration equals the generator output (diff empty) |

## 9. Exit gate — verdict

| Condition | State |
| --- | --- |
| A new lawful source is added without touching application code | **MET** — a definition in the register + an adapter passing the contract suite; the scanner and the console know nothing about individual sources |
| Connector contract suite every adapter passes | **MET** |
| `AtsRulesets` under governed administration | **MET** |
| Object storage replaces the local filesystem | **MET as an abstraction; S3 adapter NOT VALIDATED** |
| ≥ 2 lawful sources live | **NOT MET** — one source (the synthetic mock) is enabled; Adzuna is registered, gated and disabled |
| Adzuna reclassified `PRODUCTION-VALIDATED` | **NOT MET — BLOCKED (CREDENTIAL + EXTERNAL_SERVICE)**: no `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` reaches the build, and no request has been made; a live run is an operator action once credentials exist (record the terms at `/console/sources`, enable, run a health check and a discovery, paste the redacted run row into the PR) |
| Live smoke test per credentialed source | **NOT MET** — no credentialed source |

**Verdict: Stage 05 passes every engineering gate reachable from this
environment and is PARTIAL at its exit**: the two conditions that need a
live, credentialed source are BLOCKED on credentials the build does not
hold, not on engineering. Everything that can be proven without them is
proven, and the framework refuses to pretend otherwise — the register shows
Adzuna disabled with an empty legal basis until a person fills it. Merge
posture inherited from the stack.

## 10. What a founder or operator has to do

1. **Adzuna credentials and terms** — obtain `ADZUNA_APP_ID` /
   `ADZUNA_APP_KEY`; read the API terms; at `/console/sources` record the
   legal basis, robots position, rate limit and attribution, then enable.
2. **Live validation** — run the health check and one discovery from the
   console; attach the redacted `JobSourceRun` row to the PR; then the
   register can say `PRODUCTION-VALIDATED`.
3. **A second lawful source** — the next candidates in ADR-0008 order are an
   authorised feed or a public ATS board interface (Greenhouse / Lever job
   boards), each needing its own per-connector record first.
4. **Object storage** — a Canadian-region bucket and `STORAGE_S3_*`; one
   put/get from a deployment to move the S3 adapter off `IMPLEMENTED-NOT-VALIDATED`.
5. **Staging** — unchanged (R-34).

## 11. Independent review — 2 HIGH, 6 MEDIUM, 8 LOW; every HIGH and MEDIUM closed with a test

A separate reviewer with no shared context read the full diff (`f262139..939fbb2`),
ran the suites and the RLS generator, and probed the pipeline and the signer
against the local database. Dispositions:

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| H1 | HIGH | `upsertPosting` was find-then-create with no unique-violation handling: two runs of the same source racing on a new posting failed the whole run and counted toward `degraded` (three concurrent calls: two `P2002`) | **FIXED** — the loser of the race catches `P2002` and proceeds as an update of the winner's row; job + snapshot are written in one transaction on both paths. Test: three concurrent `upsertPosting` on one new id resolve to one row, one `isNew`, one snapshot |
| H2 | HIGH | `tests/ats-rulesets.test.ts` (and, found while fixing, `prompt-registry` and `taxonomy`) statically import a module that reaches `src/lib/db`, which instantiates the client from `DATABASE_URL` at load; the `before()` override came too late, so the documented command ran those suites against whatever `DATABASE_URL` the shell held, and the "907/907" claim was reproducible only with the shell's override | **FIXED** — `tests/helpers/database-env.ts` is imported FIRST by every such suite and points `DATABASE_URL` at `TENANCY_TEST_DATABASE_URL` before any `src/` module loads. Proof: the full suite run with `DATABASE_URL` and `DIRECT_URL` unset and only the two documented variables (§8) |
| M1 | MED | `runHealthCheck` skipped the gate and, with credentials present, made a live call for a source whose per-connector record was incomplete — the first request to a third party before any legal basis was recorded | **FIXED** — an incomplete record answers `down` / "record incomplete" without loading the adapter; missing credentials are named without loading it either. Test: credentials in the environment, record incomplete, `fetch` stubbed and asserted uncalled |
| M2 | MED | The mock folded the result-list index into `postedAt`, so the same posting hashed differently per query and every agent with a different query wrote a spurious "content changed" snapshot | **FIXED** — the hour spread is derived from the template's own hash. Test: two overlapping queries and `fetch` agree on `postingHash` for every shared posting |
| M3 | MED | `approve` / `activate` / `retire` read the row BEFORE taking the platform lock and checked the stale copy: a concurrent activate + retire could retire the now-active version, leaving no active ruleset and no rollback audit | **FIXED** — `loadLocked`: read the platform, lock, read AGAIN, check the row as it is under the lock. Test: ten rounds of concurrent activate + retire on a fresh approved version; exactly one succeeds and exactly one version is active each round |
| M4 | MED | The S3 signer dropped the endpoint's path component, so a gateway such as Supabase's `/storage/v1/s3` signed and targeted the wrong resource | **FIXED** — the prefix is part of the canonical URI and the URL. Test: gateway endpoint → `…/storage/v1/s3/<bucket>/<key>`, signature differs from the host-only form |
| M5 | MED | Adzuna's adapter put up to 180 characters of the upstream response body into its error, which the pipeline stores on the run and the source and the console renders — contrary to the contract's "never a body" | **FIXED** — status code only. Test: a 503 with a marker body → the marker appears in neither the health detail nor the discovery error |
| M6 | MED | `finishRun` decided `degraded → enabled` and the failure threshold from the `JobSource` copy captured at gate time: a success could overwrite an admin's `disabled` set during the run, with no audit row, and the threshold was inexact under concurrency | **FIXED** — recovery is `updateMany … WHERE status = 'degraded'`, the count is incremented in the database and the threshold evaluated on the incremented value; `disabled` is never touched. Test: three failures → degraded, a success on a stale copy → enabled, a success while disabled → still disabled |
| L1 | LOW | Evidence claims without a backing test: degraded/recovery; "the v1 API **and the engine**"; `human_delay` "means assisted-apply only"; the contract's "never infer closure" only checked membership in the enum; the tenant snapshot-insert test accepted a foreign-key error; the SigV4 test checked shape, not a known answer | **FIXED** — degraded/recovery tested (M6); wording corrected in §5, §6, the module comment and the UI label; the contract now requires `unknown` for an id the source cannot know, the mock answers `unknown` for a non-mock id, and the pipeline's `unknown` branch is tested (stays open, `closedAt` null, not re-seen); the RLS test inserts against a REAL job id; three known-answer signatures computed by an independent Python (hashlib/hmac) implementation are asserted exactly |
| L2 | LOW | `activeState` / `closedAt` are written and read by nothing | **DOCUMENTED** (§5): Stage 06 consumes them |
| L3 | LOW | `refresh`, `detectClosed`, `fetch`, `getApplicationRoute` have no production caller; `ATS_<VENDOR>_DEFAULT` was described as "an employer-issued credential for it" | **DOCUMENTED / FIXED** — §5 says which paths wait on Stage 06; the routing comment now says the default key is a deployment decision, not an employer's |
| L4 | LOW | Every tenant scan against a disabled source wrote a `refused` run; `JobSourceRun` had no index on `startedAt` alone though the console orders by it | **FIXED** — refusals are coalesced per source and kind within a ten-minute window (the row carries the latest reason and a count); `JobSourceRun_startedAt_idx` in `20260903120000_connector_review_fixes`. Test: several refused discoveries → one row in the window |
| L5 | LOW | `Job.firstSeenAt` defaulted to migration time for every pre-existing row although `scrapedAt` held the real first capture | **FIXED** — the same migration sets `firstSeenAt = scrapedAt` where the default stamped it later (idempotent) |
| L6 | LOW | A residency violation threw from the S3 constructor at first use, outside `createApplicationFolder`'s guard, after the `Application` row existed | **FIXED** — the provider degrades to the local filesystem, logs the refusal once (without the secret) and remembers the fallback; the provider is resolved inside the guard. Test: `us-east-1` → local provider, one log line, no secret |
| L7 | LOW | `deleteMany({ platform: 'taleo' })` in the ruleset test is destructive against whatever database it points at | **MITIGATED by H2** — it now provably points at the test database; the platform is a fixture-only value |
| L8 | LOW | CLAUDE.md item order; `DATABASE_MIGRATIONS.md` row order; the local filesystem listed as "MOCK / default" | **FIXED** |

### CI findings on the first push (before the review returned)

| # | Finding | Disposition |
| --- | --- | --- |
| CI-1 | The `storage/` rule in `.gitignore` (the user-data folder) was unanchored and also matched the new `src/lib/storage/` source directory: `provider.ts`, `local.ts` and `s3.ts` never entered the commit; local typecheck passed, CI's failed | **FIXED** (`939fbb2`) — rule anchored to `/storage/`; the committed tree typechecked from a `git archive` extract; no other ignored file exists under `src/`, `tests/`, `prisma/` or `scripts/` |
| CI-2 | `tests/digital-twin-backfill.test.ts` (Stage 02) asserted idempotence with GLOBAL row counts while test files run in parallel; a sibling suite inserted a project between its two reads (1 → 2) | **FIXED** (`c4aa802`) — counts scoped to the backfilled user and the first read asserted against the migration's reported rows |

# Stage 05 — Job source connector framework — evidence

Recorded 2026-09-03 on branch `claude/stage-05-job-source-connectors`,
stacked on Stage 04 (PR #16) → 03 (#15) → 02 (#14) → 01 (#13, PARTIAL).
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
consecutive failures mark a source `degraded`; a success clears it.

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
row per change with the selector KEYS, never the selectors. The v1 API and
the engine read the active version cache-first; activation invalidates.

**No stealth.** The CMS schema offered a "heavy stealth" anti-bot level.
ADR-0008 prohibits fingerprint evasion, so `pacing` is `standard` or
`human_delay` and the validator refuses anything else. A ruleset cannot
express evasion.

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

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **907 / 907**, 0 skipped (Stage 04: 871) — new: `connectors` 20 (contract ×2 + base + register), `connector-pipeline` 6, `ats-rulesets` 4, `storage-provider` 4 |
| Build | passes; `/console/sources`, `/console/ats-rulesets`, their routes present |
| Migrations | applied fresh; drift clean; 99/99 forced |
| Generated files | `payload-types.ts` regenerated; import map unchanged |

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

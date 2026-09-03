# Stage 14 - Candidate mobile: the API contract - evidence

Recorded 2026-09-03 on branch `claude/stage-14-candidate-api-contract`,
(PR #26), stacked on Stage 13 (PR #25) - 12 (#24) - 11 (#23) - 10 (#22) - 09 (#21) -
08 (#20) - 07 (#19) - 06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) -
01 (#13, PARTIAL). Every line was run or read; nothing is PASS on the
strength of a mock, a skipped test or a document. This stage's honest
centre: **the plan's exit gate is "contract frozen and versioned before app
work begins", and that is what is delivered - a published OpenAPI document,
the backend proven against it, the hash locked. The Expo application is NOT
built: no React Native toolchain exists in this environment, and the plan
sequences the app after the frozen contract. "Mobile consumes only the
published contract" is therefore NOT TESTABLE yet and is stated, not
approximated.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 14: React Native + Expo, candidate-first. The
real blocker: no stable API contract. Publish OpenAPI for the candidate
surface first; version it; then build Expo (ADR-0013). Scope:
recommendations, job detail, match analysis, applications, folder,
interviews, notifications. Security: the same auth, no privileged endpoints.
Testing: contract tests web-to-mobile. Acceptance: mobile consumes only the
published contract. Exit gate: contract frozen and versioned before app work
begins.

## 2. The contract - `PASS`

`docs/api/openapi.candidate.v1.json` - OpenAPI 3.1.0, version 1.0.0, frozen
2026-09-03. Thirteen operations:

| Operation | Path | Scope | Response schema |
| --- | --- | --- | --- |
| getMe | `GET /v1/me` | read | Me |
| listRecommendations | `GET /v1/recommendations` | read | JobList |
| listJobs | `GET /v1/jobs` | read | JobList |
| getJob | `GET /v1/jobs/{jobId}` | read | JobDetail (with the eligibility verdict) |
| getMatchAnalysis | `GET /v1/matches/{matchId}` | read | MatchAnalysis (dimensions with cited evidence ids) |
| listApplications | `GET /v1/applications` | read | ApplicationList |
| getApplication | `GET /v1/applications/{applicationId}` | read | ApplicationDetail (the whole folder) |
| confirmApplication | `POST /v1/applications/{applicationId}/confirm` | apply:write | ApplicationDetail |
| submitApplication | `POST /v1/applications/{applicationId}/submit` | apply:write | ApplicationDetail |
| listInterviews | `GET /v1/interviews` | read | InterviewList |
| listNotifications | `GET /v1/notifications` | read | NotificationList |
| getAnalyticsSummary | `GET /v1/analytics/summary` | read | AnalyticsSummary |
| getAtsRuleset | `GET /v1/ats-rulesets/{platform}` | read | AtsRulesetLookup |

Every error response references the one `Error` envelope. Nine of the
thirteen are new in this stage (`src/lib/integrations/candidate-api.ts` and
the route files); four pre-existed and are now under the contract.

## 3. Frozen and versioned - `PASS`

`docs/api/openapi.candidate.v1.lock`: `1.0.0` and the SHA-256 of the
canonical document. `tests/candidate-api-contract.test.ts` fails when the
document and the lock disagree; `npm run api:freeze` re-locks after a
deliberate change and refuses a structurally unsound document. ADR-0028: a
breaking change is version 2 at a new path, never an edit.

## 4. The backend against the contract - `PASS`

`tests/candidate-api-contract.test.ts`:

- pure: the document is 3.1 and semver, every operation has a scope and a
  2xx schema, every error uses the envelope, every path parameter is
  declared required, every `$ref` resolves; the contract's paths and the
  route files under `src/app/(app)/api/v1` are the same set, both ways; the
  `Error` schema accepts what `http.ts` emits and rejects other shapes.
- database, with real API keys: every GET answers with a body that
  validates against its declared schema (ajv, JSON Schema 2020-12); a
  never-automated question carries no value through the API whatever is
  stored; a contact's address is not in the folder contract; another key
  gets the 404 envelope for the same job, match and application ids and an
  empty list; a `read` key is refused `apply:write` with the
  `insufficient_scope` envelope; an unknown key gets the 401 envelope;
  `submit` on a non-permitting mode is refused with the envelope and nothing
  moves, and on an unauthorised board likewise; `confirm` with `apply:write`
  moves the record through the status machine (source `confirm`), seals the
  documents and returns a valid folder; a second `confirm` is refused.

Date-time formats are documented for clients and not validated by ajv (no
`ajv-formats` in the dependency set); the serialisers emit ISO-8601 from
`Date.toISOString()` throughout.

## 5. Security posture - `PASS`

The same API-key authentication, scopes and rate limits as the existing v1
(`v1Route`); ownership through the key's user (JobMatch through its agent)
on every operation; no staff or billing operation; no document bytes (signed
links stay on the web app); the folder carries ids, kinds, dates and hashes -
never a note body or a contact's address; notifications carry ids and fixed
messages only. The two writes are the applicant's own acts under Stage 12's
rules; nothing submits without their click; `applicationMode` can never be
Approved Auto-Apply.

## 6. Not built, stated

- **The Expo app** - NOT IMPLEMENTED. No React Native toolchain exists in
  this environment; the plan's exit gate precedes app work. "Mobile consumes
  only the published contract" and "device matrix / offline behaviour" are
  NOT TESTABLE until the app exists.
- **Push notifications** - the `notifications` operation is a pull; push
  waits on the ADR-0011 event stream (not built).
- **Generated client types** - not generated here (no generator in the
  dependency set); the document is the source for one.

## 7. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 |
| Tests | **1078 / 1078**, 0 skipped (Stage 13: 1070) - new: `candidate-api-contract` 8 (4 pure, 4 database) |
| Build | passes; the nine new `/api/v1/*` routes present |
| Migrations | none in this stage (thirty-five, unchanged; drift clean) |

## 8. Exit gate - verdict

| Condition | State |
| --- | --- |
| Contract published for the candidate surface | **MET** - thirteen operations, every shape a component schema |
| Contract versioned and frozen | **MET** - 1.0.0, hash-locked, test-enforced, change rule in ADR-0028 |
| Contract tests run in CI against the web backend | **MET** - in the suite CI runs |
| Mobile consumes only the published contract | **NOT TESTABLE** - no app exists (NOT IMPLEMENTED, stated) |
| Device matrix, offline behaviour, push | **NOT MET** - app not built; push waits on ADR-0011 |

**Verdict: Stage 14 meets its exit gate as the plan words it - the contract
is frozen and versioned before app work begins - and is PARTIAL on the
stage's objective**, which is the app itself, NOT built here and stated.
Merge posture inherited from the stack.

## 9. What a founder or operator has to do

1. Decide the mobile build environment (Expo / EAS) and generate the client
   from `docs/api/openapi.candidate.v1.json`; the app consumes only that.
2. Mint API keys for the app's users through the existing key flow (ADR-0004
   token storage rules apply: Keychain / Keystore, never AsyncStorage).
3. Push notifications wait on ADR-0011.
4. Staging - unchanged (R-34).

## 10. Independent review

PENDING - recorded here when done.

# Stage 14 - Candidate mobile - evidence

Recorded 2026-09-03 (the contract) and 2026-09-05 (the app, the 1.1.0
amendment, the review fixes) on branch `claude/stage-14-candidate-api-contract`
(PR #26), stacked on Stage 13 (PR #25) - 12 (#24) - 11 (#23) - 10 (#22) -
09 (#21) - 08 (#20) - 07 (#19) - 06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) -
02 (#14) - 01 (#13, PARTIAL). Every line was run or read; nothing is PASS on
the strength of a mock, a skipped test or a document. This stage's honest
centre: **the contract is frozen and versioned (1.1.0) and the backend is
proven against it; the Expo app exists under `mobile/`, consumes only that
contract, typechecks, passes its tests and bundles - and has never run on a
phone. Everything a device would prove (a real Keychain, a screen reader, a
network drop mid-tap, a store build) is NOT VERIFIED and is written that way.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 14: React Native + Expo, candidate-first.
Publish OpenAPI for the candidate surface first; version it; then build Expo
(ADR-0013). Scope: recommendations, job detail, match analysis,
applications, folder, interviews, notifications. Security: the same auth,
platform-secure token storage, no privileged endpoints. Testing: contract
tests web-to-mobile; device matrix; offline behaviour. Acceptance: mobile
consumes only the published contract. Exit gate: contract frozen and
versioned before app work begins.

## 2. The contract - `PASS`

`docs/api/openapi.candidate.v1.json` - OpenAPI 3.1.0, **version 1.1.0**,
frozen 2026-09-05 (1.0.0 was frozen 2026-09-03 with thirteen operations; the
1.1.0 amendment is additive, ADR-0028 §Amendment). Twenty-five operations on
twenty-two paths, thirty-seven schemas:

| Operation | Path | Scope | Response | Since |
| --- | --- | --- | --- | --- |
| getMe · **updateMe** | `GET` · `PATCH /v1/me` | read · write | Me | 1.0 · 1.1 |
| listRecommendations | `GET /v1/recommendations` | read | JobList | 1.0 |
| listJobs | `GET /v1/jobs` | read | JobList | 1.0 |
| getJob | `GET /v1/jobs/{jobId}` | read | JobDetail (eligibility verdict; `saved` since 1.1) | 1.0 |
| **saveJob · unsaveJob** | `PUT` · `DELETE /v1/jobs/{jobId}/saved` | write | SavedJob · Revoked | 1.1 |
| **listSavedJobs** | `GET /v1/saved-jobs` | read | SavedJobList | 1.1 |
| getMatchAnalysis | `GET /v1/matches/{matchId}` | read | MatchAnalysis | 1.0 |
| listApplications | `GET /v1/applications` | read | ApplicationList | 1.0 |
| getApplication | `GET /v1/applications/{applicationId}` | read | ApplicationDetail | 1.0 |
| confirmApplication | `POST .../confirm` | apply:write | ApplicationDetail | 1.0 |
| submitApplication | `POST .../submit` | apply:write | ApplicationDetail | 1.0 |
| **createDocumentLink** | `POST .../documents/{documentId}/link` | read | DocumentLink (201) | 1.1 |
| listInterviews | `GET /v1/interviews` | read | InterviewList | 1.0 |
| listNotifications | `GET /v1/notifications` | read | NotificationList | 1.0 |
| getAnalyticsSummary | `GET /v1/analytics/summary` | read | AnalyticsSummary | 1.0 |
| getAtsRuleset | `GET /v1/ats-rulesets/{platform}` | read | AtsRulesetLookup | 1.0 |
| **createDeviceSession** | `POST /v1/auth/sessions` | **public** (`security: []`) | DeviceSessionIssued (201) | 1.1 |
| **listDeviceSessions** | `GET /v1/auth/sessions` | read | DeviceSessionList | 1.1 |
| **revokeCurrentDeviceSession** | `DELETE /v1/auth/sessions/current` | read | Revoked | 1.1 |
| **revokeDeviceSession** | `DELETE /v1/auth/sessions/{sessionId}` | write | Revoked | 1.1 |
| **listConsents** | `GET /v1/consents` | read | ConsentList | 1.1 |
| **setConsent** | `PUT /v1/consents/{purpose}` | write | Consent | 1.1 |
| **listEvidence** | `GET /v1/evidence` | read | EvidenceList | 1.1 |

Every error response references the one `Error` envelope (now with
`unavailable` for a 503). **Every object schema is closed**
(`additionalProperties: false`) and **every operation documents 401 and
429** - both from the independent review of 1.0.0 (§10), both enforced by
`contractProblems()` so the next edit cannot regress them. Exactly one
operation is public, and a test says so by name.

## 3. Frozen and versioned - `PASS`

`docs/api/openapi.candidate.v1.lock`: `1.1.0` and the SHA-256 of the
canonical document. The test fails when they disagree; `npm run api:freeze`
re-locks a deliberate change and refuses an unsound document. The 1.0.0 to
1.1.0 move followed ADR-0028 rule 4 exactly: additive, minor version,
re-freeze, `x-changelog` in the document. Nothing from 1.0.0 was removed or
changed in meaning; the two `allOf` compositions were flattened to the same
effective shape so they could be closed.

## 4. The backend against the contract - `PASS`

`tests/candidate-api-contract.test.ts` - **17 tests: 6 pure, 11 database**:

- Pure: structure (3.1, semver, scopes, envelopes, closed objects, 401/429),
  the lock, route-file parity both ways (22 paths = 22 route files under
  `src/app/(app)/api/v1`), the single public operation, a leaked column
  fails validation (proved with a `passwordHash` on `Me`), the envelope.
- Database, with real keys against local PostgreSQL 16: every 1.0 GET
  validates against its declared schema and every `*At` parses; ownership
  (a stranger's key gets 404s, empty lists); scope refusal and the 401
  envelope; submit refused on a non-permitting mode and on an unauthorised
  board with nothing moved; confirm through the status machine returns a
  valid folder and a second confirm is 409.
- 1.1, database: the password mints a device key that works, is listed as
  current, signs itself out and is then refused (the row is kind `device`,
  scope `write`, expires in ~90 days, the secret is not stored, a wrong
  password mints nothing, the supabase method without a provider is 503
  `unavailable`, an integration key cannot be signed out this way); devices
  are revoked by the owner and not by a stranger (404, still works), a
  password change revokes them all, no audit row carries a key; PATCH /me
  edits and refuses the unreachable mode (403), an empty or unknown-field
  patch (400), a read key (403); consents list six purposes with state,
  marketing grants once and withdraws, a required purpose cannot be
  withdrawn (409), the L-3 purpose cannot be granted (409, nothing recorded),
  an unknown purpose is 404; saved jobs are idempotent, scoped to matched
  postings (a stranger's save is 404), visible on the job detail, listed,
  unsaved; a document link is a valid signed link bound to the owner (201)
  and 404 for a stranger; evidence lists claims, never `facts`, none for a
  stranger, a bad status filter is 400.

## 5. The app - `PASS (engineering) · NOT VERIFIED (device)`

`mobile/` - Expo SDK 57, React Native 0.86, expo-router, TypeScript strict;
its own package and lockfile, excluded from the root toolchain, with its own
CI job (`.github/workflows/ci.yml` › mobile). `mobile/README.md` is the
deterministic build and test recipe.

**Consumes only the contract.** `mobile/src/api/schema.d.ts` is generated
from the document (`npm run api:types`) and diffed in CI; the client's
`PATHS` names every path it calls; `tests/contract-parity.test.ts` fails if a
client path is not in the document, if a document path has no client method
(the one exception, the ATS ruleset lookup, is asserted by name), if the
generated types are stale, if any screen or module calls `fetch` or
hard-codes a `/v1` path, if AsyncStorage is imported, or if anything that
looks like a key or secret is in the source.

**Screens** (file = route under `mobile/app/`): sign-in; onboarding notice
(the web finishes onboarding; the app says what it can do meanwhile); Jobs
(recommendations, saved); job detail with the eligibility verdict rule by
rule and the match; match analysis with dimensions, matched / missing,
cited-evidence counts; Applications (waiting for review first, needs
attention, all); the folder with every prepared field and answer (a
never-automated question shows no value), documents through a signed link,
completeness, contacts, interviews, follow-ups, assessments, history, and
the two decisions - **confirm** ("I submitted it on the employer's form")
and **submit** ("submit it for me now", shown only in Review & submit mode
on an authorised board), each behind a confirmation dialog, each disabled
offline; Interviews (upcoming / past); Activity (pull, no push); You: profile
summary, edit (name, city, headline, mode with the radio group and the
plain statement that no automatic mode exists), career evidence read-only,
your numbers, privacy & consent (switches; required and unavailable purposes
locked with the reason), signed-in devices (this device flagged, others
revocable), sign out (revokes the key, wipes the device).

**States.** Every read has loading, error (with retry), empty (with what to
do), and offline: on a network failure the screen shows the device's saved
copy with a banner naming its age, and every action is disabled - there is
no offline queue, on purpose (ADR-0016). A 401 ends the session at once.

**Security.** Device keys per ADR-0029; `expo-secure-store` with
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` (memory only in a browser tab, stated on
the sign-in screen); the cache holds only allow-listed GET bodies (never a
write, a device list, a signed link), aged out at seven days, cleared on
sign-out; release builds refuse a plain-http API; no secret in the bundle.

**Accessibility (engineering).** Roles and labels on every control,
44-point touch targets, font scaling on, rows as single accessible
elements, alerts and the offline banner as live regions, a real radio group
for the mode, headers marked; light and dark tokens meet WCAG 2.2 AA
contrast - **computed** by `tests/theme.test.ts` (the first draft failed it
three times and was corrected, which is the point of computing it).

**Gates run here** (`mobile/`): `npm run typecheck` 0 errors;
`npm test` **24 / 24** (client 6, cache 4, contract parity 4, format /
device / config 5, contrast 3 + 2 more); `npm run export:web` bundles every
screen with Metro (1.2 MB web bundle, 0 errors) - the compile gate.

**NOT VERIFIED (no device, no emulator, no store account here).** Running
on iOS or Android; the Keychain / Keystore write; VoiceOver / TalkBack;
dynamic type at the largest sizes; a network drop between tap and response;
deep links; the store build (`expo prebuild` / EAS). **NOT IMPLEMENTED,
stated:** push notifications (ADR-0011), biometric unlock, certificate
pinning, identity-provider sign-in in the UI (the server and the contract
support it; no provider is configured anywhere), document editing, billing
(ADR-0013 keeps them on the web).

## 6. Security posture - `PASS`

- One authentication path for `/api/v1`: the device key is an `ApiKey`
  (migration `20260905100000_api_key_kind`, additive: `kind`, `platform`),
  never `admin`, minted only by a sign-in, capped, expiring, revoked by the
  owner, by a password change (`src/app/(app)/api/auth/password/route.ts`)
  and by sign-out-everywhere (`.../auth/sessions/route.ts`, which now lists
  devices beside browser sessions). Two new security events; no key in any
  audit row (tested).
- The public sign-in is rate limited by address on the sign-in rule and
  audits failures against the digest of the address.
- The review's MEDIUM: `confirmAssistedSubmission` now claims the record
  under the same advisory lock as `submitThroughAts`, checking
  `ready_to_submit` inside the locked transaction - two confirmations
  arriving together cannot both write a history row.
- Redaction of a never-automated answer keys on `policy` as well as
  `decision`, matching the internal invariant.
- Nothing staff-only, no billing, no document bytes, no mailbox content, no
  sensitive-schema field in any response; the static allowlist tests are
  unchanged and green.

## 7. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 8 warnings (baseline) |
| Typecheck | 0 (root; `mobile/` excluded and typechecked on its own: 0) |
| Tests | **1087 / 1087**, 0 skipped (Stage 13: 1070) - `candidate-api-contract` 17 (was 8); `mobile/` **24 / 24** |
| Build | passes; twenty-two `/api/v1/*` routes present; `mobile/` web bundle 0 errors |
| Migrations | **thirty-six** (one new, additive); fresh-database rehearsal: 36 applied, `migrate diff` clean, **120** forced-RLS public tables (unchanged: no new table) |

## 8. Exit gate - verdict

| Condition | State |
| --- | --- |
| Contract published for the candidate surface | **MET** - 25 operations, every shape a closed component schema |
| Contract versioned and frozen before app work | **MET** - 1.0.0 frozen 2026-09-03; the app was built on 2026-09-05 against 1.1.0, an additive amendment under the ADR-0028 rule |
| Contract tests run in CI against the web backend | **MET** - 17 tests in the suite CI runs |
| Mobile consumes only the published contract | **MET (engineering)** - generated types, path parity, no direct fetch, all test-enforced in CI |
| Same auth as web, platform-secure storage, no privileged endpoints | **MET (engineering)** - ADR-0029; secure store NOT VERIFIED on a device |
| Offline behaviour: read-only cache, no offline submission | **MET (engineering)** - policy tested; a real network drop NOT VERIFIED |
| Device matrix | **NOT VERIFIED** - no device or emulator in this environment |
| Push notifications | **NOT IMPLEMENTED** - waits on ADR-0011 |
| Staging rehearsal | **NOT VERIFIED** (R-34) |

**Verdict: Stage 14 is PASS on engineering** - contract, backend proof and
the app that consumes only the contract - **and PARTIAL on the stage as a
whole**, because the device matrix and the real-device security proofs are
NOT VERIFIED here and push is NOT IMPLEMENTED. Merge posture inherited from
the stack.

## 9. What a founder or operator has to do

1. Run the app on a device: `cd mobile && EXPO_PUBLIC_API_BASE_URL=https://<deployment> npm start`,
   Expo Go on iOS and Android; confirm sign-in, the Keychain / Keystore
   write, VoiceOver / TalkBack on the folder screen, a network drop mid-tap.
2. Decide on a store build (Apple Developer and Google Play accounts - paid,
   founder actions), then `npx expo prebuild` / EAS.
3. Push notifications: ADR-0011 first (the event stream), then a push
   provider decision.
4. Biometric unlock and certificate pinning: native modules / config plugins,
   proven on a device.

## 10. Independent review

Adversarial review of the 1.0.0 stage (a separate agent, 2026-09-05, against
the committed head `88de4d1`), then the fixes below; a second review of the
1.1.0 amendment and the app follows the first push and is recorded in §11.

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | MEDIUM | `confirm` had no advisory lock: two simultaneous confirmations could both pass the status check and both write a history row; `submit` was locked, `confirm` was not | **FIXED** - the check and the move run under `pg_advisory_xact_lock('application:submit:<id>')` in one transaction; the second finds `submitted` and is refused |
| 2 | MEDIUM | No response schema was closed, so a serialiser leaking a column (`passwordHash` on `Me`, proved) validated fine | **FIXED** - every object schema `additionalProperties: false`, `allOf` flattened, enforced by `contractProblems()`, proved by a test that a leaked column fails |
| 3 | LOW | A comment claimed the test checks dates parse; it did not | **FIXED** - `conforms()` walks every response and parses every `*At`; the comment now says that |
| 4 | LOW/MED | 401 and 429 documented inconsistently; `contractProblems()` did not care | **FIXED** - every keyed operation documents 401, every operation 429, both enforced |
| 5 | LOW | The ATS ruleset lookup is in a "candidate" contract with `read` scope | **RECORDED** - removing it is breaking; the app does not call it (asserted); the engine's use is unchanged; noted in ADR-0028 |
| 6 | LOW | `/v1/notifications` is the first candidate-facing list of mailbox-derived detections | **RECORDED as deliberate** - ids, a fixed-dictionary message and a type only; the web folder shows the same events (Stage 11); noted in ADR-0028 |
| 7 | LOW | Never-automated redaction keyed on `decision` only, the internal check on `decision` or `policy` | **FIXED** - both |

Sound per the reviewer: tenant scoping on every route (verified live),
Stage 12 gate reuse in `submit`, no staff / billing / sensitive / mailbox /
document bytes in any shape, enums matching the code exactly, the freeze
mechanism, route-file parity, pagination consistency, the lint / typecheck
baseline.

## 11. Independent review of 1.1.0 and the app

PENDING - a separate adversarial pass over the 1.1.0 amendment, the device sessions and `mobile/` runs after the first push of this work; its findings and fixes are recorded here.

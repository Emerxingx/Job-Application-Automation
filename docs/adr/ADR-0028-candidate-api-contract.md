# ADR-0028 - The candidate API contract is a frozen, versioned OpenAPI document that the backend is tested against; the mobile app consumes only it

**Status:** Accepted (Stage 14, 2026-09-03; amended to 1.1.0 on 2026-09-05, see below) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 14; ADR-0013 steps 1, 2 and (with ADR-0029 and `mobile/`) 3 · **Depends on:** ADR-0004 (API keys), ADR-0016 (no autonomous submission), ADR-0024 (folder), ADR-0026 (assisted application)

## Context

ADR-0013 made the sequence non-negotiable: publish an OpenAPI contract for
the candidate surface, freeze it with contract tests in CI, then build the
Expo client against it. `/api/v1` exposed four endpoints; the other routes
were first-party, shaped for the web client, with a different error
envelope. A mobile client built on those would freeze internal endpoints
into a public contract by accident.

## Decision

1. **The contract is a file in the repository**:
   `docs/api/openapi.candidate.v1.json` (OpenAPI 3.1, JSON Schema 2020-12).
   It covers the candidate surface ADR-0013 scopes for v1 - the profile
   summary, recommendations, jobs and job detail with the eligibility
   verdict, match analysis with cited evidence ids, applications and the
   whole folder, the two writes (confirm; instructed submit), interviews,
   notifications, the analytics summary, the ATS ruleset lookup - and
   nothing staff-only, nothing billing, no document bytes.
2. **Every operation names its scope and its schemas.** `x-scope` is the API
   key scope the route enforces (`read` for every GET; `apply:write` for the
   two POSTs). Every response, success or error, references a component
   schema; every error uses the one `Error` envelope `http.ts` emits.
3. **The backend is tested against the document.** `tests/candidate-api-contract.test.ts`
   checks the document's structure, that its paths and the route files under
   `src/app/(app)/api/v1` are the same set both ways, and - against the
   database with real keys - that every GET's body validates against its
   declared schema, that another key gets the 404 envelope for the same ids,
   that a `read` key is refused `apply:write` with the envelope, and that the
   two writes move the record through the status machine and return a valid
   folder. Runs in CI with the rest of the suite.
4. **The contract is frozen.** `docs/api/openapi.candidate.v1.lock` holds the
   version and the SHA-256 of the canonical document; the test fails when
   they disagree. Changing the contract is `npm run api:freeze` plus a diff in
   review. **A breaking change is version 2 at a new path, never an edit**;
   an additive change (a new optional field, a new operation) bumps the minor
   version and re-freezes.
5. **The two writes are the applicant's own acts.** `confirm` records that the
   applicant submitted on the employer's form; `submit` is the applicant's
   instruction to submit through an employer-authorised ATS after review
   (Stage 12), refused unless their mode permits it and the board is
   authorised. There is no operation that submits without the applicant's
   click, and the mode field can never carry Approved Auto-Apply.
6. **The Expo app consumes only this document** (built 2026-09-05 under
   `mobile/`, ADR-0013 step 3): its types are generated from the document
   and diffed in CI, its client names every path it calls and a test fails
   if one is not in the contract or if a screen calls `fetch` on its own.
   Push notifications wait on ADR-0011 (not built); the `notifications`
   operation is a pull.

## Consequences

- A mobile client can be generated from the document today; drift between
  it and the backend is a failed test, not a runtime surprise.
- The web app's first-party routes stay free to change; only `/api/v1` is a
  promise.
- The `notifications` and folder shapes carry ids, kinds, dates and hashes -
  never a note body, a contact's address or a document's bytes - so a lost
  phone holds nothing a folder page would not show.

## Amendment: version 1.1.0 (2026-09-05) - additive, for the mobile client

Applying rule 4: the mobile client needed operations the 1.0.0 surface
did not have. Every one is additive - no 1.0.0 operation, field or meaning
changed - so the minor version moved and the lock was re-frozen.

| Added | Why |
| --- | --- |
| `POST /v1/auth/sessions` (public), `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/current`, `DELETE /v1/auth/sessions/{sessionId}` | Device sign-in, sign-out and device management (ADR-0029). |
| `PATCH /v1/me` | The "lightweight profile edits" in the mobile scope: name, city, headline, application mode (the unreachable mode refused, ADR-0016). |
| `GET /v1/consents`, `PUT /v1/consents/{purpose}` | Privacy screen: what is granted, grant or withdraw; required purposes and the L-3 purpose fail closed. |
| `PUT` / `DELETE /v1/jobs/{jobId}/saved`, `GET /v1/saved-jobs`, `saved` on `JobDetail` | Save / track jobs. Ownership through the caller's matches, as job detail. |
| `POST /v1/applications/{applicationId}/documents/{documentId}/link` | Document access: a ten-minute signed link; the bytes are served by the Stage 09 route, never by this API. |
| `GET /v1/evidence` | The vault read-only: claims, never facts, never a write. |
| `unavailable` error code (503) | A dependency the deployment lacks (an identity provider). |

The independent review of 1.0.0 also changed the document's shape without
changing any field: **every object schema is closed** (`additionalProperties:
false`; the two `allOf` compositions are flattened so they can be), so a
serialiser that starts leaking a column fails the contract test rather than
passing it; **every operation documents 401 and 429**, which every keyed
operation can return; and `contractProblems()` enforces both, plus that
`x-scope` is a real scope and that `public` and `security: []` appear
together and only on the sign-in.

Two reviewer notes recorded as deliberate: the ATS ruleset lookup stays in
the document (removing it would be a breaking change; the app does not call
it, and the parity test asserts that), and the `notifications` merge is the
first candidate-facing list of mailbox-derived detections - it carries the
type, the message from a fixed dictionary and an application id, nothing
from a message, which is the ADR-0025 posture.

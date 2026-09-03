# ADR-0028 - The candidate API contract is a frozen, versioned OpenAPI document that the backend is tested against; the mobile app consumes only it

**Status:** Accepted (Stage 14, 2026-09-03) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 14 (the contract half); ADR-0013 steps 1 and 2 · **Depends on:** ADR-0004 (API keys), ADR-0016 (no autonomous submission), ADR-0024 (folder), ADR-0026 (assisted application)

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
6. **The Expo app is NOT built in this stage.** No React Native toolchain
   exists in this environment and the plan's exit gate is the frozen
   contract; the app is the next deliverable and consumes only this document.
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

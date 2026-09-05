# ADR-0013 — Mobile architecture: React Native + Expo, contract-first

**Status:** Accepted · **Date:** 2026-09-02 · **Steps 1 and 2 delivered (Stage 14, 2026-09-03, ADR-0028):** `docs/api/openapi.candidate.v1.json` is published, hash-locked in `openapi.candidate.v1.lock`, and proven against the backend by `tests/candidate-api-contract.test.ts` in CI. **Step 3 delivered (2026-09-05):** the Expo client under `mobile/` consumes only the contract (1.1.0, additive; ADR-0029 for its device sign-in), typechecks, passes its tests and bundles in CI; it has never run on a device - the device matrix, the secure-store write and screen-reader use are NOT VERIFIED, push notifications wait on ADR-0011, biometric unlock and certificate pinning are NOT IMPLEMENTED.

## Context
No mobile application exists. The target is React Native + Expo + TypeScript,
candidate-first.

The real blocker is not the app framework. It is that **there is no stable API
contract.** `/api/v1` exposes four endpoints (`analytics/summary`,
`applications`, `jobs`, `ats-rulesets/[platform]`). The other 45 routes are
first-party endpoints shaped for the web client, with a deliberately different
error envelope (`{ error: string }` vs the public API's structured
`{ error: { type, code, message, param } }`).

Building a mobile client against first-party routes would freeze internal
endpoints into a public contract by accident — the most expensive kind of
coupling, because it is discovered only when the web app needs to change.

## Decision
**Contract-first. The OpenAPI specification for the candidate surface is a
deliverable that precedes the app.**

1. Publish and version an OpenAPI contract covering the candidate surface:
   profile, recommendations, job detail, match analysis, documents, applications,
   Job Folder, interviews, notifications.
2. Freeze it with contract tests that run in CI against the web backend.
3. Then build the Expo client against that contract only.

Mobile scope for v1 is deliberately narrow: view recommendations and match
analysis, review and approve prepared applications, track the Job Folder, receive
notifications. **Document editing and billing stay on web.**

## Consequences
- Mobile shares the auth of `ADR-0004`, with tokens in platform secure storage
  (Keychain / Keystore), never in `AsyncStorage`.
- The public API's structured error envelope becomes the mobile contract — the
  existing distinction between internal and public error shapes is preserved
  deliberately, and mobile is a *public* consumer.
- Push notifications require the `ADR-0011` event stream, which is why mobile
  sequences after Stage 13.
- The contract, once published, is versioned. Breaking changes require a new
  version, not an edit.

## Revisit when
An offline-first requirement or a native capability (background location, deep
OS integration) exceeds what Expo's managed workflow supports.

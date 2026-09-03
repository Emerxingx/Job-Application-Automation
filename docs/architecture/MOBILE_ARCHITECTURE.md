# Mobile Architecture

**Decision:** `../adr/ADR-0013-mobile.md`

## Position
No mobile application exists. The blocker is not the framework — it is that
**there is no stable API contract.** `/api/v1` exposes four endpoints; the other
45 routes are first-party endpoints shaped for the web client.

Building a mobile client against first-party routes would freeze internal
endpoints into a public contract by accident, discovered only when the web app
needs to change.

## Sequence (non-negotiable)
1. **Publish an OpenAPI contract** for the candidate surface. — **DONE (Stage 14):** `docs/api/openapi.candidate.v1.json`, version 1.0.0.
2. **Freeze it** with contract tests running in CI against the web backend. — **DONE:** `openapi.candidate.v1.lock` + `tests/candidate-api-contract.test.ts` (ADR-0028).
3. **Then** build the Expo client against that contract only. — NOT STARTED.

## Stack
React Native + Expo + TypeScript. Shared types generated from the OpenAPI
contract, so drift is a compile error rather than a runtime surprise.

## v1 scope (candidate-first, deliberately narrow)
Recommendations · job detail · match analysis and explanation · review and
approve prepared applications · Job Folder · interviews · notifications ·
lightweight profile edits.

**Out of scope for v1:** document editing, billing, employer surfaces, case
management, admin.

## Security
- Same auth as web (`ADR-0004`), with tokens in platform secure storage
  (Keychain / Keystore) — **never `AsyncStorage`**.
- Certificate pinning for the API host.
- Biometric unlock for the app; **MFA still required** for sensitive actions.
- No privileged or admin endpoints exposed to mobile.
- Push notifications carry **no personal data in the payload** — only a reference
  to fetch after authentication.

## Offline
Read-only caching of recommendations and folders. **No offline application
submission** — it would break the human-in-the-loop guarantee of `ADR-0016`.

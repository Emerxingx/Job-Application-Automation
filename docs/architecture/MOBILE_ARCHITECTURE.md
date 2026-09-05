# Mobile Architecture

**Decision:** `../adr/ADR-0013-mobile.md`

## Position
**Delivered in Stage 14.** The contract came first (1.0.0, 2026-09-03), then
the Expo client under `mobile/` (2026-09-05) against its additive 1.1.0
amendment. The app has never run on a device: what a device would prove is
NOT VERIFIED and listed in `docs/programme/STAGE14_EVIDENCE.md` §5.

The original blocker was not the framework - it was that there was no stable
API contract, and a client built on first-party routes would have frozen
internal endpoints into a public contract by accident. That is why the
sequence below was non-negotiable, and it was followed.

## Sequence (non-negotiable)
1. **Publish an OpenAPI contract** for the candidate surface. — **DONE (Stage 14):** `docs/api/openapi.candidate.v1.json`, version 1.0.0.
2. **Freeze it** with contract tests running in CI against the web backend. — **DONE:** `openapi.candidate.v1.lock` + `tests/candidate-api-contract.test.ts` (ADR-0028).
3. **Then** build the Expo client against that contract only. — **DONE (2026-09-05):** `mobile/` - types generated from the document and diffed in CI, every path the client calls asserted to be in the contract, no direct `fetch` (`mobile/tests/contract-parity.test.ts`).

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
- Same auth as web (`ADR-0004`): a **device key** minted by the applicant's own
  sign-in (`ADR-0029`) - an `ApiKey` of kind `device`, scope `write` never
  `admin`, expiring, capped, revoked by the owner, by a password change and by
  sign-out-everywhere - kept in platform secure storage (Keychain / Keystore,
  `expo-secure-store`) — **never `AsyncStorage`** (a test refuses the import).
  DONE; the secure-store write itself is NOT VERIFIED on a device.
- Certificate pinning for the API host. **NOT IMPLEMENTED** (needs a native
  module / config plugin and a device to prove it); release builds refuse a
  plain-http API meanwhile.
- Biometric unlock for the app; **MFA still required** for sensitive actions.
  **NOT IMPLEMENTED**; the identity-provider (MFA) sign-in method is in the
  contract and the server, not yet in the UI (no provider is configured).
- No privileged or admin endpoints exposed to mobile. DONE (no contract
  operation carries `admin`; tested).
- Push notifications carry **no personal data in the payload** — only a reference
  to fetch after authentication. Push is **NOT IMPLEMENTED** (ADR-0011); the
  `notifications` operation carries ids and fixed messages only.

## Offline
Read-only caching of recommendations and folders. **No offline application
submission** — it would break the human-in-the-loop guarantee of `ADR-0016`.
DONE as policy (`mobile/src/api/cache.ts`: an allow-list of GET paths, never a
write, a device list or a signed link; shown with its age; cleared on
sign-out; actions disabled offline; no queue). A real network drop mid-tap is
NOT VERIFIED.

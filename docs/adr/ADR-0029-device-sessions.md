# ADR-0029 - The mobile app signs in with a device key: an API key of kind `device`, minted by the applicant's own sign-in, revoked with the sessions

**Status:** Accepted (Stage 14, 2026-09-05) · **Implements:** ADR-0013 step 3 (the Expo client), `MOBILE_ARCHITECTURE.md` §Security · **Extends:** ADR-0004 (identity and sessions), ADR-0028 (the contract; this is its 1.1.0 amendment) · **Depends on:** ADR-0016 (no autonomous submission)

## Context

The candidate contract (ADR-0028) authenticates every operation with a
bearer API key. The web app authenticates with a cookie that names a
revocable `Session` row (ADR-0004). A phone cannot use the cookie: the
contract is the boundary, and it says "bearer". So the app needs a
credential that (a) is a bearer key the contract already accepts, (b) is
minted by the person's own sign-in and never by a key, (c) is stored in the
platform's secure store, and (d) dies the way a session dies - by the
owner's hand, by a password change, by expiry - and never outlives one.

Two designs were open: a second token type (a JWT the v1 layer would have to
learn to verify, with its own revocation table), or the existing `ApiKey`
row with a `kind`. The second keeps one authentication path, one hash-only
store, one rate limiter and one revocation query.

## Decision

1. **A device key is an `ApiKey` row of kind `device`** (migration
   `20260905100000_api_key_kind`: `kind` defaulting to `integration`,
   `platform`). Same table, same SHA-256-only storage, same
   `authenticateApiKey` checks, same per-key budget, same `revokedAt`.
2. **It is minted only by the applicant's sign-in** - `POST /v1/auth/sessions`,
   the one public operation in the contract (`x-scope: public`,
   `security: []`), with the password or a Supabase Auth token, the same two
   methods the web accepts. A key cannot mint a key: the route has no key
   and takes a credential only a person holds. Rate limited by address on
   the sign-in rule. The raw key is returned once and never written anywhere.
3. **Its scope is `write`** (`read` + `apply:write` by the scope ladder),
   never `admin`: the app can do what the applicant can do on the web and
   nothing a staff member can. The device cannot reach the console, mint
   keys, or touch billing.
4. **It expires** after 90 days, **is capped** at 10 per account (the least
   recently used is recycled so a new phone can always sign in), **is listed
   and revoked by the owner** (`GET /v1/auth/sessions`,
   `DELETE /v1/auth/sessions/{sessionId}`, `DELETE .../current` for sign-out;
   the web sessions page lists devices too), **and is revoked with the
   sessions**: a password change and "sign out everywhere else" revoke every
   device key. Issue and revocation are security-audit events
   (`auth.device.issued`, `auth.device.revoked`) carrying platform and reason,
   never the key.
5. **The app keeps it in secure storage only** (Keychain / Keystore,
   `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; in a browser tab, memory only), and a
   401 from any operation ends the session on the device at once: key and
   cache wiped, no retry. Release builds refuse a plain-http API.
6. **Integration keys are unchanged.** They are minted on the web with a
   human session as before, listed on the integrations page, and counted
   against their own ceiling; device keys count against theirs.

## Consequences

- One authentication path for `/api/v1`; the contract test proves the
  device flow end to end with a real password hash: mint, use, list as
  current, sign out, refused; a stranger's revoke is 404; a password change
  revokes.
- A lost phone is cut off from the web or from any other device, or by
  changing the password, without touching integration keys.
- The identity-provider method (Supabase, MFA) is in the contract and the
  server; no deployment has a provider configured, so the app offers the
  password method only and says so. When a provider exists, the app gains
  the method without a contract change.
- Not decided here: biometric unlock of the app and certificate pinning
  (`MOBILE_ARCHITECTURE.md`). Both need a native module / config plugin and
  a device to prove them on; both are NOT IMPLEMENTED and recorded as such.

# Stage 20 - Enterprise tenant controls, SSO and public-sector readiness - evidence

Recorded 2026-09-05 on branch `claude/stage-20-enterprise-controls` (PR #32), stacked
on Stage 19 (PR #31) - 18 (#30) - 17 (#29) - 16 (#28) - 15 (#27) - 14 (#26)
- 13 (#25) - 12 (#24) - 11 (#23) - 10 (#22) - 09 (#21) - 08 (#20) - 07
(#19) - 06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) - 01 (#13,
PARTIAL). Every line was run or read; nothing is PASS on the strength of a
mock, a skipped test or a document. This stage's honest centre: **the
founder performs the remaining routine administration without a deploy -
verified organisations, tenant policy, platform roles, feature flags, the
audit log, a read-only look at a customer's account - every change
re-authenticated, reasoned and audited on the right side of the ADR-0019
line; and an enterprise buyer gets OIDC single sign-on and SCIM
provisioning that are complete, tested against a local issuer and the
database, and NOT VALIDATED against any real identity provider.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 20: platform admin for what remained
(organisations, users, roles, feature flags, audit), enterprise SSO/SCIM,
tenant-level policy, and impersonation that is read-only, reason-required and
time-boxed. Gap G-26. ADR-0019's boundary made concrete: business
configuration is admin-editable; security-critical implementation is not.
Decision record: ADR-0035.

## 2. Platform administration - `PASS`

- **Organisations** (`src/lib/admin/organizations.ts`, `/console/organizations`,
  `/console/organizations/:id`): staff create a VERIFIED employer, service
  provider or staffing agency for an existing owner (the types self-service
  refuses since Stages 17-19), stamped `verifiedAt`/`verifiedByEmail`;
  suspend and reactivate (a suspended organisation has no active members
  anywhere: `findActiveMembership` answers null, so the tenant context, cases,
  hiring, staffing and the roster all refuse -
  `requireTenant` refuses; its SSO signs nobody in; its SCIM tokens are
  refused); tenant policy - `requireSso`, `allowedEmailDomains`,
  `sessionMaxHours` - set by staff only. Every write: admin, step-up, reason,
  audit row with before/after.
- **Users** (`src/lib/admin/users.ts`, `/console/users`): lookup by email
  (role, live sessions by id and method, memberships); platform role
  assignment (`member` or a staff rank; never one's own; never an erased
  account); sign out everywhere (`staff_revoke` - web sessions AND device
  keys). Audited.
- **Feature flags** (`src/lib/admin/feature-flags.ts`, `/console/flags`):
  `FLAG_REGISTRY` declares the two flags the code reads
  (`auth.sso_start_button`, `console.report_export`), each with its default and
  the file that reads it; `setFeatureFlag` refuses an undeclared key and any
  key `isTierTwoKey` matches; evaluation is deterministic (a percentage cohort
  by hash, an allow-list); audited with before/after.
- **Audit** (`src/lib/admin/audit.ts`, `/console/audit`,
  `/api/console/audit/export`): filtered viewer with a cursor; CSV export of
  up to 1000 rows without the IP or user-agent columns, formula cells
  neutralised, itself an `audit.exported` row; gated by the export flag.
- **Impersonation** (`src/lib/admin/impersonation.ts`, `src/lib/auth.ts`):
  a reason of at least ten characters, never a staff account, never oneself,
  one at a time, 60 minutes; a second signed cookie names the
  `ImpersonationSession` row; `getSessionUserId` answers with the target while
  the row is live (unended, in window, read-only, the staff session still live
  - checked per request, no cache); `route()` refuses every non-GET with 403;
  the only unwrapped write is the endpoint that ends it; a banner in the
  customer's shell names the staff member and offers the way out; no
  `Session` row is issued for the target; start and end audited.

## 3. Tenant policy enforcement - `PASS`

- `allowedEmailDomains` bounds `inviteMember` (an address outside the list is
  refused with 403) and SCIM provisioning (the SSO domain counts too; with
  neither configured nothing is provisioned - fail closed).
- `sessionMaxHours` shortens the platform's 30-day session and the mobile
  device key through
  `createSession({ maxHours })` on the password, identity-provider and SSO
  routes; `sessionTtlSeconds` never lengthens; the shortest of a person's
  organisations wins.
- `requireSso` closes the password, Supabase and device doors for the
  organisation's ACCEPTED MEMBERS under the connection's
  domain, checked AFTER the password so the refusal reveals nothing; it cannot
  be set without an enabled connection.

## 4. Enterprise sign-in - `PASS` (mechanism) · `IMPLEMENTED-NOT-VALIDATED` (any real provider)

`src/lib/sso/`: `crypto.ts` (AES-256-GCM under `SSO_ENCRYPTION_KEY`, a key
separate from the mailbox one), `oidc.ts` (pure: PKCE S256, discovery with
issuer match, the authorization request, code exchange, ID-token verification
with jose against the issuer's JWKS for signature/iss/aud/exp/nonce, a
verified email required), `service.ts` (one connection per organisation,
authoritative for one domain, one enabled claimant per domain; the secret
decrypted in exactly one place; JIT provisioning with the signup consents
recorded as source `sso`, a personal workspace and an ACCEPTED membership; a
removed membership never reinstated by a sign-in; every refusal audited
against a digest). Routes `/api/auth/sso/start` (address-limited, state in a
signed ten-minute cookie) and `/api/auth/sso/callback`; the login page's
"Sign in with your organisation" behind the declared flag. Proven end to end
against a fake issuer on the loopback in `tests/enterprise.test.ts`. No real
identity provider has completed a sign-in - `INTEGRATION_REGISTER.md`.

## 5. SCIM 2.0 provisioning - `PASS` (mechanism) · `IMPLEMENTED-NOT-VALIDATED` (any real client)

`src/lib/scim/`: staff-issued tokens (plaintext shown once; SHA-256 digest
and a display prefix stored; constant-time compare; per-token rate limit;
revocable; refused under suspension); `/api/scim/v2/Users` list (`userName eq`
only), create (provision under the domain policy; no consent recorded), get,
PATCH/PUT (`active`, `name.formatted`; everything else refused), DELETE
(deactivate: membership removed, sessions revoked, the account and the
person's data untouched); `/ServiceProviderConfig`. Scoped to the token's
organisation: another organisation's token sees nothing. No real SCIM client
has driven it.

## 6. Surfaces - `PASS` (compile, lint; not exercised in a browser)

`/console/organizations`, `/console/organizations/[id]`, `/console/users`,
`/console/flags`, `/console/audit` with nav entries at the rank each page
gates on; the login page's SSO entry; the impersonation banner in the
dashboard shell; routes under `/api/console/{organizations,users,flags,
impersonation,audit}`, `/api/auth/sso/*`, `/api/scim/v2/*`.

## 7. Tests - `PASS`

`tests/enterprise-static.test.ts` (25): the admin authorisation matrix
(every `/api/console` handler wrapped and role-gated, the one unwrapped route
named; every Stage 20 write admin + step-up with the role check first; the
console map at the pages' ranks); the flag boundary (declared keys pass the
Tier-2 filter and are read where they say; a dozen security-control keys
refused; determinism; no security module reads a flag); OIDC against a local
key (PKCE with the RFC 7636 vector, discovery refusals, the authorization
request, ID-token refusals for key, audience, issuer, nonce, unverified and
missing email); the secret's encryption and the single decryption site; SCIM
PatchOp and filter parsing, the erased member, the digest; the SCIM routes
not `route()`; the public prefixes segment-aware; system-only RLS;
impersonation liveness (eight cases) and the read-only refusal in `route()`;
the session ceiling; the domain policy; the CSV; forbidden paths.
`tests/enterprise.test.ts` (12, database): verified creation and its refusals;
policy validation, invitation bounded by domain, the session ceiling per
membership; roles and staff session revocation; flags; the audited export;
impersonation from refusal to end; the connection with an encrypted secret,
one claimant per domain, `requireSso`; SSO end to end with provisioning and a
second sign-in; six audited refusals plus suspension and JIT off; SCIM tokens,
scoping, provisioning, deactivation, reactivation, revocation and suspension.
Root suite: 1243 / 1243 (0 skipped) with the database URLs set.

## 8. What is NOT done, and why

- **Any real identity provider or SCIM client** - NOT VALIDATED; none is
  reachable or configured here. The first Entra/Okta/Google sign-in and the
  first IdP-driven SCIM sync are operator actions and will find the
  provider-specific details (claim names, PATCH dialects) this code has not
  seen.
- **SAML** - NOT IMPLEMENTED; OIDC only, stated in ADR-0035.
- **SCIM Groups, bulk, sorting, ETags** - NOT IMPLEMENTED; the
  ServiceProviderConfig says so.
- **MFA as a tenant policy** - NOT IMPLEMENTED; the platform has no MFA of
  its own and does not read the provider's `acr`/`amr` yet.
- **Plan and price editing, notification/email templates, retention policies
  beyond cases, system health** - NOT IMPLEMENTED (G-26 stays PARTIAL).
- **The retention and erasure review across Stages 17-19** - NOT DONE; no
  erasure path touches the case, employer or staffing tables and ADR-0035
  claims none.
- **Route-level status codes and the browser** - NOT VERIFIED beyond compile
  and lint.
- **Staging rehearsal** - NOT VERIFIED (R-34).

## 9. Gate status

| Gate | Result |
| --- | --- |
| `npm run lint:ci` | 0 errors, 7 warnings (ceiling 8) |
| `npx tsc --noEmit` | 0 errors |
| `npm test` (database URLs set, `CI=true`) | 1243 / 1243, 0 skipped |
| `npm run build` | 0 errors (main tree; Turbopack refuses the worktree's symlinked `node_modules`) |
| Fresh-database rehearsal | 52 migrations applied to an empty PostgreSQL 16; `migrate diff` clean; 155 forced-RLS tables in `public` |

## 10. Exit gate - verdict

The plan's exit gate is "no routine business change requires a code deploy"
and its acceptance is a founder sign-off. **Engineering: PASS for the
controls built** (organisations, policy, roles, flags, audit, impersonation,
SSO, SCIM). **The gate as written is PARTIAL:** plan and price editing,
templates, retention beyond cases and system health still need a developer,
and the founder's capability checklist has not been signed. The enterprise
integrations are mechanism-complete and unvalidated.

## 11. What a founder or operator has to do

1. Set `SSO_ENCRYPTION_KEY` on the deployment (a separate key from the
   mailbox one) before recording any SSO connection.
2. Validate the first real identity provider: record the connection at
   `/console/organizations/:id`, complete a sign-in, and move the register
   row to VALIDATED - or record what differed.
3. Issue a SCIM token to the first customer's identity provider and validate a
   create / deactivate cycle.
4. Sign the admin capability checklist against `ROLE_PERMISSION_MATRIX.md`
   "Platform staff", naming what still needs a developer.

## 12. Independent review

An adversarial review of the stage (2026-09-05) returned 3 HIGH, 7 MEDIUM
and 12 LOW findings. Every HIGH and MEDIUM and every LOW but two accepted
ones (L7 `verifiedByEmail` column visibility; L12 the unkeyed digest, stated
in the ADR) is fixed on the branch with a test; the table names the fix.

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| H1 | HIGH | SSO minted a session for ANY existing account under the claimed domain, staff included; a public or staff domain could be claimed | A staff account (role or allow-list) is never signed in by a tenant's provider; an existing account is signed in only when it is already a member or invited (an account that merely shares the domain is refused); JIT creates new accounts only; public mail domains and `STAFF_EMAILS` domains are unclaimable; one claimant per domain under an advisory lock (database tests, pure tests) |
| H2 | HIGH | The mobile device sign-in ignored `requireSso` and the session ceiling; "sign out everywhere" and SCIM deactivation left phones signed in | `issueDeviceSession` refuses under `requireSso` after the credential and caps the key with the ceiling; staff revocation and SCIM deactivation revoke device keys (database test signs a phone in, is refused, is capped, is revoked) |
| H3 | HIGH | Impersonation reached the sensitive schema and every audited delegated read, attributing the read to the customer | `assertNotImpersonating()` refuses sensitive self-identification (read/write/erase), RESTRICTED case notes and assessments, the delegated client view, disclosed candidates and sourcing, mailbox metadata and document links, each BEFORE its audit row (static test walks every path); the banner says so |
| M1 | MEDIUM | The impersonation cookie was a free-standing bearer credential | Honoured only beside the staff session it names (`impersonationBoundToSession`; pure test and a static check of the per-request binding) |
| M2 | MEDIUM | "Never a staff account" was role-only; an allow-listed `member` could be impersonated into `/console` | The allow-list is checked at start and the target is re-checked per request (role, allow-list, erasure) (database test with `STAFF_EMAILS`) |
| M3 | MEDIUM | Suspension stopped only `requireTenant`; cases, hiring, staffing and the roster kept working | `findActiveMembership` answers null for a suspended organisation, so every path inherits it (database test) |
| M4 | MEDIUM | SCIM could deactivate the last owner, reinstate a removed admin with their role, and over-revoked silently | An owner is never deactivated through provisioning; reinstatement is as a member; the platform-wide revocation (now including device keys) is stated in the ADR (database tests) |
| M5 | MEDIUM | `requireSso` locked out non-member accounts under the domain; the exchange route created an account before refusing | `passwordSignInRefusal` binds accepted members of the requiring organisation only; the exchange refuses before linking (database test, static test) |
| M6 | MEDIUM | Issuer-supplied endpoints trusted too far: http, no timeouts, no algorithm pin, JWKS rebuilt per sign-in | https required (loopback exempt), `AbortSignal.timeout` and `redirect: 'error'` on every call, `algorithms` pinned to the asymmetric set, JWKS cached per URI (pure tests) |
| M7 | MEDIUM | "Read-only" still rebuilt marts on a GET; logout was refused under impersonation; no way out from non-dashboard pages | The first-visit rebuild is skipped under impersonation; logout is the one allowed write and `destroySession` ends the impersonation first; the banner moved to the root layout (static tests) |
| L1-L11 | LOW | State-cookie path; free-text `?sso=` message and the key error shown to visitors; check-then-write on the domain claim; flag-regex gaps; SCIM userName, non-object body, unauthenticated flood, rename semantics, erased-account disclosure; CSV tab/CR; FeatureFlag tenant-readable; unaudited start-side refusals; target not re-checked; a false comment; a domain policy set after an invitation | All fixed: the cookie is cleared under its path; the callback sends a fixed code; the claim is under an advisory lock; the regex covers `authz`, `sessions`, `roles`, `permissions`, `impersonation`, `step_up`, `mfa`, `password`, `token`, `rate_limit`; `isEmailAddress`, a 400 for a non-object body, a per-address budget, renames only for provisioned accounts, one refusal wording; tabs and CRs neutralised; `FeatureFlag` system-only (the Stage 01 RLS migration regenerated); every refusal audited; the target re-checked per request; the comment corrected; `acceptInvitation` honours the policy |
| L7, L12 | LOW | `Organization.verifiedByEmail` readable on the tenant path; `hashEmail` unkeyed | Accepted and stated in ADR-0035 |

The review also corrected the documentation: ADR-0035 §1, §2, §5, §6, §7 and
§8, CLAUDE.md item 31, TEST_STRATEGY ("three doors") and the audit page's
own text were rewritten to say what the code does; ADR-0019 is no longer
"Accepted" by the stage that builds on it - the founder's sign-off is.

Root suite after the fixes: 1243 / 1243 with the database URLs set; lint 0
errors / 7 warnings; typecheck and build pass; 52 migrations apply to an
empty database with no drift.

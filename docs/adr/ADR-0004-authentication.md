# ADR-0004 — Authentication: extend the existing implementation

**Status:** Proposed · **Date:** 2026-09-02

## Context
What exists (read at `35d3491`, `src/lib/auth.ts`) is better than typical:
- bcrypt cost 10.
- HS256 JWT via `jose` in an `httpOnly`, `secure`-in-production, `sameSite: lax` cookie.
- `AUTH_SECRET` rejected **by value** if it equals the `.env.example` placeholder,
  throwing in production — this closes a real and commonly-missed hole.
- `PAYLOAD_SECRET` deliberately distinct so one leak does not compromise both.

What is missing against the target: email verification, phone verification, MFA,
account recovery, session/device management, OAuth (Google/Microsoft/Apple),
and — most seriously — **session revocation**. The JWT is stateless with a 30-day
expiry; logout deletes the cookie only, so a stolen token remains valid for up to
30 days.

## Options
- **A. Replace with a managed provider** (Supabase Auth, Auth0, Clerk). Fast to
  MFA/OAuth; migrates every existing user; introduces an external dependency in
  the critical path; the staff-console two-lock gate would need rebuilding.
- **B. Extend the existing implementation.** Preserves working code and the
  console gate; MFA, OAuth and recovery must be built and got right.
- **C. Hybrid** — keep local sessions as the primary credential; delegate OAuth
  and enterprise SSO to a managed identity layer.

## Decision
**Option C.** Keep the existing session and password implementation as the
primary credential. Add:

1. **Server-side session records** — sessions become revocable. The JWT carries a
   session id; every request validates it against a `sessions` row. Logout,
   password change, and admin revoke all take effect immediately.
2. **Email verification** and **account recovery** with single-use, expiring,
   hashed tokens. `EmailToken` already exists in the schema and is unused.
3. **MFA (TOTP)** with recovery codes; mandatory for staff and admin roles.
4. **OAuth** (Google, Microsoft, Apple) as *additional* identities linked to one
   account, never as a parallel account namespace.
5. **Enterprise SSO** (SAML/OIDC) in Stage 20 via a managed identity layer.
6. **Device/session list** in candidate settings.

## Consequences
- Session validation adds a database read per request. Mitigated by the existing
  cache abstraction with a short TTL — with the rule that **revocation
  invalidates the cache entry synchronously**, or revocation is not real.
- One identity per human across all four products and all organisation
  memberships (`ADR-0005`).
- The staff-console two-lock gate (`STAFF_EMAILS` allowlist **and** `User.role`,
  failing closed, unknown role degrading to least privilege) is **preserved
  as-is** and becomes the pattern for every future admin surface.
- CSRF: `sameSite: lax` is retained but is not sufficient alone. Add explicit
  CSRF tokens for state-changing non-idempotent routes.

## Revisit when
Enterprise SSO demand or a compliance regime makes a managed identity provider
the cheaper total-cost option.

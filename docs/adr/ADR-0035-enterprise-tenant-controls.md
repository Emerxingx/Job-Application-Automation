# ADR-0035 — Enterprise tenant controls: platform administration, SSO, SCIM, tenant policy and read-only impersonation

**Status:** Accepted (Stage 20, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 20, gap G-26 · **Depends on:** ADR-0004 (revocable sessions), ADR-0005 (RLS), ADR-0019 (the admin configuration boundary — this ADR is its Tier-1/Tier-2 line made concrete for the remaining admin surface), ADR-0032 / ADR-0033 / ADR-0034 (the verified organisation types) · **Open:** no legal question is opened by this stage; L-1 (public-sector regime) still governs what a public body may be sold

## Context

The founder is non-technical and must run the business without a
developer: create the organisations that self-service refuses (employers,
service providers, staffing agencies), suspend one, assign staff roles, sign
a person out everywhere, turn a feature on or off, read and export the audit
log, and see an account as the customer sees it when support needs to. An
enterprise or public-sector buyer additionally asks for single sign-on
through its own identity provider, automated provisioning and deprovisioning
of its members, and tenant-level policy (who may be invited, how long a
session lives, whether SSO is mandatory).

Every one of these is a place where an administrative control could widen a
security rule if the boundary were not explicit. ADR-0019 states the line;
this stage builds the surface on the correct side of it. Nothing here
changes authentication logic, session handling, RLS, the sensitive-schema
boundary, the apply-mode ceiling, source lawfulness or residency — those
remain code and migration only, and the tests hold it.

## Decision

1. **Verified organisations are created by staff, with a reason, under
   step-up, audited.** `createVerifiedOrganization` creates one of the three
   verified types for an EXISTING account (the owner) and stamps
   `verifiedAt` / `verifiedByEmail`. Suspension keeps every row; a suspended
   organisation has no tenant path (`requireTenant` refuses), its SSO signs
   nobody in and its SCIM tokens are refused.

2. **Tenant policy is set by JobPilot staff, never by the tenant's own
   admins, and only narrows.** On `Organization`: `requireSso` (the password
   and identity-provider doors close for the connection's domain — checked
   AFTER the password so the refusal reveals nothing about it),
   `allowedEmailDomains` (bounds whom the organisation's admins may invite
   and whom SCIM may provision; empty = any), `sessionMaxHours` (shortens the
   platform's 30-day session for the person's organisations; never lengthens;
   the shortest wins across memberships). Requiring SSO with no enabled
   connection is refused: it would lock every member out.

3. **Platform roles are ASSIGNED here and DEFINED in code.** `setPlatformRole`
   moves an account between `member` and the staff ranks with a reason and a
   before/after audit row; nobody changes their own; an erased account is not
   promotable. The console's two-lock gate (`STAFF_EMAILS` AND the role)
   still decides who reaches `/console` — a role alone opens nothing.

4. **Feature flags: the code declares what is flaggable.** `FLAG_REGISTRY`
   names every flag a reader consults, with its default and where it is
   read; the console sets only a declared flag (on/off, a deterministic
   percentage cohort, an allow-list) with a reason, audited. `isTierTwoKey`
   refuses any key naming an authentication, session, isolation, tenant,
   policy, consent, sensitive, apply-mode, residency, encryption, secret,
   audit, permission, role, SSO-require or SCIM-token control, and a static
   test keeps the registry inside that rule and every security module free
   of flag reads. A flag reveals or hides a product feature; no security
   rule reads one.

5. **Impersonation is read-only, reason-required and time-boxed — and the
   `ImpersonationSession` model that had no code now has one.** The staff
   member keeps their own session and gains a second signed cookie naming an
   `ImpersonationSession` row (60 minutes, reason of at least ten characters,
   never a staff account, never oneself, one at a time). While it is live —
   the row unended, inside its window, read-only, and the staff member's OWN
   session still live, checked on every request with no cache — every
   authoritative read answers with the target's id, so pages render as the
   customer sees them, and `route()` refuses every non-GET request with 403.
   No `Session` row is ever issued for the target; the one unwrapped write is
   the endpoint that ends the impersonation. Start and end are audit rows
   with the reason; the row snapshots the staff email so the record survives
   offboarding; the banner in the customer's shell says who is looking.

6. **Single sign-on is OpenID Connect, one connection per organisation,
   authoritative for one email domain, staff-administered.** Authorization
   Code + PKCE (S256), a nonce bound to the ID token, discovery from the
   issuer (the document's issuer MUST match), the ID token verified against
   the issuer's JWKS for signature, issuer, audience, expiry and nonce; the
   released email must be `email_verified` and must fall under the
   connection's domain. The client secret is AES-256-GCM under
   `SSO_ENCRYPTION_KEY` (a key separate from the mailbox one — a separate
   blast radius) and is decrypted in exactly one place, to redeem a code; the
   console never sees it again. One ENABLED connection may claim a domain.
   The provider authenticates; the platform authorises: the session issued
   afterwards is the same revocable row every sign-in gets, under the
   organisation's session ceiling. Just-in-time provisioning creates the
   account (a random, unusable password; a verified email), its personal
   workspace, the signup consents (source `sso` — the organisation sign-in
   page states the terms before the redirect) and an ACCEPTED membership,
   because the organisation's provider vouched for the person. A membership
   the organisation REMOVED is never reinstated by a sign-in: that is the
   organisation's decision, made through SCIM or an admin. Every refusal is
   audited against the address's digest. SAML is not built; the plan named
   "SAML/OIDC" and OIDC is what every major provider offers.

7. **SCIM 2.0, the Users resource only, scoped to one organisation by a
   staff-issued token.** The token is shown once and stored as a SHA-256
   digest with a display prefix; every call is scoped to the token's
   organisation and sees only its memberships — never another tenant, never
   the person's job-search data. Creating a user provisions an account (if
   none) and an accepted membership, under the organisation's provisioning
   domains (its allowed domains, or its enabled SSO domain; neither → nothing
   is provisioned, fail closed) and records NO consent — the person's first
   sign-in does that, having seen the wording. Deactivating (`active: false`
   or DELETE) removes the membership and revokes the person's sessions; it
   never deletes or scrubs the account, because the person's own data is
   theirs and erasure is their request under the privacy process. Only
   `active` and `name.formatted` are patchable; anything else is refused,
   not ignored. The endpoint is not `route()`: a machine with a token gets
   SCIM errors, not the cookie envelope.

8. **The audit log has a viewer and an audited export.** Filtered by action
   prefix, entity, actor and date; the CSV carries ids, actions, summaries and
   reasons — the columns the writers already redacted — never the IP or
   user-agent columns; formula cells are neutralised; and the export is itself
   an `audit.exported` row.

9. **Nothing external has been validated.** No real identity provider has
   completed a sign-in against this platform and no real SCIM client has
   driven the endpoint. The OIDC flow is proven end to end against a LOCAL
   fake issuer (discovery, JWKS, token endpoint) in the test suite, and the
   SCIM service against the database; both are IMPLEMENTED-NOT-VALIDATED in
   `INTEGRATION_REGISTER.md`. The first validation against Entra, Okta or
   Google Workspace is an operator action.

## Consequences

- `SsoConnection` and `ScimToken` are SYSTEM-ONLY under RLS: a secret or a
  token digest never sits on the tenant path. `Organization` gains
  `verifiedAt`, `verifiedByEmail`, `requireSso`, `allowedEmailDomains`,
  `sessionMaxHours` (migration `20260905200000_enterprise_controls`).
- `SessionMethod` gains `sso`; `createSession` takes `maxHours`. The
  `staff_impersonation` method stays reserved and unissued.
- New audit events: `organization.verified` / `.suspended` / `.reactivated`
  / `.policy.set`, `staff.role.set`, `feature_flag.set`,
  `user.impersonation.started` / `.ended`, `audit.exported`,
  `sso.connection.updated`, `auth.sso.succeeded` / `.failed` / `.provisioned`,
  `scim.token.issued` / `.revoked`, `scim.user.provisioned` / `.deactivated`
  / `.reactivated`. The actor type `api_key` names a SCIM token.
- `/api/auth/sso` and `/api/scim` are public prefixes at the edge, each
  verifying everything it receives before trusting a claim.
- A SCIM-provisioned or SSO-provisioned account has no usable password and
  `onboardedAt` null: the person onboards on first sign-in like anyone else.
- Not built, and stated: SAML; SCIM Groups, bulk, sorting, ETags; an
  organisation-admin self-service SSO/SCIM page (staff-only by design);
  MFA enforcement as a tenant policy (the platform has no MFA of its own —
  the provider's `acr`/`amr` is not read yet); notifications on any of
  these events; system-health dashboards; plan/price editing beyond Stage 15;
  the retention and erasure review across the Stage 17–19 products (the
  scrub of `RepresentationConsent.invitedName` and the case tables' personal
  fields is specified nowhere yet and this ADR claims no erasure path).

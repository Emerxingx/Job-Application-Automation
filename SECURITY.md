# Security Policy

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** flow on this
repository (Security → Advisories). Please do not open a public issue for a
suspected vulnerability.

Include what you did, what happened, and what you expected. A proof of concept
helps. We will acknowledge receipt and keep you updated on remediation.

## Current security posture — stated honestly

This project is **pre-production**. It has not been penetration tested, and the
architecture baseline (`docs/programme/CURRENT_BASELINE.md` §5) records the known
weaknesses openly rather than implying they are absent. As of the Stage 00
baseline:

- **Known dependency advisories.** `npm audit` reports 8 (1 low, 7 moderate,
  **0 high**). The remaining moderates are dev-only tooling chains
  (`docs/adr/ADR-0017-dependency-remediation.md`).
- **Tenant isolation** is enforced by application-level query filters **and**,
  since Stage 01, by PostgreSQL row-level security on every table with a
  transaction-scoped tenant context (`ADR-0005`). Request handlers that have not
  yet been moved onto the tenant path are protected by their filters alone;
  the list is in `docs/programme/STAGE01_EVIDENCE.md`. The RLS proof has been
  run through a transaction-mode pooler locally but **not yet against the
  staging project's pooler**.
- **Sessions are revocable** server-side since Stage 01: logout, password
  change and the account holder's session list revoke immediately (`ADR-0004`).
- **MFA, email verification, account recovery and OAuth are not yet
  available.** They are delivered by Supabase Auth under the ratified Stage 01
  decision; the platform side is implemented but unvalidated, and the provider
  flows are blocked on credentials and network reachability.
- **CSRF** relies on `sameSite: lax` cookies; per-request tokens on
  state-changing routes are Stage 23.

Do not deploy this to production against real user data in its current state.

## What is already in place

- Passwords hashed with bcrypt.
- Security and account events (sign-in success and failure, sign-out, session
  revocation, password change, consent, organisation membership changes) are
  written to an append-only audit table without secrets; failed sign-ins record
  only a digest of the address.
- `AUTH_SECRET` is rejected **by value** if it matches the `.env.example`
  placeholder, and the application refuses to start in production without a real
  one. `PAYLOAD_SECRET` is deliberately separate.
- API keys are stored as SHA-256 hashes and compared in constant time; the
  plaintext is never re-displayed.
- The staff console is gated by two independent locks (a deploy-time email
  allowlist **and** a database role), fails closed, and degrades an unrecognised
  role to the weakest staff level.
- Outbound webhook URLs are validated against loopback and private ranges, and
  redirects are refused so a signed payload cannot be relayed.
- File downloads resolve through `path.basename` plus containment checks.

## Scope

In scope: this repository's source and configuration.
Out of scope: third-party services (Stripe, Anthropic, Adzuna, Payload) — report
those to their own vendors.

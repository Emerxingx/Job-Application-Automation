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

- **Known dependency advisories.** `npm audit` reports 14 (1 low, 7 moderate,
  6 high). The dominant contributor is `next@15.4.11`, which has no in-band patch
  — it is the final 15.4.x release. The supported remediation is Next 16.2.6+,
  inside Payload's declared peer range, scheduled as **Stage 01** work under
  `docs/adr/ADR-0017-dependency-remediation.md`.
- **Tenant isolation** is currently enforced by application-level query filters
  only. Row-Level Security is Stage 01 (`ADR-0005`).
- **Sessions are not yet revocable** server-side. Stage 01 (`ADR-0004`).
- **MFA is not yet available.** Stage 01.

Do not deploy this to production against real user data in its current state.

## What is already in place

- Passwords hashed with bcrypt.
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

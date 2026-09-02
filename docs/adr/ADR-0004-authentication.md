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

**The implementation approach is NOT selected in this ADR. It is decided at an
evidence-based gate at the start of Stage 01, before any authentication work
begins.**

This ADR records the **target characteristics** the platform must have, and the
**preserved baseline** it starts from. It deliberately does not pre-commit to
building identity security in-house.

### Why the choice is gated rather than made here
The platform will process candidate profiles, mailbox content and
employment-services case notes, and it is operated by a **non-technical founder**.
Building session revocation, MFA, recovery, OAuth and eventually enterprise SSO
in-house is a permanent security-maintenance obligation. That may still be the
right answer — but it must be an evidenced decision, not a default inherited from
what already exists.

### Preserved baseline (until the gate decides otherwise)
The existing implementation contains valid security engineering and is
**preserved and kept running** until a replacement decision is made:
bcrypt cost 10; `jose` HS256 sessions; `AUTH_SECRET` rejected **by value** against
the `.env.example` placeholder with a production throw; `PAYLOAD_SECRET` kept
distinct; and the staff-console two-lock gate.

### Target characteristics (required regardless of which option wins)
1. **Server-side, immediately revocable sessions.** Logout, password change and
   admin revoke take effect at once. Any cache in front of session validation must
   be invalidated **synchronously** on revocation, or revocation is not real.
2. Email verification and account recovery — single-use, expiring, hashed tokens.
3. MFA (TOTP) with recovery codes; **mandatory for staff and admin roles**.
4. OAuth (Google, Microsoft, Apple) as *additional identities linked to one
   account*, never a parallel account namespace.
5. Enterprise SSO (SAML/OIDC) reachable without re-architecting (Stage 20).
6. Device and session management visible to the account holder.
7. One identity per human across all four products and all organisation
   memberships (`ADR-0005`).
8. CSRF tokens on state-changing non-idempotent routes — `sameSite: lax` alone is
   not sufficient.
9. The staff-console two-lock gate (`STAFF_EMAILS` allowlist **and** `User.role`,
   failing closed, unknown role degrading to the weakest staff level) survives
   whichever option is chosen.

### The Stage 01 authentication decision gate
Before implementation begins, Stage 01 produces a written, evidence-based
comparison of **at least** these four options:

| | Option |
| --- | --- |
| **A** | Extend the existing custom authentication |
| **B** | Supabase Auth |
| **C** | Another appropriate managed identity platform, where justified |
| **D** | A hybrid architecture (e.g. local primary credential, delegated OAuth/SSO) |

Each option is assessed against **all** of the following, with evidence rather
than assertion:

- existing-user migration impact (there are live accounts and password hashes)
- Canada-region / data-residency implications (`ADR-0015`)
- MFA · email verification · account recovery
- OAuth · session and device revocation · enterprise SSO path
- RBAC integration (`ADR-0005`)
- PostgreSQL and **RLS** integration — specifically whether the option can supply
  the tenancy context RLS depends on
- auditability
- vendor lock-in · exit cost
- operational burden · security-maintenance burden
- cost at founder scale and at projected scale
- **founder operability** — can a non-technical owner run it day to day

**Neither outcome is pre-selected.** A managed provider is not automatically
chosen; custom auth is not automatically retained. The gate's written comparison
and its decision are recorded in `DECISION_REGISTER.md` and land as a new ADR
superseding this one's decision section.

**Until the gate completes, no authentication implementation work starts, and the
existing implementation remains in place unchanged.**

## Consequences
- Stage 01 carries an explicit, blocking decision gate as its first
  authentication activity. Stage 01 cannot PASS with the gate unrecorded.
- The target characteristics above are binding on whichever option is selected,
  so the gate decides *how*, never *whether*.
- If a managed provider is selected, migrating existing password hashes and the
  staff two-lock gate are the two hardest parts and must be evidenced in the
  comparison, not deferred.
- If extension is selected, the security-maintenance burden is accepted
  explicitly and recorded in `RISK_REGISTER.md` rather than absorbed silently.
- Whichever wins, session validation cost and its cache-invalidation rule are a
  design obligation, not an optimisation.

## Revisit when
The Stage 01 gate records its decision — at which point this ADR is superseded on
the implementation question and retained for the target characteristics. After
that: enterprise SSO demand, a compliance regime, or a change in the
security-maintenance burden that alters the comparison.

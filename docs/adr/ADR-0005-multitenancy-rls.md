# ADR-0005 — Multi-tenancy: RBAC + ABAC + PostgreSQL RLS

**Status:** Proposed · **Date:** 2026-09-02

## Context
Measured: tenant isolation is **63 hand-written `where: { userId }` clauses**
across `src/lib`. There is no RLS, no query-level guard, and no test that proves
isolation. `Organization` and `Membership` exist in the schema with **zero code
references** — multi-tenancy is schema-only.

Three of the four target products are inherently multi-tenant: employer
organisations, staffing agencies, and WorkBC service providers. Under the current
model, one forgotten `where` clause exposes another organisation's candidates,
case notes or placements — and nothing would detect it.

The brief is explicit: *never rely only on hidden UI controls.*

## Options
- **A. Application-level filtering only** (status quo). One omission is a breach.
- **B. RLS only.** Strong, but policy-only enforcement is hard to reason about in
  application code and easy to bypass with a superuser connection.
- **C. Both** — application filters as the primary path, RLS as a backstop.

## Decision
**Option C, defence in depth.**

1. **One identity, many memberships.** A user is a person. `Membership` links
   them to an organisation with a role. A user may simultaneously be a candidate,
   a recruiter at an agency, and a case manager at a service provider.
2. **RBAC** for coarse capability: roles per organisation type
   (candidate, recruiter, hiring manager, agency owner, case manager, supervisor,
   platform admin, support).
3. **ABAC** where roles are insufficient: record ownership, client assignment,
   candidate consent, jurisdiction, data classification.
4. **PostgreSQL RLS** on every tenant-scoped table, keyed on a session-scoped
   `app.current_user_id` / `app.current_organization_id` set per connection.
5. **Application filters stay.** RLS is the backstop, not the replacement — it
   catches the forgotten clause; it does not excuse it.

## Consequences
- Requires PostgreSQL (`ADR-0002`). This is why the database decision sequences
  first.
- Every connection must set the tenancy GUCs. A missing GUC must **deny**, never
  default to permissive — the policy is written so an unset variable matches no
  rows.
- Background workers and migrations run as a role that bypasses RLS. That role's
  use must be narrow, explicit and audited.
- **A permanent negative-authorisation suite is mandatory**: for every
  tenant-scoped table, prove user A cannot read user B's row — with application
  filters removed in the harness, so the test exercises RLS specifically.
- Connection pooling must not leak session GUCs between checkouts. This is
  verified by the Stage 01 pooled-runtime isolation proof above, against the real
  deployment — not by inspection.

## Revisit when
A tenant needs physical isolation for contractual or public-sector reasons —
likely first from a WorkBC service provider.

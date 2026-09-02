# ADR-0005 — Multi-tenancy: RBAC + ABAC + PostgreSQL RLS

**Status:** Proposed · **Date:** 2026-09-02 · **Amended:** 2026-09-02 (see the amendment below — one requirement was wrong)

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
4. **PostgreSQL RLS** on every tenant-scoped table, keyed on
   `app.current_user_id` / `app.current_organization_id` set **transaction-scoped,
   inside the same transaction as the query**. *(Amended 2026-09-02 — this
   originally said "session-scoped … per connection", which the mechanism proof
   showed to be a cross-tenant leak. See the amendment below.)*
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
  verified by proof, not by inspection: the mechanism by
  `tests/rls-isolation.test.ts` in CI, and the deployed configuration by the
  Stage 01 pooled-runtime proof against the real pooler.

## Amendment — 2026-09-02, after building the mechanism proof

`tests/rls-isolation.test.ts` runs this ADR's claims against a real PostgreSQL
16.13 in CI. Writing it corrected one requirement in this ADR and added three
that were missing. All four are now conditions of acceptance for Stage 01.

**1. Transaction-scoped, not session-scoped — this ADR was wrong.** Point 4
originally required the tenancy GUCs to be set "per connection". On a pooled
connection that context outlives the request that set it: the proof reproduces a
request establishing *no* tenant context reading the previous tenant's rows, on a
connection whose backend PID is asserted to be unchanged. The requirement is
`set_config(name, value, true)` inside the query's own transaction. Setting it
outside a transaction is not a milder version of the same thing — it is discarded
before the next statement runs, and the request sees nothing.

**2. Every policied table must also be `FORCE ROW LEVEL SECURITY`.** `ENABLE`
alone does not bind the table's *owner*, and on a managed PostgreSQL the
application's migration role usually is the owner. Enabled policies that are
never applied is the worst available failure mode: it reviews clean and returns
every tenant's rows.

**3. Policies must be equality against a real tenant id, never a `NULL` test.**
`current_setting(name, true)` yields `NULL` on a connection that has never seen
the setting and the **empty string** on any connection where it has been set and
cleared. A guard written as `IS NULL` therefore fires once per connection
lifetime and never again. Equality against the tenant id rejects both states.

**4. The tenant id must be a bound parameter.** `SET` and `SET LOCAL` accept no
bind parameters, so writing them literally forces interpolation of the tenant id
into SQL text — an injection site in the one statement that decides who may see
what. `set_config($1, $2, true)` is the parameterised equivalent and is
mandatory.

Point 5 of the decision is unchanged and worth restating against these findings:
RLS is the backstop. Three of the four corrections above describe ways the
backstop can be present and inert, which is exactly why the application filters
stay.

### Still outstanding
The proof establishes the mechanism on a stock PostgreSQL. It does not establish
the deployed configuration. The pooled-runtime proof this ADR requires — the same
assertions through the real connection pooler, in the pool mode actually
configured — needs the provisioned project and remains a Stage 01 exit-gate
condition.

## Revisit when
A tenant needs physical isolation for contractual or public-sector reasons —
likely first from a WorkBC service provider.

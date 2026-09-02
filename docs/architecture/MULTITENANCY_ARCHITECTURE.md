# Multi-Tenancy Architecture

**Decision:** `../adr/ADR-0005-multitenancy-rls.md`

## The problem being solved
Measured today: isolation is **63 hand-written `where: { userId }` clauses**, no
RLS, no isolation test, and `Organization`/`Membership` with **zero code
references**. Three of four target products are inherently multi-tenant. One
forgotten clause is a breach, and nothing would detect it.

## Model

**One identity, many memberships.** A person has one `User`. Organisations are
typed: `employer`, `staffing_agency`, `service_provider`, `career_consultancy`,
`training_organization`, `platform`. A `Membership` links a user to an
organisation with a role. The same person can be a candidate, a recruiter at an
agency, and a case manager at a service provider — simultaneously, without
duplicate accounts.

**Candidate data is owned by the candidate**, not by an organisation. An
organisation gains access through an explicit relationship — consent (P2),
assignment (P3), or engagement (staffing) — never by virtue of existing.

## Three enforcement layers

**1. Application filters (existing).** Retained. Every query scopes by tenant.
This is the primary path and the one that produces good query plans.

**2. Row-Level Security (new).** Policies on every tenant-scoped table, keyed on
session GUCs (`app.current_user_id`, `app.current_organization_id`). Written so
an **unset GUC matches no rows** — a missing context denies rather than exposes.
RLS is a backstop for the forgotten clause; it does not excuse one.

**3. Authorization service.** RBAC for coarse capability; ABAC for
record-level facts — ownership, assignment, consent, jurisdiction, data
classification. UI hiding is never an authorization mechanism.

## Role model (initial)

| Organisation type | Roles |
| --- | --- |
| *(none — individual)* | candidate |
| Employer | owner, admin, hiring_manager, recruiter, interviewer, viewer |
| Staffing agency | owner, admin, recruiter, delivery, finance |
| Service provider | admin, supervisor, case_manager, viewer |
| Career consultancy | owner, consultant, viewer |
| Training organization | owner, program_admin |
| Platform | support, billing_ops, admin |

Platform staff continue to pass the **two-lock gate**: the `STAFF_EMAILS`
deploy-time allowlist **and** the database role, failing closed, with an
unrecognised role degrading to the *weakest* staff level. This existing pattern
is preserved and becomes the standard for every admin surface.

## Operational requirements
- Every connection sets tenancy GUCs before the first query. With a transaction-
  mode pooler this must be `SET LOCAL` inside the transaction, or context leaks
  between checkouts.
- Background workers and migrations run under a narrow, audited RLS-bypassing
  role (`ADR-0011`).
- **A permanent negative-authorisation suite is mandatory**: per tenant-scoped
  table, prove user A cannot read user B's row — with application filters
  removed in the harness, so the test exercises RLS specifically.

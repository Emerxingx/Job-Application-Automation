# Role & Permission Matrix

**Model:** `../architecture/MULTITENANCY_ARCHITECTURE.md` · **Decision:** `../adr/ADR-0005-multitenancy-rls.md`

Legend: **F** full · **W** write · **R** read · **C** consent-gated ·
**A** assignment-gated · **—** none

## Candidate-owned data

| Resource | Candidate | Employer recruiter | Agency recruiter | Case manager | Platform support | Platform admin |
| --- | --- | --- | --- | --- | --- | --- |
| Own profile / digital twin | F | C (read) | C (read) | A (read) | R (audited) | R (audited) |
| **Sensitive demographics** | F | — | — | — | — | — |
| Career evidence | F | C (read) | C (read) | A (read) | — | — |
| Résumés / documents | F | C (read) | C (read) | A (read) | — | — |
| Applications / Job Folder | F | — | — | A (read) | R (audited) | R (audited) |
| Email / calendar content | F | — | — | — | — | — |
| Billing / invoices | R | — | — | — | R | W |
| Consents | F | — | — | R | R | R |

**Nobody reads the sensitive schema through a role.** Access is a separate,
audited grant for EEO reporting only (`../adr/ADR-0007-sensitive-data-isolation.md`).
Support and admin reads of candidate data are audited without exception.

## Employer organisation (P2)

| Resource | Owner | Admin | Hiring manager | Recruiter | Interviewer | Viewer |
| --- | --- | --- | --- | --- | --- | --- |
| Organisation settings | F | W | — | — | — | — |
| Members & roles | F | W | — | — | — | R |
| Requisitions | F | F | W (own) | F | R | R |
| Candidate search | F | F | R | F | — | — |
| Talent pools | F | F | R | F | — | — |
| Submissions / pipeline | F | F | W (own reqs) | F | R (assigned) | R |
| Interviews | F | F | W | F | W (own) | R |
| Offers | F | W | W (own reqs) | R | — | — |
| Employer reporting | F | F | R (own) | R | — | R |
| Billing | F | W | — | — | — | — |

Enforced in code since Stage 18 (`src/lib/employer/roles.ts`, ADR-0033):
owner and admin act as admin; a recruiter sources, asks for disclosure and
runs the pipeline; a hiring manager owns their requisitions and their offers;
an interviewer records only an interview they are named on; reporting is
organisation-level for every role but interviewer (the "own" cut for a hiring
manager is not built). Hiring-team notes are pipeline writes (not the
interviewer's). Nothing here shows a candidate who has not granted disclosure
to that organisation.

## Staffing agency

| Resource | Owner | Admin | Recruiter | Delivery | Finance |
| --- | --- | --- | --- | --- | --- |
| Client contracts | F | W | R | R | R |
| Fee structures | F | W | R | — | R |
| Engagements | F | F | W (own) | W | R |
| Representation consent | F | F | W (own) | R | — |
| Placements | F | F | W (own) | W | R |
| Placement invoicing | F | W | — | — | F |
| Recruiter productivity | F | F | R (own) | R | R |

"Own" is the engagement's `ownerRecruiterId`. An engagement with NO owner is
writable by every recruiter of the agency (stated deliberately; ADR-0034).
A staffing agency is a verified organisation type: staff create it.

## Service provider (P3 — WorkBC)

| Resource | Admin | Supervisor | Case manager | Viewer |
| --- | --- | --- | --- | --- |
| Organisation / centres | F | R | — | — |
| Members & assignment | F | W | — | — |
| Caseload (invite, assign, close) | F | F | A (own) | R (aggregate) |
| Client case record | F | R | A (own) | — |
| **Case notes** (every read audited) | F | R | A (own) | — |
| Assessments / employment plans | F | R | A (own) | — |
| Interventions / referrals | F | R | A (own) | — |
| Outcomes / retention follow-up | F | R | A (own) | R (aggregate) |
| Reporting | F | F | R (own) | R (aggregate) |
| Service roles, retention policy | F | — | — | — |

Case-manager access is **assignment-gated**: a case manager sees only clients
assigned to them. A supervisor reads every case (notes included) and manages
the caseload - invites, assigns, closes - but writes no note, assessment, task
or outcome (Stage 17, `src/lib/cases/roles.ts`; this row is what the tests
enforce). Aggregate views apply small-cohort suppression (not built at
Stage 17: a viewer sees their organisation's counts).

## Platform staff

Reached only through the **two-lock gate**: the `STAFF_EMAILS` deploy-time
allowlist **and** the database role. Fails closed. An allowlisted person with an
unrecognised role is admitted at `support`, the weakest level — never `admin`.

| Capability | support | billing_ops | admin |
| --- | --- | --- | --- |
| Customer lookup (audited) | R | R | R |
| Tickets / CRM notes | W | W | W |
| Invoices / refunds | R | W | W |
| Plans / prices / entitlements | — | R | W |
| Job sources / connectors | — | — | W |
| AI models / prompt versions | — | — | W (approval required) |
| Matching weights | — | — | W (versioned) |
| Feature flags | — | — | W |
| Roles & permissions | — | — | W |
| **Impersonation** | read-only, reason, time-boxed | same | same |
| RLS policies / auth logic | — | — | **— (code only)** |

The last row is the `ADR-0019` boundary: **no admin role can edit
security-critical implementation.** A Tier 1 control may never widen a Tier 2
boundary.

## Enforcement rules
**Stage 17 (ADR-0032):** the service-provider table above is enforced by `src/lib/cases/roles.ts` (`caseRoleOf`: owner/admin → admin; `Membership.serviceRole` → supervisor / case_manager / viewer, null or unknown → viewer) and the service (`canOpenCase`, `canWriteCase`, `canManageCaseload`); assignment gating is tested; case notes are audited on every read and write.

1. UI hiding is **never** an authorization mechanism.
2. Every permission is checked server-side and again by RLS.
3. Consent gates (**C**) and assignment gates (**A**) are ABAC checks, not roles.
4. Every table has a negative-authorization test proving cross-tenant reads fail.

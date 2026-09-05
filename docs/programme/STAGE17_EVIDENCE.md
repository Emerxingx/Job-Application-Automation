# Stage 17 - Employment services / case-manager companion (Level 0) - evidence

Recorded 2026-09-05 on branch `claude/stage-17-employment-services`
(PR #29), stacked on Stage 16 (PR #28) - 15 (#27) - 14 (#26) - 13 (#25) -
12 (#24) - 11 (#23) - 10 (#22) - 09 (#21) - 08 (#20) - 07 (#19) - 06 (#18) -
05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) - 01 (#13, PARTIAL). Every line
was run or read; nothing is PASS on the strength of a mock, a skipped test or
a document. This stage's honest centre: **a case manager can run a caseload
end to end on this platform, at integration Level 0 - there is no WorkBC
connection of any kind and every page says so (ADR-0020) - with the
client's recorded consent as the gate on every read about them, the
RESTRICTED case notes isolated by organisation and audited on every access,
and a copilot that recommends and decides nothing. Deploying this product
to a public-sector customer remains BLOCKED on L-1, which is counsel's
question, not engineering's.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 17 (Product 3): a companion platform for case
managers; no fake WorkBC integration. Organisations (service provider),
supervisor / case-manager roles, client assignment, cases, assessments,
barriers, employment goal, target occupation, action plans, tasks,
interventions, case notes, job recommendations, résumé versions, application
activity, interviews, training referrals, employment outcomes, retention
follow-up. A copilot that recommends only. Security: case notes RESTRICTED,
strict organisational isolation via RLS, every access audited, public-sector
retention rules configurable per organisation. Testing: cross-organisation
isolation, copilot recommendation-only enforcement, retention behaviour.
Acceptance: a case manager runs a full caseload; no AI output is auto-applied
to a client record. Exit gate: product usable; WorkBC integration at level 0.

## 2. Organisations, roles and consent - `PASS`

`Organization.type = service_provider` with the case roles as a named set
over the ladder (`Membership.serviceRole`: supervisor · case_manager ·
viewer; owner/admin → admin; null or unknown → viewer). A supervisor or
admin invites a client by email (`case.invited`, audited); the case is
`invited` and holds nothing about the person; the CLIENT accepts under
Settings and a versioned `ConsentRecord` (`employment_services_case`) is
written and the case opens; declining and withdrawing are the client's
too, and withdrawal revokes the consent. Before consent and after
withdrawal every read about the client and the copilot are refused (403).
Migration `20260905160000_case_management` (eight tables and
`Membership.serviceRole`), RLS generated in `20260905160100_rls_case_management`,
and - after the independent review (§12) - `20260905160200_case_invitation_by_email`:
an invitation is addressed to an EMAIL and the accounts table is never
consulted (the answer is identical with or without an account; the audit
row carries a digest); the person is linked to the case only when they
accept, in one transaction with the consent record; every engagement is a
new `Case` row; a declined person is not re-invited by the platform; the
name is snapshotted at acceptance so a closed case never reads the user
row again. A service-provider organisation is not self-serve: the service
refuses creation without the staff verification flag, which only the
console's two-lock gate supplies.

## 3. Isolation and the RESTRICTED rows - `PASS`

RLS: `CaseNote`, `CaseAssessment`, `CaseTask`, `CaseOutcome`,
`CaseFollowUp`, `CaseRecommendation` are `org`-scoped (the organisation's
accepted members, nobody else - the client sees none of them, another
provider sees none of them); `Case` is visible to the organisation and to
the client it concerns, writable on the tenant path by members only;
`RetentionPolicy` is `orgReadOnly`. The `Case` policy is split (review M3):
`tenant_access` (ALL) is organisation-only and a SELECT-only `tenant_read`
adds the linked client - tested: the client's UPDATE is refused and their
`deleteMany` removes nothing. Assignment gating (a case manager opens
and writes only cases assigned to them; a supervisor reads all and writes
none; a viewer sees counts) is the service's, on top; a case a role may not
open is 404. Every read and write of a note or an assessment is audited
FIRST, strictly, on the system client, with ids and kinds - never a body, a
barrier or a name (tested: the note text and the barrier text appear in no
audit row). `caseNote`, `caseAssessment` and `caseBarriers` (and their snake-case
forms) are RESTRICTED keys the AI gateway refuses - case-specific names,
because a Stage 10 folder's `assessments` COUNT is not RESTRICTED and must
keep passing (review L9); a static test refuses a reference to a case note or
assessment under matching, eligibility, analytics, career and the gateway,
and in the copilot and the client view.

## 4. The client view and the copilot - `PASS` (recommends only)

`client-view.ts`: a delegated read on the system client after four checks
(member of the case's organisation, a role that may open the case, the case
open and linked, THE CASE'S OWN consent record current - never "any consent
for the purpose", so a second provider's consent neither opens nor survives
another's withdrawal; review M2, tested) and an audit row (`case.client.read`): application
counts and statuses, interviews, eligibility rule outcomes, compatibility
dimensions, résumé presence, target titles, locations, this deployment's
postings for the target occupation. `copilot.ts` is pure and deterministic
(`COPILOT_VERSION`): nine patterns with fixed thresholds and the numbers
that triggered them. `runCopilot` writes `CaseRecommendation` rows and
nothing else - the test snapshots the client's applications, history and
skills and the case's notes, assessments, tasks and row, and they are
byte-identical after a run - refreshes without duplicates, supersedes a
vanished pattern, and is audited (`case.copilot.run`). The case manager
accepts or dismisses; accepting creates an action-plan task only when asked,
citing the recommendation. No AI provider is called anywhere in the stage.

## 5. The record - `PASS`

Assessments (intake · review; barriers; goal), action plan (task ·
intervention · referral, a referral naming a licensed Stage 16 offering),
outcomes with retention follow-ups at 4 / 12 / 24 weeks for an outcome that
can be retained, follow-up statuses, closing with a reason. Pages
`/dashboard/cases` (caseload as the role sees it, invitation, the admin's
service roles and retention policy) and `/dashboard/cases/:caseId`
(the client's consented job-search summary, plan, outcomes, the RESTRICTED
notes and assessments - each page view audits its reads - and the
recommendations); the client's invitations and cases under Settings; the
navigation entry only for a member of a service-provider organisation.
Routes under `/api/cases/*` (every one through `caseRequest`: the
organisation's tenant context plus the actor's role).

## 6. Retention - `PASS`

`RetentionPolicy` per organisation (`caseNoteDays`, `closedCaseDays`,
30-3650), set by an admin and audited. `npm run cases:retention` deletes
the notes and assessments of cases CLOSED longer ago than the first
(measured from closure - an open case is never thinned by age, review M5)
and closed cases (with everything under them) closed longer ago than the
second, audited per organisation with counts including the rows the
cascade removed; **an organisation without a policy is untouched**
(tested), because nothing is destroyed on a platform default. No scheduler
exists.

## 7. Tests - `PASS`

`tests/cases-copilot.test.ts` (8: patterns, thresholds, determinism,
recommend-not-decide wording, roles, static guards) and `tests/cases.test.ts`
(13, database): the actor and roles; the provider-organisation gate;
invitation by email (case manager refused, an address with no account
recorded all the same, duplicate 409, digest not address in the audit row,
nothing read before consent); the client's own tenant path, the stranger's
and another provider's; consent recorded in one transaction; the linked
row SELECT-only for the client under RLS (update refused, delete removes
nothing); a person invited before signing up sees the invitation once their
account exists, declines with nothing recorded about them, and is not
re-invited; consent per case across two providers; assignment gating; supervisor read-only;
viewer counts; another provider 404; audited note and assessment writes and
reads with no text in the trail; the client and another provider see no
note; the plan, referral gate, outcomes and follow-ups; the copilot's
snapshot proof, audit, refresh, supersede and decisions; another provider's
admin refused on a task, a follow-up and a recommendation by id;
withdrawal with the snapshotted name and the named close reasons; a new
engagement is a new case with no access to the old one's rows; the
retention purge (open case untouched, closed case thinned from closure,
cascade counted) and the no-policy organisation; the invitation rate limit.
Root suite: 1152 / 1152 (0 skipped).

## 8. What is NOT done, and why

- **No WorkBC integration** at any level (ADR-0020 Level 0). Nothing here
  connects to, imports from, or exports to a government system.
- **Public-sector deployment is BLOCKED on L-1** (which privacy regime
  applies; residency and retention a public body requires). The retention
  policy is configurable per organisation for exactly that reason; the
  answer is configuration, not redesign.
- **Aggregate reporting across organisations** with small-cohort
  suppression is not built (a viewer sees their organisation's counts).
- **An invitation reaches the person only if they have, or create, an
  account with that address**; no email is sent (no mail provider is
  wired), so the provider tells the client in person. A declined
  invitation is final on the platform.
- **The service-provider organisation is created by staff** (the two-lock
  console gate) and no console screen for it exists yet: until Stage 20's
  console work, creation is a staff-run script or a direct call - recorded
  as an operator step below, not claimed as a page.
- **Referrals cite an offering id**; a picker over licensed offerings is not
  built, and outside a test database no offering is licensed (Stage 16).

## 9. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 7 warnings (baseline ceiling 8) |
| Typecheck | 0 |
| Tests | **1152 / 1152**, 0 skipped (Stage 16: 1130) - new: `cases-copilot` 8, `cases` 13 |
| Build | passes; `/dashboard/cases`, `/dashboard/cases/[caseId]`, `/api/cases/*` present |
| Migrations | **forty-four** (three new; RLS generated and regenerated in-branch after the review - the stage is unreleased and no database outside this environment had applied it); fresh-database rehearsal: 44 applied, `migrate diff` clean, **137** forced-RLS tables in `public` |

## 10. Exit gate - verdict

| Exit criterion | Verdict |
| --- | --- |
| Product usable: a case manager runs a full caseload | **PASS** on engineering - invitation, consent, assessment, plan, referrals, notes, outcomes, follow-up, copilot, roles |
| Cross-organisation isolation | **PASS** - RLS `org` policies and the service's assignment gating, tested |
| Copilot recommendation-only | **PASS** - writes recommendations and nothing else, proven by snapshot; the case manager decides |
| Retention behaviour | **PASS** - per organisation, no policy no purge, tested |
| WorkBC integration at Level 0 | **PASS** - none exists, none is claimed |
| Public-sector deployment | **BLOCKED (LEGAL, L-1)** |

**Stage 17: PASS on engineering at Level 0; public-sector deployment
BLOCKED on L-1.** Merge posture inherited from the stack.

## 11. What a founder or operator has to do

1. Counsel's answer to L-1 (regime, residency, retention) before any
   public-sector customer; then set each organisation's retention policy.
2. A data-sharing agreement before any integration level above 0
   (ADR-0020), recorded in `COMPLIANCE_REGISTER.md`.
3. Create each verified service-provider organisation as staff
   (`createOrganization(..., { verifiedOrganization: true })` behind the
   console gate; no self-serve path exists, by design).

## 12. Independent review

An independent adversarial review of the Stage 17 diff (a separate agent
with the whole tree, asked to break consent, isolation, the RESTRICTED
handling, the copilot's write boundary, retention and the docs) returned
1 HIGH, 4 MEDIUM and 5 LOW findings. Every HIGH and MEDIUM is fixed on the
branch; every LOW is fixed or recorded here. Nothing was suppressed.

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| H1 | HIGH | `inviteClient` looked the address up and answered "no account with that email": an account-existence oracle for any member of any self-created service-provider organisation. | Fixed at the root: an invitation is addressed to an email and the accounts table is never consulted; the person is linked only when they accept (`20260905160200_case_invitation_by_email`); the audit row carries a digest; invitations are rate-limited per supervisor (30/h) and per organisation (200/day); a service-provider organisation is created only with the staff verification flag (the console's two-lock gate); tested. |
| M2 | MEDIUM | The delegated read checked consent BY PURPOSE, so a person consented to provider B stayed readable by provider A after withdrawing from A, and A's case could be read on B's consent. | Fixed: `delegated()` checks the case's own `consentRecordId` (that record, that person, unrevoked); tested with two providers. |
| M3 | MEDIUM | The `Case` RLS predicate put the client in USING, so the client could UPDATE or DELETE their own case row on the tenant path. | Fixed: the `custom` kind gained `readUsing`; `tenant_access` (ALL) is organisation-only and `tenant_read` (SELECT) adds the client; migration regenerated; tested (update refused, `deleteMany` removes nothing). |
| M4 | MEDIUM | Re-inviting a declined or closed client reused the row, so a new engagement exposed the earlier engagement's RESTRICTED notes and assessments before any new consent. | Fixed: the (organisation, client) unique key is gone; every engagement is a new `Case`; one OPEN case per pair is enforced under an advisory lock at acceptance; a declined person is not re-invited; tested (the old case keeps its note, the new case reads none). |
| M5 | MEDIUM | Retention purged an OPEN case's notes by age and under-counted what the cascade destroyed. | Fixed: notes and assessments are thinned only for CLOSED cases, from closure; the cascade's children are counted in the audit row; tested (an old note on an open case survives). |
| L6 | LOW | The user row was read for a closed or withdrawn case's identity. | Fixed: the name is snapshotted at acceptance (`invitedName`); a closed case shows the snapshot and an invitation the typed address; tested. |
| L7 | LOW | `closeCase` wrote a free-text reason into the audit trail. | Fixed: `CLOSE_REASONS` is a named set (route schema, service check, a select in the UI); `client_withdrew` is the client's alone. |
| L8 | LOW | `ROLE_PERMISSION_MATRIX.md` and the ADR contradicted the code (admin on notes, supervisor on outcomes and closing). | Fixed in the documents to match the tested code: admin full on notes; supervisor reads outcomes and closes cases; the matrix row now says so. |
| L9 | LOW | `assessment` / `assessments` / `barriers` as RESTRICTED keys would refuse a Stage 10 folder payload carrying an `assessments` count. | Fixed: case-specific keys (`caseAssessment(s)`, `caseBarriers`, snake-case forms); a test asserts the folder count keys are NOT restricted. |
| L10 | LOW | The case pages surfaced a `CaseError` / `OrganizationAccessError` as a 500; acceptance wrote the consent record and opened the case in two statements. | Fixed: both pages `notFound()` on either error; acceptance is one transaction (consent + link + open) under the advisory lock. |

Test gaps the review named (client DELETE under RLS, re-invite after
decline, two-provider consent, invitation audit and rate limit, an open
case's note under retention, cross-organisation access to a follow-up, a
task and a recommendation by id) are all covered by `tests/cases.test.ts`
now (9 → 13 subtests).

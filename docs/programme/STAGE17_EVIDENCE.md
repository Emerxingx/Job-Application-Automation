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
`Membership.serviceRole`), RLS generated in `20260905160100_rls_case_management`.

## 3. Isolation and the RESTRICTED rows - `PASS`

RLS: `CaseNote`, `CaseAssessment`, `CaseTask`, `CaseOutcome`,
`CaseFollowUp`, `CaseRecommendation` are `org`-scoped (the organisation's
accepted members, nobody else - the client sees none of them, another
provider sees none of them); `Case` is visible to the organisation and to
the client it concerns, writable on the tenant path by members only;
`RetentionPolicy` is `orgReadOnly`. Assignment gating (a case manager opens
and writes only cases assigned to them; a supervisor reads all and writes
none; a viewer sees counts) is the service's, on top; a case a role may not
open is 404. Every read and write of a note or an assessment is audited
FIRST, strictly, on the system client, with ids and kinds - never a body, a
barrier or a name (tested: the note text and the barrier text appear in no
audit row). `caseNote`, `assessment` and `barriers` are RESTRICTED keys the
AI gateway refuses; a static test refuses a reference to a case note or
assessment under matching, eligibility, analytics, career and the gateway,
and in the copilot and the client view.

## 4. The client view and the copilot - `PASS` (recommends only)

`client-view.ts`: a delegated read on the system client after four checks
(member of the case's organisation, a role that may open the case, the case
open, the consent current) and an audit row (`case.client.read`): application
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
notes and assessments older than the first and closed cases (with
everything under them) closed longer ago than the second, audited per
organisation with counts; **an organisation without a policy is untouched**
(tested), because nothing is destroyed on a platform default. No scheduler
exists.

## 7. Tests - `PASS`

`tests/cases-copilot.test.ts` (8: patterns, thresholds, determinism,
recommend-not-decide wording, roles, static guards) and `tests/cases.test.ts`
(9, database): the actor and roles; invitation (case manager refused, no
account 404, duplicate 409, nothing read before consent); the client's own
tenant path, the stranger's and another provider's; consent recorded; the
client cannot write the case; assignment gating; supervisor read-only;
viewer counts; another provider 404; audited note and assessment writes and
reads with no text in the trail; the client and another provider see no
note; the plan, referral gate, outcomes and follow-ups; the copilot's
snapshot proof, audit, refresh, supersede and decisions; withdrawal; the
retention purge and the no-policy organisation. Root suite: 1148 / 1148
(0 skipped).

## 8. What is NOT done, and why

- **No WorkBC integration** at any level (ADR-0020 Level 0). Nothing here
  connects to, imports from, or exports to a government system.
- **Public-sector deployment is BLOCKED on L-1** (which privacy regime
  applies; residency and retention a public body requires). The retention
  policy is configurable per organisation for exactly that reason; the
  answer is configuration, not redesign.
- **Aggregate reporting across organisations** with small-cohort
  suppression is not built (a viewer sees their organisation's counts).
- **Inviting by email discloses whether an address has an account** to a
  supervisor; accepted and audited (ADR-0032 consequences).
- **Referrals cite an offering id**; a picker over licensed offerings is not
  built, and outside a test database no offering is licensed (Stage 16).

## 9. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 7 warnings (baseline ceiling 8) |
| Typecheck | 0 |
| Tests | **1148 / 1148**, 0 skipped (Stage 16: 1130) - new: `cases-copilot` 8, `cases` 9 |
| Build | passes; `/dashboard/cases`, `/dashboard/cases/[caseId]`, `/api/cases/*` present |
| Migrations | **forty-three** (two new, additive; RLS generated); fresh-database rehearsal: 43 applied, `migrate diff` clean, **137** forced-RLS tables in `public` |

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

## 12. Independent review

__REVIEW__

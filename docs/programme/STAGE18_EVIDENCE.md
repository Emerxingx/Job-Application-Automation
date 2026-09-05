# Stage 18 - Corporate / talent acquisition OS - evidence

Recorded 2026-09-05 on branch `claude/stage-18-talent-acquisition`
(PR __PR__), stacked on Stage 17 (PR #29) - 16 (#28) - 15 (#27) - 14 (#26) -
13 (#25) - 12 (#24) - 11 (#23) - 10 (#22) - 09 (#21) - 08 (#20) - 07 (#19) -
06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) - 01 (#13, PARTIAL).
Every line was run or read; nothing is PASS on the strength of a mock, a
skipped test or a document. This stage's honest centre: **an employer runs a
requisition to a hire on this platform with the candidate in control at
every point - a score and a region before consent, what they agreed to
show that one employer after it, never a self-identification answer - and
NO candidate can be disclosed in production until counsel records the
consent wording (L-5): the draft version is refused there by code, not by
a note.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 18 (Product 2): employer organisations, hiring
managers, recruiters, requisitions, job creation, sourcing, talent pools,
matching, candidate consent, submissions, pipeline, interviews, notes,
offers, hires; reporting (recruiter productivity, source performance,
time-to-shortlist/interview/hire). Security: candidate consent gates every
employer-visible disclosure; recruiter visibility honours the Stage 02
preference; sensitive attributes never employer-visible. Testing:
consent-gating, cross-employer isolation, visibility-preference enforcement.
Acceptance: no employer sees a candidate who has not consented to that
disclosure. Exit gate: requisition→hire flow complete with consent enforced.

## 2. Organisations, roles and requisitions - `PASS`

`Organization.type = employer`; `Membership.serviceRole` names `recruiter` ·
`hiring_manager` · `interviewer` · `viewer` (owner/admin → admin; unknown →
viewer, the weakest). `src/lib/employer/roles.ts` enforces the matrix row
(ROLE_PERMISSION_MATRIX.md, Employer): recruiters and admins source and ask;
a hiring manager owns their requisitions and their offers; an interviewer
writes only an interview they are named on; a viewer reads. A requisition
is a draft until opened; **opening publishes it through the Stage 05 gate
and the Stage 06 pipeline** as a canonical `Job` (`source: employer`, the
organisation's name, a `JobSnapshot`) that every candidate's agent matches
like any posting; editing an open requisition re-publishes to the same job;
filled or closed closes the job at once (never inferred), on hold marks it
unknown. The `employer` source is registered enabled by default with a
complete record (first-party rows; `SOURCE_ACCESS_POLICY.md`); staff can
disable it, which stops every publication. Migration
`20260905180000_talent_acquisition` (nine tables), RLS generated in
`20260905180100_rls_talent_acquisition`.

## 3. Disclosure: the candidate's consent, per employer - `PASS` (mechanism) · `BLOCKED (LEGAL, L-5)` in production

`Disclosure` is one row per (organisation, candidate). A recruiter may ask
only a candidate whose recruiter visibility is `anonymous` or `visible`
(`hidden` cannot be asked; the refusal says no more than "not open to
recruiters"). The candidate answers under Settings: granting writes a
`ConsentRecord` (`employer_disclosure`) in ONE transaction with the grant
and moves the employer's waiting submissions to `consented`; declining is
final for that employer (the Stage 17 rule); revoking revokes THAT consent
record, withdraws every disclosed submission and removes every pool
membership. Applying to an employer's posting on the platform is the
candidate's own grant. Every employer-visible read asks one question
(`grantedDisclosure`: granted AND its own consent record unrevoked - never
"any consent for the purpose"), and the identity and profile reach the
employer only through `candidate-view.ts`, behind that check and an audit
row (`employer.candidate.read`). Under RLS the candidate may SELECT their
own `Disclosure` row and nothing more (`custom` + `readUsing`, the Stage 17
review's lesson applied at design time; tested: update refused, delete
removes nothing); the pipeline tables are `org`-scoped and the candidate
sees none of them. **The consent version is `2026-09-05-draft` and
`grantConsent` refuses a `-draft` purpose when `NODE_ENV` is `production`**
(`ConsentWordingPendingError`, 503; asserted by a test).

## 4. Sourcing and the pipeline - `PASS`

`sourceCandidates`: the candidates who chose to be seen (erased and
not-yet-onboarded accounts excluded), scored against the requisition's
published job with `scoreCompatibility` (Stage 08, active weights), returned
as cards - fit, matched and missing keywords, region (country only for
`anonymous`), name and headline ONLY for `visible` - audited with counts.
A hidden candidate is never in the set (tested). `stage-machine.ts`:
sourced → consent_requested → consented → screening → interviewing →
offered → hired; rejected and withdrawn terminal; no backward move;
`consented` / `consent_requested` are the candidate's stages; every stage at
or past `consented`, every interview and every offer refuses without a
granted disclosure. Every move writes a `SubmissionEvent` and an audit row
(ids and kinds). Talent pools hold consented candidates only (the membership
cites the disclosure and goes with its revocation). Reporting: funnel
(first event INTO a stage), medians in days to shortlist / interview / hire,
submissions and hires by source, moves by actor - the organisation's own
events, no identity, no cross-organisation number.

## 5. Surfaces - `PASS` (compile, lint; not exercised in a browser)

Pages `/dashboard/employer` (requisitions, the 90-day funnel, pools, the
admin's roster), `/dashboard/employer/[reqId]` (pipeline, sourcing cards,
disclosure requests), `/dashboard/employer/submissions/[id]` (stage moves,
interviews, notes, offers, the disclosed profile with "this read was
recorded"); the navigation entry only for a member of an employer
organisation; the candidate's disclosure requests under Settings (grant ·
decline · revoke; the wording marked as a draft pending legal review); the
job page's "Apply through JobPilot" panel for a first-party posting (the
external apply link is not shown for one); `/dashboard/jobs/by-requisition/[id]`
resolves a posting's apply link to its job page. Routes under
`/api/employer/*` through one gate (`employerRequest`) and the candidate's
under `/api/disclosures/*`.

## 6. Tests - `PASS`

`tests/employer-static.test.ts` (10: machine, roles, the draft consent
refused in production, static boundaries), `tests/connectors.test.ts` (the
employer connector through the contract suite over an in-memory catalogue,
plus discoverability and closure), `tests/employer.test.ts` (8, database:
roles; draft → published → re-published → filled/closed; sourcing with the
three visibilities; disclosure request → candidate's read-only row → grant
with one consent record → profile for that employer only; apply through
the platform; pools; revocation cascade; declined is final; the pipeline to
a hire with every role refusal; reporting; isolation from another employer
and from the candidates; audit trail without identity). `TEST_STRATEGY.md`
Stage 18 lists each assertion. Root suite: 1179 / 1179 (0 skipped).

## 7. What is NOT done, and why

- **Production disclosure is BLOCKED on L-5** (decision 7 of ADR-0033):
  refused by code until counsel records the wording and the version is
  made final.
- **No notification is sent** (no mail provider is wired): a request
  appears under the candidate's Settings; the recruiter tells nobody.
- **No sub-team, employer contact directory, collaboration thread or
  calendar**: notes on a submission are the collaboration; an interview is
  a recorded time.
- **Reporting's "own" cut for a hiring manager** is not built (organisation-
  level for every role but interviewer); no cross-organisation benchmark.
- **The UI is compiled and linted, not driven** - route-level status codes
  are not tested.
- **Sourcing scores at request time** over at most 200 visible candidates
  (`SOURCING_CAP`), with no stored ranking - adequate for a pilot, not for
  a large candidate base (a later stage's mart).

## 8. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 7 warnings (baseline ceiling 8) |
| Typecheck | 0 |
| Tests | **1179 / 1179**, 0 skipped (Stage 17: 1152) - 27 new subtests: `employer-static` 10, `employer` 8, the employer connector through the contract suite |
| Build | passes; `/dashboard/employer`, `/dashboard/employer/[reqId]`, `/dashboard/employer/submissions/[id]`, `/api/employer/*`, `/api/disclosures/*` present |
| Migrations | **forty-six** (two new, additive; RLS generated); fresh-database rehearsal: 46 applied, `migrate diff` clean, **146** forced-RLS tables in `public` |

## 9. Exit gate - verdict

| Exit criterion | Verdict |
| --- | --- |
| Requisition → hire flow complete | **PASS** - draft, publish, source, ask, consent, screen, interview, note, offer, hire, fill, close; tested end to end |
| Consent enforced on every employer-visible disclosure | **PASS** - one question (`grantedDisclosure`) on every read and every disclosed stage; tested (before, after, revoked, another employer) |
| Recruiter visibility honoured | **PASS** - hidden never sourced nor askable; anonymous without identity; visible with name and headline; tested |
| Sensitive attributes never employer-visible | **PASS** - nothing under `src/lib/employer` touches the sensitive path (static test); the Stage 02 allowlist unchanged |
| Cross-employer isolation | **PASS** - RLS `org` policies and the service's organisation filter; tested |
| Production disclosure | **BLOCKED (LEGAL, L-5)** - refused by code until the wording is recorded |

**Stage 18: PASS on engineering; production disclosure BLOCKED on L-5.**
Merge posture inherited from the stack.

## 10. What a founder or operator has to do

1. Counsel records the employer-disclosure consent wording in
   `COMPLIANCE_REGISTER.md` (L-5); then set `CONSENT_VERSIONS.employer_disclosure`
   to a final version and update the Settings text.
2. Employer organisations are self-serve (the matrix allows it); the
   `employer` source can be disabled at `/console/sources` to halt every
   publication.

## 11. Independent review

__REVIEW__

# Stage 18 - Corporate / talent acquisition OS - evidence

Recorded 2026-09-05 on branch `claude/stage-18-talent-acquisition`
(PR #30), stacked on Stage 17 (PR #29) - 16 (#28) - 15 (#27) - 14 (#26) -
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

`Organization.type = employer` - created by staff once verified (self-serve
creation is refused, as for a service provider; review H1); `Membership.serviceRole` names `recruiter` ·
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
published job with `scoreCompatibility` in DETERMINISTIC mode (Stage 08
engine and active weights; no `AiRun` under the candidate, no model - review
M11), rate-limited per requisition, returned
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
- **Sourcing scores at request time** over at most 100 visible candidates
  (`SOURCING_CAP`, the most recently updated preferences), with no stored
  ranking - adequate for a pilot, not for a large candidate base (a later
  stage's mart).
- **No retention purge** exists for hiring-team notes, interview feedback
  and offers after a revocation; they remain the employer's record and the
  candidate is told so (Stage 20).
- **The employer's "own" reporting cut and a hiring-manager scope on
  sourcing** are not built.

## 8. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 7 warnings (baseline ceiling 8) |
| Typecheck | 0 |
| Tests | **1179 / 1179**, 0 skipped (Stage 17: 1152) - 27 new subtests: `employer-static` 10, `employer` 8, the employer connector through the contract suite |
| Build | passes; `/dashboard/employer`, `/dashboard/employer/[reqId]`, `/dashboard/employer/submissions/[id]`, `/api/employer/*`, `/api/disclosures/*` present |
| Migrations | **forty-seven** (two additive, RLS generated; one data migration resetting the recruiter-visibility choice after the review); fresh-database rehearsal: 47 applied, `migrate diff` clean, **146** forced-RLS tables in `public` |

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
2. Create each verified employer organisation as staff
   (`createOrganization(..., { verifiedOrganization: true })` behind the
   console gate; self-serve creation is refused). The `employer` source can
   be disabled at `/console/sources` to halt every publication.

## 11. Independent review

An independent adversarial review of the Stage 18 diff (a separate agent
with the whole tree, asked to break the disclosure boundary, recruiter
visibility, cross-employer isolation, the stage machine, the roles, the
connector, the draft-consent refusal, atomicity and the docs) returned
2 HIGH, 10 MEDIUM and 11 LOW findings. Every HIGH and MEDIUM is fixed on
the branch; every LOW is fixed or recorded here. Nothing was suppressed.

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| H1 | HIGH | Any signed-in user could create an "employer" organisation under any company name, publish postings into every candidate's feed and harvest identities through "Apply through JobPilot". | Fixed: `createOrganization` refuses `employer` (as `service_provider`) without the staff verification flag the console's two-lock gate supplies; tested; the evidence no longer calls employer organisations self-serve. |
| H2 | HIGH | `requestDisclosure` upserted the submission to `consent_requested` unconditionally, resurrecting hired, rejected or withdrawn rows with a fabricated event. | Fixed: a new row is created; an existing `sourced` row moves; any other row only learns its disclosure id; tested (a withdrawn row stays withdrawn after a re-request naming the requisition). |
| M3 | MEDIUM | Interviewers and viewers could read every disclosed candidate's profile, every submission with its offers, and the pools. | Fixed: `readDisclosedCandidate` requires admin, recruiter or hiring manager, or an interviewer NAMED on an interview for that candidate; `loadSubmission` refuses an interviewer not named and omits offers for interviewer and viewer; `listPools` requires sourcing rights; tested. |
| M4 | MEDIUM | The recruiter-visibility preference was recorded under "No recruiter features exist yet", so no `visible` choice was consent to what Stage 18 does with it. | Fixed: the help text states exactly what each value exposes; migration `20260905180200_recruiter_visibility_reconfirm` resets every existing choice to `hidden`. |
| M5 | MEDIUM | The job page showed the employer's pipeline stage to the candidate (including for rows a recruiter made), claimed they applied when they had not, and `applyThroughPlatform` refused a candidate a recruiter had added or rejected. | Fixed: only the candidate's OWN application (`source: applied`) is shown, reduced to "received" or "withdrawn"; a recruiter-made row never blocks an application; tested. |
| M6 | MEDIUM | A `sourced` submission was stuck once the candidate granted disclosure by another route. | Fixed: a grant moves every `sourced` and `consent_requested` row of that employer to `consented`; `addSubmission` promotes an existing `sourced` row when a disclosure exists; tested. |
| M7 | MEDIUM | Closing a requisition closed a canonical `Job` whose primary source might be another one. | Fixed: the job is closed only when its primary source is `employer` and its external id is this requisition; otherwise freshness decides; tested. |
| M8 | MEDIUM | Audit rows were written strictly from inside the tenant transaction (a rolled-back move left a row; a failed write could undo a committed one). | Fixed: employer audit rows are BUFFERED on the actor and written by `employerDone` after the operation and its transaction complete (Stage 10's pattern); every employer route uses it. |
| M9 | MEDIUM | `setRequisitionStatus` wrote on the system client with no status precondition (a race could leave a closed requisition with a live posting). | Fixed: the status write is on the tenant path with the read status as precondition (`updateMany`, 409 on zero rows); tested. |
| M10 | MEDIUM | `grantedDisclosure` checked only that the consent record was unrevoked, not whose or for what. | Fixed: the record must belong to the candidate and carry the `employer_disclosure` purpose; tested (a terms-of-service record grants nothing). |
| M11 | MEDIUM | Sourcing wrote up to 100 `AiRun` rows per click under each candidate's identity, unbounded, and would route their résumés to a model on an employer's behalf. | Fixed: `scoreCompatibility({ mode: 'deterministic' })` - a new gateway seam that runs the engine alone with nothing recorded - and a per-requisition rate limit; the static test asserts the mode. |
| M12 | MEDIUM | Reporting's recruiter activity listed candidate user ids as actors. | Fixed: actors are restricted to organisation members; tested. |
| L13 | LOW | `SOURCING_CAP` was documented as 200 (it is 100). | Fixed in the evidence. |
| L14 | LOW | `STAGE_STATUS.md` carried two Stage 18 rows. | Fixed. |
| L15 | LOW | Concurrent grants could write two consent records. | Fixed: the status is the precondition inside the transaction. |
| L16 | LOW | An offer could never be decided after a revocation. | Fixed: an extended offer on a withdrawn submission closes as withdrawn without a move. |
| L17 | LOW | Unparsable reporting dates were a 500. | Fixed: 422. |
| L18 | LOW | The connector reported an id it does not hold as `unknown` and discovered suspended organisations' postings. | Partly fixed: only active organisations' requisitions are discoverable (tested). `unknown` for an id not held is KEPT: the connector contract requires that silence never infer closure (Stage 06), and the suite asserts it; a requisition deleted with its organisation leaves a posting freshness marks unconfirmed. Closing before deleting is the operator's step. |
| L19 | LOW | Notes, feedback and offers remain after a revocation while the Settings text implied otherwise. | Recorded in ADR-0033 and §7; no purge exists yet (Stage 20). |
| L20 | LOW | Re-asking immediately after every revocation; inviting the candidate as a member by id as a nag vector. | Recorded in ADR-0033 (re-ask after a revocation is allowed by design); the membership path leaks nothing and is left as is. |
| L21 | LOW | `Submission.matchScore` and its siblings were never written but returned as null. | Fixed: not returned; the columns stay for a later stored ranking. |
| L22 | LOW | Undocumented system-client reads and a header claiming every write is on the tenant path. | Fixed: commented (`grantedDisclosure`, the reporting members read, publication). |
| L23 | LOW | ADR-0033 said every move writes an audit row; candidate-driven moves do not. | Fixed in the ADR's wording (the employer's moves are audited; the candidate's are consent events). |

Test gaps the review named (role gating of the profile and the submission
for interviewer and viewer; a re-request against a terminal submission; a
sourced row after a grant by another route; closing a requisition whose job
has another primary source; the status precondition; a consent record of
another user or purpose; a recruiter-added candidate applying; a candidate
id among reporting actors; the connector's not-held answer) are covered by
`tests/employer.test.ts`, `tests/employer-static.test.ts` and
`tests/connectors.test.ts` now.

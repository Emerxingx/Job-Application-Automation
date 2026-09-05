# ADR-0033 - Employer hiring on the platform: requisitions as first-party postings, disclosure as the candidate's per-employer consent, a pipeline that cannot pass consent without it

**Status:** Accepted (Stage 18, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 18 (Product 2), gap G-17 · **Depends on:** ADR-0005 (RLS), ADR-0007 (nothing sensitive reaches an employer or a ranking), ADR-0008 (a source runs only through the connector gate), ADR-0022 (the compatibility pipeline), ADR-0032 (the consent and isolation pattern of Stage 17) · **Open:** L-5 (the consent WORDING a candidate reads)

## Context

Product 2 is the employer side: an organisation of type `employer` opens
requisitions, finds candidates, runs a pipeline to a hire, and reports on
it. The brief's non-negotiable is the candidate's: **no employer sees a
candidate who has not consented to that disclosure**, recruiter visibility
honours the candidate's Stage 02 preference (`hidden` · `anonymous` ·
`visible`), and sensitive attributes are never employer-visible (ADR-0007).
`ROLE_PERMISSION_MATRIX.md` gives an employer organisation five roles.
L-5 - the consent language for disclosure to an employer - is OPEN in
`COMPLIANCE_REGISTER.md`, "must be resolved by Stage 18, before any
candidate is disclosed to an employer".

Stage 17's review taught three things this stage starts from: a row a
party may SEE must be SELECT-only for them under RLS; consent is checked
by the record a relationship holds, never by purpose; and a declined
request is not re-sent by the platform.

## Decision

1. **An employer organisation is an `Organization` of type `employer`,
   created by staff once verified; the hiring roles are a named set over
   the ladder** (the Stage 18 review's first finding: a self-created
   "employer" could publish postings under any company name into every
   candidate's feed and harvest identities through "Apply through
   JobPilot"; `createOrganization` refuses `employer` and `service_provider`
   without the staff verification flag the console's two-lock gate
   supplies) (`Membership.serviceRole`:
   `recruiter` · `hiring_manager` · `interviewer` · `viewer`; owner/admin →
   `admin`; null or unknown → `viewer`). Recruiters and admins source and
   ask for disclosure; a hiring manager owns their requisitions and their
   offers; an interviewer writes their own interview's outcome and nothing
   else; a viewer reads. The matrix row is what `src/lib/employer/roles.ts`
   enforces and the static test asserts.
2. **A requisition is published as a first-party posting through the
   connector gate.** `Requisition` is a draft until opened; opening runs
   `requireEnabledSource('employer')` and the Stage 06 pipeline, so the
   posting is a canonical `Job` (`source: employer`, `externalId` the
   requisition id, a `JobSnapshot` per capture) that every candidate's agent
   matches like any other. The `employer` source is enabled by default: the
   rows are the employers' own, authored under the platform's terms, so the
   register record is complete by construction (SOURCE_ACCESS_POLICY.md).
   Closure is what the requisition's status SAYS - filled or closed closes
   the job at once, on hold marks it unknown - never inferred. Publication
   runs on the system client: the pipeline is system-only and must see the
   committed row, so a requisition write that publishes is not made inside
   the tenant transaction (the read and every check are).
3. **Disclosure is the candidate's, per employer, and nothing employer-
   visible exists without it.** `Disclosure` is one row per (organisation,
   candidate). A recruiter may ASK only a candidate whose visibility is
   `anonymous` or `visible` (`hidden` cannot be asked; the refusal says no
   more than "not open to recruiters"); the candidate answers under
   Settings - granting writes a `ConsentRecord` (`employer_disclosure`) in
   ONE transaction with the grant and moves the employer's waiting
   submissions to `consented`; declining is final for that employer;
   revoking revokes THAT consent record, withdraws every disclosed
   submission and removes every pool membership. Applying to an
   employer's posting on the platform is the candidate's own grant. Every
   employer-visible read asks one question - `grantedDisclosure()`: the
   row is `granted` AND its own consent record is unrevoked - and the
   identity and the profile reach the employer only through
   `candidate-view.ts`, behind that check and an audit row
   (`employer.candidate.read`). Under RLS the candidate may SELECT their
   own `Disclosure` row and nothing more (`custom` + `readUsing`); the
   pipeline tables are `org`-scoped and the candidate sees none of them.
4. **Sourcing is anonymised and scored by the compatibility pipeline in
   deterministic mode.** `sourceCandidates` takes the candidates who chose
   to be seen, scores each against the requisition's published job with
   `scoreCompatibility({ mode: 'deterministic' })` - the Stage 08 engine and
   the active weights, with NO `AiRun` written under the candidate's
   identity and no model, because this scoring is on the employer's behalf
   and the candidate consented to being seen, not to a purpose of the
   employer's - rate-limited per requisition, and returns cards: fit, matched and
   missing keywords, region (country only for `anonymous`), and a name and
   headline ONLY for `visible`. A hidden candidate is never in the set; an
   erased or not-yet-onboarded account is not; the run is audited
   (`employer.sourcing.run`) with counts. No sensitive attribute is read
   anywhere under `src/lib/employer` (static test).
5. **The pipeline is a stage machine that cannot pass consent without a
   disclosure.** `stage-machine.ts`: sourced → consent_requested →
   consented → screening → interviewing → offered → hired, with rejected
   and withdrawn terminal and no backward move; `consented` and
   `consent_requested` are the candidate's stages (an employer cannot move
   into them); every stage at or past `consented` refuses without a
   granted disclosure. Interviews and offers require it too. Every move
   writes a `SubmissionEvent`; the employer's moves also write an audit row
   with ids and kinds only (a candidate's application, grant or revocation
   is a consent event, audited as such).
6. **Reporting is the organisation's own pipeline events.** Funnel counts
   (first event INTO a stage), medians in days to shortlist / interview /
   hire from the submission's creation, submissions and hires by source,
   moves by actor. No candidate identity; no cross-organisation number.
7. **The consent wording is a draft, and production refuses it.**
   `CONSENT_VERSIONS.employer_disclosure` is `2026-09-05-draft`;
   `grantConsent` refuses any `-draft` purpose when `NODE_ENV` is
   `production` (`ConsentWordingPendingError`, 503). The MECHANISM is
   complete and tested; **no candidate is disclosed to an employer in
   production until counsel records the wording (L-5) and the version
   becomes final** - the register's rule, in code rather than in a note.

## Consequences

- A recruiter runs a requisition to a hire on the platform with the
  candidate in control at every point: what they see before consent is a
  score and a region; what they see after is what the candidate agreed to
  show that one employer; what they never see is a self-identification
  answer or another employer's consent.
- **The employer product cannot disclose anyone in production until L-5
  is recorded** (decision 7). That is the exit gate's BLOCKED item, and it
  is the founder's and counsel's, not engineering's.
- A candidate who declined an employer's request cannot be asked by that
  employer again; they can still apply to its postings themselves. After a
  REVOCATION the employer may ask again (the candidate may have changed
  their mind), and a terminal submission (hired, rejected, withdrawn) is
  never moved by a new request.
- What the employer wrote about a candidate - hiring-team notes, interview
  feedback, an offer's terms - stays the employer's record after a
  revocation; only the candidate's identity and profile become
  unreadable. The Settings text says so. No retention purge exists for
  these rows yet (DATA_RETENTION_MATRIX.md names three years; Stage 20).
- The recruiter-visibility help text now states what each value exposes;
  every preference recorded under the earlier text ("no recruiter features
  exist yet") was reset to `hidden` by migration, and the person chooses
  again.
- The candidate's job page shows only that their OWN application was
  received or withdrawn - never the employer's pipeline stage. The
  employer communicates decisions; the platform does not.
- No email, notification or message is sent to anyone: a request appears
  under the candidate's Settings. Notifications are a later stage.
- No sub-team ("TA team"), employer contact directory or collaboration
  thread exists beyond notes on a submission; the matrix's "Members &
  roles" is the roster and the service roles.
- Interview scheduling records a time; it does not touch a calendar
  (Stage 11's connectors are the candidate's, read by reference).

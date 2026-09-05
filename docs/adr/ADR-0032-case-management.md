# ADR-0032 - Case management for employment service providers at Level 0: consent-gated cases, organisation-isolated RESTRICTED notes with every access audited, a copilot that only recommends, and retention per organisation

**Status:** Accepted (Stage 17, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 17 (Product 3), gap G-19, ADR-0020 Level 0 · **Depends on:** ADR-0005 (RLS), ADR-0007 (nothing RESTRICTED reaches a recommendation path), ADR-0015 (per-organisation retention), ADR-0020 (the WorkBC integration boundary), ADR-0030 (entitlements), ADR-0031 (licensed offerings for referrals)

## Context

Product 3 is a companion for the case managers of employment service
providers, WorkBC contractors among them. ADR-0020 fixed the boundary: the
platform is fully useful with NO integration (Level 0), and no screen,
mock or claim may present a WorkBC connection that does not exist. The
positive audit finding stands - nothing in this repository fabricates one.
`DATA_CLASSIFICATION.md` makes case notes, assessments and barriers
RESTRICTED: organisation-scoped, every access audited, never in an AI or a
matching path, retention as short as the programme allows.
`ROLE_PERMISSION_MATRIX.md` gives a service provider four roles and makes a
case manager's access assignment-gated. L-1 (which privacy regime applies
when the platform serves a public body) is OPEN and is not answered here.

The candidate whose case it is remains a candidate on this platform, with
their own tenancy. A case manager's tenant context cannot see the client's
rows, by design, and must not be able to until the client says so.

## Decision

1. **A service-provider organisation is an `Organization` of type
   `service_provider`; the case roles are a named set over the ladder**
   (ADR-0005 stays: three rungs). `Membership.serviceRole` names
   `supervisor` · `case_manager` · `viewer`; an owner or admin of the
   organisation is `admin`. Null or an unrecognised value is `viewer`, the
   weakest. A case manager opens and writes only cases assigned to them; a
   supervisor reads every case and writes none; a viewer sees counts; an
   admin does everything and sets roles and the retention policy.
2. **A case exists only with the client's recorded consent.** A supervisor
   or admin invites a client by the email the client gave them (the lookup
   is audited, `case.invited`, and is answerable for). The case is
   `invited` and holds nothing about the person. The CLIENT accepts under
   Settings: a `ConsentRecord` (`employment_services_case`, versioned,
   source `settings`) is written and the case opens; declining closes the
   door; withdrawing later closes the case and revokes that consent, and
   nothing about the client is read from then on. Before consent and
   after withdrawal every read about the client is refused (403) and the
   copilot does not run.
3. **Isolation is RLS first, then the service.** `CaseNote`,
   `CaseAssessment`, `CaseTask`, `CaseOutcome`, `CaseFollowUp` and
   `CaseRecommendation` are `org`-scoped: the organisation's accepted
   members and nobody else - not the client, not another provider. `Case`
   itself is visible to the organisation's members AND to the client it
   concerns (the invitation and the consent state; the client can write
   nothing on the tenant path). The `RetentionPolicy` is read by members
   and written by the service. Assignment gating and role checks are the
   service's, on top of the policy; a case a role may not open is 404.
4. **Case notes and assessments are RESTRICTED and every access is
   audited FIRST.** The audit row is written strictly on the system client
   before the read or the write (the tenant role cannot write `AuditLog`;
   an access whose record cannot be written does not happen), with ids and
   kinds - a note's length, an assessment's barrier count - never a body,
   a barrier or a name. `caseNote`, `assessment` and `barriers` join the
   AI gateway's RESTRICTED keys; a static test refuses any reference to a
   case note or assessment under matching, eligibility, analytics, career
   or the gateway, and in the copilot and the client view.
5. **What a case manager sees of the client is a DELEGATED, audited read.**
   `client-view.ts` runs on the system client only after four checks
   (member of the case's organisation, a role that may open the case, the
   case open, the consent current) and an audit row (`case.client.read`).
   It reads application counts and statuses, interviews, eligibility rule
   outcomes, compatibility dimensions, whether a résumé exists, the
   client's target titles and locations, and this deployment's postings
   for the target occupation. It never reads the sensitive schema.
6. **The copilot recommends and decides nothing.** `copilot.ts` is pure: a
   deterministic reading of those signals against fixed thresholds
   (`COPILOT_VERSION`) into patterns - poor response rate, seniority above
   the profile, missing qualifications, geographic constraints, résumé
   problems, weak demand held here, certification gaps, inactivity, no
   target - each with the numbers that triggered it and a suggested action
   in words. `runCopilot` writes `CaseRecommendation` rows and nothing
   else (a test snapshots the client's and the case's other tables): an
   open recommendation is refreshed, a vanished pattern superseded. The
   case manager accepts or dismisses each one; accepting creates an
   action-plan task only when they ask for one, citing the
   recommendation. No AI provider is called (the deterministic engine is
   the design, not a fallback).
7. **The action plan and outcomes are the case manager's record.** Tasks,
   interventions and training referrals (a referral names a licensed
   Stage 16 offering, checked with `isServable`); an employment outcome
   (`employed` · `self_employed` · `training` · `not_employed` · `other`)
   with retention follow-ups at 4, 12 and 24 weeks for an outcome that
   can be retained. These are a plausible programme shape, not a WorkBC
   schema (ADR-0020 rule 5): a Level 1 export is a mapping exercise.
8. **Retention is per organisation, and NO policy means NO automatic
   purge.** `RetentionPolicy` holds `caseNoteDays` and `closedCaseDays`
   (30-3650), set by an admin and audited. `npm run cases:retention`
   deletes notes and assessments older than the first and closed cases
   (with everything under them) closed longer ago than the second, per
   organisation, audited with counts; an organisation without a policy is
   untouched, because a public-body contract may require records kept and
   nothing is destroyed on a platform default. No scheduler exists.

## Consequences

- A case manager runs a caseload end to end at Level 0: invitation,
  consent, assessment, plan, referrals, notes, outcomes, follow-up, with a
  copilot that surfaces patterns and a trail of who read what and when.
- The WorkBC integration level is 0 and every page says so. Advancing a
  level needs a written agreement recorded in `COMPLIANCE_REGISTER.md`
  (ADR-0020), never a code change alone.
- **Deploying this product to a public-sector customer stays BLOCKED on
  L-1** (and L-3 for any AI use, which this stage does not add). The
  engineering is complete; the regime, the residency and the retention
  rules a public body requires are the founder's and counsel's to settle,
  after which they are configuration (ADR-0015), not redesign.
- Inviting by email discloses to a supervisor whether an address has an
  account. This is accepted for a provider working with clients in person
  and is audited; a client-initiated code is the alternative if a future
  review requires it.
- The viewer role sees counts, not names; small-cohort suppression for
  aggregate reporting across organisations is Stage 20 work and is not
  claimed here.

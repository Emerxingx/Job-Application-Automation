# Stage 19 - Staffing / placement OS - evidence

Recorded 2026-09-05 on branch `claude/stage-19-staffing-placement`
(PR #31), stacked on Stage 18 (PR #30) - 17 (#29) - 16 (#28) - 15 (#27) -
14 (#26) - 13 (#25) - 12 (#24) - 11 (#23) - 10 (#22) - 09 (#21) - 08 (#20) -
07 (#19) - 06 (#18) - 05 (#17) - 04 (#16) - 03 (#15) - 02 (#14) - 01 (#13,
PARTIAL). Every line was run or read; nothing is PASS on the strength of a
mock, a skipped test or a document. This stage's honest centre: **an agency
runs an engagement to an invoiced placement with the client as the only
payer - a placement invoice has no candidate on it and touches nothing of
the candidate's billing, proven - the candidate deciding whether they are
represented, and the jurisdiction's rules as counsel recorded them:
nothing about any jurisdiction is asserted by code, and no invoice is
issued under a jurisdiction whose rules are unrecorded (L-4).**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 19: client contracts, recruitment engagements,
fee structures, placement fees, guarantee periods, recruiter ownership,
candidate representation consent, placements, invoicing, compliance;
employer-paid placement and candidate-paid consulting distinct and never
sharing a billing path; jurisdictional rules as configuration, never
hardcoded Canadian globals. Security: representation consent explicit,
revocable, audited; fee data CONFIDENTIAL. Testing: jurisdiction-rule tests
(BC vs other provinces vs US states); a test asserting the two flows cannot
cross. Acceptance: an agency runs an engagement to invoiced placement; no
candidate is ever charged on an employer-paid engagement. Exit gate:
placement lifecycle complete and jurisdiction-aware.

## 2. Organisations, roles, contracts and fees - `PASS`

`Organization.type = staffing_agency`; `Membership.serviceRole` names
`recruiter` · `delivery` · `finance` · `viewer` (owner/admin → admin;
unknown → viewer, who sees nothing commercial). `src/lib/staffing/roles.ts`
enforces the matrix row (tested): admin writes contracts and fees; a
recruiter owns engagements and placements and asks for representation;
delivery writes engagements and placements and sees no fee; finance reads
fees and owns invoicing and never asks for representation. `ClientContract`
carries the client, its jurisdiction and the agency's STATED licence
reference; `FeeStructure` is contingency or retained (basis points) or
flat, with a guarantee period, and `paidBy` is always `client` - a
structure naming any other payer is refused before a row exists (tested).
Migration `20260905190000_staffing` (seven tables), RLS generated in
`20260905190100_rls_staffing`; the `PL` series added to the numbering book.

## 3. Separation - `PASS` (proven two ways)

Static (`tests/staffing-static.test.ts`): nothing under `src/lib/staffing`
imports the subscription, entitlement, invoice, dunning, tax, profile,
webhook or payment modules, nor names `invoice`, `payment`, `subscription`,
`entitlement`, `creditNote`, `refund` or `billingProfile` as a Prisma
delegate; nothing under `src/lib/billing`, `src/lib/entitlements` or the
payment providers names a staffing table; the `PlacementInvoice` model
carries no user id and no relation to `Invoice` or `Payment`; a
`FeeStructure` carries `paidBy` defaulting to `client`. Database
(`tests/staffing.test.ts`): the candidate's counts of invoices, payments,
subscriptions and entitlements are identical before and after a placement,
an issued invoice, a guarantee credit and a revocation; the placement
invoice's number matches no `Invoice` row. The numbering book
(`DocumentSequence`) is shared infrastructure - a counter with its own
scope and series, system-only under RLS - not a billing path.

## 4. Jurisdiction rules as data - `PASS` (engine) · `BLOCKED (LEGAL, L-4)` for invoicing

`StaffingJurisdictionRule` rows are seeded for CA, CA-BC, CA-AB, CA-ON,
CA-QC, US, US-CA, US-NY, US-TX and US-WA with NAMES ONLY (a test asserts
the seed carries no rule value); `/console/staffing` (admin) records
counsel's answer - status recorded · prohibited · unrecorded, licence
required, candidate fees prohibited, longest guarantee, the citation, a
reason - audited (`staffing.jurisdiction.recorded`). `jurisdiction.ts` is
pure: the most specific row wins (`CA-BC` before `CA`; a region with no row
falls back to its country); four checks each `pass` · `fail` · `unknown`
with a reason; `unconfirmed` when anything is unknown, `blocked` on any
fail, `allowed` only when every check passes. Tested with BC (licence
required, 120-day limit), Ontario (no licence, no limit) and Washington
(recorded with two answers blank → unconfirmed) as FIXTURE rows - what
they state is the test's, not the code's. The platform rule holds
everywhere: a fee not paid by the client fails, recorded or not. A
placement records the evaluation it was made under; a `blocked` verdict
refuses it; **`issuePlacementInvoice` refuses unless the verdict is
`allowed`** (tested: refused under unrecorded CA-BC, issued once the
fixture rule is recorded, a prohibited CA-ON blocks a new placement).

## 5. Representation and placements - `PASS` (mechanism) · `BLOCKED (LEGAL, L-5)` in production

`RepresentationConsent` is addressed to an email (accounts table never
consulted; digest in the audit row; the same answer with or without an
account - tested); the person sees it under Settings when their account
address matches, grants it in ONE transaction with a `ConsentRecord`
(`agency_representation`; linked, name snapshotted), declines (final for
that engagement; nothing recorded about them), or revokes (record revoked;
no new placement cites it; the placement made stands). Under RLS the
candidate may SELECT their own row and nothing more (tested: update
refused, delete removes nothing). A placement freezes the fee from the
structure (20% of 90,000.00 = 18,000.00, tested), the guarantee end, and
the recruiter (the engagement's owner); a consent for another engagement
is not this one's (tested). **`CONSENT_VERSIONS.agency_representation` is
`2026-09-05-draft`; `grantConsent` refuses a `-draft` purpose in
production** (the Stage 18 rule; asserted by that stage's test).

## 6. Invoicing, guarantee and productivity - `PASS`

Finance or admin issues the client's invoice for a started or completed
placement under an `allowed` jurisdiction and an active contract:
`PL-YYYY-NNNNNN` from the book inside the same system-client transaction
as the row, the frozen fee as the amount, due in 30 days; paid · void
(with a named reason; never a credited one) · guarantee credit (a fall-off
inside the guarantee, named and dated, credits the full amount once).
Productivity per recruiter: engagements owned, representations requested
and granted, placements, fall-offs inside guarantee, fee totals for admin
and finance (delivery sees none; a recruiter their own row); no candidate
or client identity anywhere, nor in any `staffing.*` audit row (tested).

## 7. Surfaces - `PASS` (compile, lint; not exercised in a browser)

`/dashboard/staffing` (contracts, fee structures, engagements, placement
invoices as the role may see them), `/dashboard/staffing/[engagementId]`
(the jurisdiction evaluation with every check's reason, representation
requests, placements, invoices, the guarantee credit); the navigation entry
only for a member of a staffing agency; the candidate's representation
requests under Settings (the wording marked as a draft pending legal
review); `/console/staffing` (admin: the rules per jurisdiction). Routes
under `/api/staffing/*` (one gate), `/api/representations/*` and
`/api/console/staffing/jurisdictions`.

## 8. Tests - `PASS`

`tests/staffing-static.test.ts` (17: the engine including the review's
precedence cases, fees, roles including the unowned-engagement statement, the
draft consent and the PL book, the static separation by any delegate method
or raw SQL, the verified type, the rate limits, step-up, the lock order) and
`tests/staffing.test.ts` (7, database: roles; contracts and fees with the payer refusal;
engagements with ownership and an active-contract precondition;
representation end to end with the candidate's read-only row; a placement
with a frozen fee, stored evaluation, no invoice under unrecorded rules and
unchanged candidate billing; counsel's answer recorded and evaluated, the
PL invoice, another agency's isolation, a prohibited jurisdiction; the
guarantee credit, revocation, productivity and the audit trail without
identity; after the review: the verified-type refusal, the audited role
assignment, delivery's verdict equal to finance's, currency and recruiter
validation, `cancelled` versus `fell_off` with date bounds, two issuers
racing to one invoice, an unknown jurisdiction code refused, a revoked
consent never re-requested, a placed account not hard-deletable).
`TEST_STRATEGY.md` Stage 19 lists each assertion. Root suite: 1205 / 1205
(0 skipped).

## 9. What is NOT done, and why

- **Invoicing is BLOCKED in every jurisdiction until counsel records its
  rules (L-4)**; representation is **BLOCKED in production until the
  consent wording is recorded (L-5)**. Both enforced by code.
- **No notification is sent**; a request appears under Settings.
- **No client portal**: the client is a contract row; no approval,
  timesheet or client login exists.
- **Placement invoices are paid, void or credited** - no PDF, tax, currency
  conversion, partial payment, interest or dunning.
- **The employer product and the agency product do not exchange
  candidates**; a placed candidate's Stage 10 folder is not updated.
- **Erasure of a represented candidate cascades through the agency's
  placement rows** (their rows under RLS) - noted for Stage 20's erasure
  review.
- **The UI is compiled and linted, not driven**; route-level status codes
  are not tested.

## 10. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 7 warnings (baseline ceiling 8) |
| Typecheck | 0 |
| Tests | **1199 / 1199**, 0 skipped (Stage 18: 1179) - new: `staffing-static` 12, `staffing` 7 |
| Build | passes; `/dashboard/staffing`, `/dashboard/staffing/[engagementId]`, `/console/staffing`, `/api/staffing/*`, `/api/representations/*` present |
| Migrations | **forty-nine** (two new, additive; RLS generated); fresh-database rehearsal: 49 applied, `migrate diff` clean, **153** forced-RLS tables in `public` |

## 11. Exit gate - verdict

| Exit criterion | Verdict |
| --- | --- |
| Placement lifecycle complete | **PASS** - contract, fee, engagement, representation, placement, invoice, guarantee credit, productivity; tested end to end |
| Jurisdiction-aware | **PASS** on engineering - rules as recorded data, evaluated purely with reasons; **BLOCKED (LEGAL, L-4)** for any invoice until counsel records a jurisdiction |
| Candidate-paid and employer-paid flows cannot cross | **PASS** - static and database proofs |
| No candidate charged on an employer-paid engagement | **PASS** - no payer but the client can be described; the candidate's billing is untouched, tested |
| Representation consent explicit, revocable, audited | **PASS** (mechanism) - **BLOCKED (LEGAL, L-5)** in production |

**Stage 19: PASS on engineering; invoicing BLOCKED on L-4 and production
representation BLOCKED on L-5.** Merge posture inherited from the stack.

## 12. What a founder or operator has to do

1. Counsel records each target jurisdiction's rules at `/console/staffing`
   (L-4), citing the statute; until then no invoice is issued there.
2. Counsel records the representation consent wording (L-5); then set
   `CONSENT_VERSIONS.agency_representation` to a final version.
3. Staffing agencies are VERIFIED organisations: staff create one (as for
   employers and service providers) once it is verified, because an agency
   asks people by email to be represented. The review reversed the earlier
   self-serve reading (§13, H1).

## 13. Independent review

An adversarial review of the stage (2026-09-05) returned 3 HIGH, 9 MEDIUM
and 5 LOW findings. Every HIGH and MEDIUM and every LOW is fixed on the
branch, each with a test; the table names the fix.

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| H1 | HIGH | A self-serve agency could spray representation requests at any address: no rate limit, `staffing_agency` not a verified type, §12.3 wrong | `staffing_agency` in `VERIFIED_TYPES` (staff-created); `representationRequest` 30/hour per recruiter and 200/day per agency; §12.3 corrected; static test and a database refusal |
| H2 | HIGH | `resolveRule`: an `unrecorded` region row shadowed a `prohibited` / `recorded` country row, and a recorded country silently governed an unseeded region | Precedence is the most specific ANSWERED row; a prohibition at country level blocks every region; a country's recorded answer leaves a region `unconfirmed`; engine version `2026-09-05.2`; three new engine tests |
| H3 | HIGH | Double invoice across two transactions (check on the tenant path, write on the system client) | `pg_advisory_xact_lock` keyed by the placement inside the system transaction and the check repeated under it; a database test races two issuers and finds one invoice |
| M4 | MEDIUM | `currentRepresentation` checked neither purpose nor version | The consent record must be `agency_representation` at `CONSENT_VERSIONS.agency_representation`, unrevoked (static test) |
| M5 | MEDIUM | Re-requesting after a revoke reset a row a placement cites | A revoked (or declined) representation is final for the engagement; the row is never reset (database test) |
| M6 | MEDIUM | `recruiterId` unvalidated | Must be a recruiter or admin of the agency; a recruiter credits only themselves (database tests) |
| M7 | MEDIUM | Placement currency not reconciled with the fee structure | Denominated as the fee structure; a differing currency is refused (database test) |
| M8 | MEDIUM | `fellOffAt` unconstrained; `fell_off` reachable from `pending` | Only from `started`; on or after the start date and not in the future; `pending` → `cancelled` for a candidate who never started (database tests) |
| M9 | MEDIUM | Static separation regexes bypassable (relative imports, other delegate methods, raw SQL; `subscription.ts` not covered) | The test refuses relative imports leaving the module, any `.model.method(` access and raw SQL naming a table, in both directions; `src/lib/subscription.ts` included |
| M10 | MEDIUM | Recording counsel's answer (L-4) had no step-up | `governanceRoute` + `requireStepUp`; the console form asks for the password; static test |
| M11 | MEDIUM | The ADR's erasure claim was false and the FK cascade would have destroyed `PL` invoices | `Placement.candidateUserId` is `ON DELETE RESTRICT` (migration `20260905190200`); the ADR says what is and is not scrubbed; a database test proves the hard delete is refused |
| M12 | MEDIUM | Delivery's engagement view evaluated the jurisdiction with `guaranteeDays: 0` | The fee row is always read for the evaluation and returned only to roles that read fees; a database test compares delivery's verdict with finance's |
| L13 | LOW | Unowned engagements writable by every recruiter, unstated | Stated in `roles.ts`, the ADR and the matrix; a pure test pins it |
| L14 | LOW | `setStaffingRole` not audited | `staffing.role.set` with the member id and the from/to roles (database test) |
| L15 | LOW | An invalid productivity range was a 500 | 422 with a message |
| L16 | LOW | `recordJurisdictionRule` accepted unbounded new codes; `maxGuaranteeDays` could not be 0; the console GET upserted | Only seeded or existing codes; 0 allowed; the GET and the page read through `listJurisdictionRegistry` (no write) |
| L17 | LOW | `pending → fell_off` counted as a guarantee fall-off | Covered by M8: `cancelled` is not a guarantee event (database test on productivity) |

Root suite after the fixes: 1205 / 1205 with the database URLs set; lint
0 errors / 7 warnings; typecheck and build pass; the migration history
applies cleanly to an empty database with no drift.

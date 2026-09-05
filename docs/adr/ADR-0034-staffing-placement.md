# ADR-0034 - Staffing and placement: employer-paid placement as its own commercial object, representation as the candidate's consent, jurisdiction rules as recorded data

**Status:** Accepted (Stage 19, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 19, gap G-18 · **Depends on:** ADR-0005 (RLS), ADR-0010 / ADR-0030 (the candidate billing and entitlement layer this stage must never touch), ADR-0032 / ADR-0033 (the consent-by-invitation pattern), the Stage 15 numbering book · **Open:** L-4 (staffing licensing per jurisdiction), L-5 (the representation consent wording)

## Context

A staffing agency is paid by its CLIENT for placing a candidate. The
candidate on this platform may also pay for their own subscription. The
brief's warning is exact: employer-paid placement and candidate-paid
consulting are distinct commercial objects and must never share a billing
path; no candidate is ever charged on an employer-paid engagement. The
second requirement: Canadian recruiter and staffing rules are configuration,
never hardcoded globals - and L-4 (what licensing applies in BC and in each
target jurisdiction) is OPEN, so the code may not assert any of it.
`ROLE_PERMISSION_MATRIX.md` gives an agency five roles; fee data is
CONFIDENTIAL. Stages 17 and 18 settled how a person consents to an
organisation: invited by email, granted by the person in one transaction
with their consent record, SELECT-only for them under RLS, revocable.

## Decision

1. **A staffing agency is an `Organization` of type `staffing_agency`; the
   roles are a named set over the ladder** (`Membership.serviceRole`:
   `recruiter` · `delivery` · `finance` · `viewer`; owner/admin → `admin`;
   null or unknown → `viewer`, which sees nothing commercial). An admin
   writes contracts and fee structures; a recruiter OWNS engagements and
   placements (writes their own, reads the rest) and asks for
   representation; delivery writes engagements and placements and never
   sees a fee; finance reads fees and owns invoicing and never asks for
   representation (`src/lib/staffing/roles.ts`, the matrix row, asserted by
   a test).
2. **Placement is its own commercial object.** `ClientContract` (the client,
   its jurisdiction, the agency's STATED licence reference), `FeeStructure`
   (contingency or retained in basis points, or flat; a guarantee period;
   `paidBy` is always `client` - the service refuses anything else before a
   row exists), `Engagement` (contract + fee structure + owner recruiter),
   `Placement` (a represented candidate, the salary, the fee computed from
   the structure and FROZEN, the guarantee end, the stored jurisdiction
   evaluation), `PlacementInvoice` (the agency's invoice to its CLIENT).
   `PlacementInvoice` has no user id and no relation to `Invoice`, `Payment`,
   `Subscription` or `Entitlement`; nothing under `src/lib/staffing` imports
   the subscription, entitlement, invoice, dunning, tax or payment modules or
   names their tables, and nothing under those modules names a staffing
   table (static tests). Its numbers come from the shared numbering BOOK
   (`DocumentSequence`, scope `placement_invoice`, series `PL`, printed
   `PL-YYYY-NNNNNN`) - a counter, not a billing path - allocated in the same
   system-client transaction as the row (the book is system-only under RLS,
   as for every document). A database test proves a placement, an invoice, a
   credit and a revocation change nothing in the candidate's invoices,
   payments, subscriptions or entitlements.
3. **Jurisdiction rules are data; the engine is pure; an unknown is not a
   pass.** `StaffingJurisdictionRule` rows are seeded for the targeted
   jurisdictions with NAMES ONLY and every rule value null; counsel's answer
   (licence required, candidate fees prohibited, longest guarantee, the
   citation) is recorded by a staff admin at `/console/staffing` with a
   reason, audited (`staffing.jurisdiction.recorded`), and may be
   `prohibited`. `jurisdiction.ts` resolves the most specific row (`CA-BC`
   before `CA`) and evaluates four checks with `pass` · `fail` · `unknown`
   and a reason in words: `unconfirmed` when anything is unknown, `blocked`
   on any fail, `allowed` only when every check passes. One check is the
   platform's, everywhere: a fee not paid by the client FAILS. A placement
   may be recorded under an unconfirmed jurisdiction (the agency's own
   operational fact, marked as such) and never under a blocked one; **no
   invoice is issued unless the verdict is `allowed`** - money waits for
   counsel (L-4). The licence check reads what the agency STATED on the
   contract; the platform verifies nothing.
4. **Representation is the candidate's consent, per engagement.**
   `RepresentationConsent` is addressed to an EMAIL (the accounts table is
   never consulted; the audit row carries a digest); the person whose account
   address matches sees it under Settings and grants it in ONE transaction
   with a `ConsentRecord` (`agency_representation`), which links them and
   snapshots their name; declining is final for that engagement; revoking
   revokes THAT record, and no new placement can cite it - a placement
   already made stands as the agency's record. A placement asks one
   question: the representation is `granted`, for this engagement, and its
   own consent record is this person's, for this purpose, unrevoked. Under
   RLS the candidate may SELECT their own row and nothing more.
5. **The consent wording is a draft and production refuses it.**
   `CONSENT_VERSIONS.agency_representation` is `2026-09-05-draft`; the
   Stage 18 rule in `grantConsent` refuses any `-draft` purpose when
   `NODE_ENV` is `production`. The mechanism is complete and tested; no
   candidate is represented in production until counsel records the
   wording (L-5).
6. **A fall-off inside the guarantee is a credit on the client's invoice**,
   never a charge to anyone: `fell_off` with a named reason and a date, and
   finance records a `guarantee_fell_off` credit for the full amount on an
   issued or paid invoice. Replacement is a new placement.
7. **Recruiter productivity is the organisation's own rows**: engagements
   owned, representations requested and granted, placements, fall-offs
   inside guarantee, and fee totals for admin and finance (a recruiter sees
   their own row; delivery sees no fees). No candidate or client identity.

## Consequences

- An agency runs an engagement to an invoiced placement with the candidate
  in control of whether they are represented, the client as the only payer,
  and the jurisdiction's rules as counsel recorded them.
- **Invoicing is BLOCKED in every jurisdiction until L-4 is recorded**, and
  **representation is BLOCKED in production until L-5 is recorded**. Both
  are the founder's and counsel's, not engineering's; both are enforced by
  code, not by a note.
- No email or notification is sent: a request appears under the person's
  Settings; the recruiter tells them in person.
- The client is a contract row, not an organisation on the platform; no
  client-side login, portal or approval exists. The employer product (Stage
  18) and the agency product do not exchange candidates.
- Interest, tax, currency conversion, partial payments and dunning are not
  built for placement invoices (paid, void, credited only); a PDF rendering
  is not built.
- Placement records name the candidate by user id; a candidate's erasure
  cascades through `Placement` and `RepresentationConsent` (their rows),
  which removes the agency's record of them - accepted for now and noted for
  the erasure review in Stage 20.

# Entitlement Matrix

**Decision:** `../adr/ADR-0010-payment-entitlement.md`

**Entitlement ≠ payment.** Every feature check reads an entitlement. No feature
check reads `Subscription.status`. Entitlements are grantable without payment
(trial, comp, pilot, public-sector licence) and revocable without refund.

## B2C — Candidate

| Capability | Free | Starter | Professional | Executive |
| --- | --- | --- | --- | --- |
| Digital twin & evidence vault | ✓ | ✓ | ✓ | ✓ |
| Job search & recommendations | limited | ✓ | ✓ | ✓ |
| Eligibility check | ✓ | ✓ | ✓ | ✓ |
| Compatibility + full explanation | summary | ✓ | ✓ | ✓ |
| Applications / month | 5 | 30 | 100 | 300 |
| Tailored résumé + cover letter | 3/mo | ✓ | ✓ | ✓ |
| DOCX export | — | ✓ | ✓ | ✓ |
| Document version history | — | 90 days | ✓ | ✓ |
| Job Folder | ✓ | ✓ | ✓ | ✓ |
| Email & calendar intelligence (V1) | — | — | ✓ | ✓ |
| Interview preparation | — | 3/mo | ✓ | ✓ |
| Candidate analytics | basic | ✓ | ✓ | ✓ |
| Career transition analysis (V1) | — | — | 1/mo | ✓ |
| Learning recommendations (V1) | — | — | ✓ | ✓ |
| Priority support | — | — | — | ✓ |

Quota is reserved per batch and **unused quota is refunded** — a duplicate or
failed application never consumes an allowance. This existing behaviour is
preserved.

## B2B — Employer / Recruiter

| Capability | Team | Growth | Enterprise |
| --- | --- | --- | --- |
| Seats | 3 | 10 | unlimited |
| Active requisitions | 5 | 25 | unlimited |
| Candidate search | ✓ | ✓ | ✓ |
| Talent pools | 3 | 25 | unlimited |
| Pipeline & collaboration | ✓ | ✓ | ✓ |
| Interview scheduling | ✓ | ✓ | ✓ |
| Employer reporting | basic | ✓ | advanced |
| API access | — | ✓ | ✓ |
| Outbound webhooks | — | ✓ | ✓ |
| SSO (SAML/OIDC) | — | — | ✓ |
| SCIM provisioning | — | — | ✓ |
| Tenant residency & retention policy | — | — | ✓ |

## Staffing agency
Adds: client contracts, fee structures, representation consent, placements,
guarantee tracking, placement invoicing, recruiter productivity.
**Billed separately from candidate-paid services.** A candidate is never charged
on an employer-paid engagement — enforced by schema, not policy.

## B2B/B2G — Employment services (WorkBC)

| Capability | Standard | Enhanced |
| --- | --- | --- |
| Case managers | per seat | per seat |
| Caseload management | ✓ | ✓ |
| Assessments & employment plans | ✓ | ✓ |
| Case notes (RESTRICTED) | ✓ | ✓ |
| AI copilot (recommend-only) | — | ✓ |
| Outcome & retention reporting | ✓ | advanced |
| Programme export (Level 1) | ✓ | ✓ |
| Per-organisation retention policy | — | ✓ |
| Data residency controls | — | ✓ |

Typically invoiced rather than card-billed — which is precisely why entitlement
must be grantable independently of a Stripe charge.

## B2C/B2B — Career consulting & learning
Packaged services: transition analysis, learning plan, consultant sessions,
credential guidance. Purchasable by an individual or funded by an organisation;
the entitlement attaches to the **person** either way.

## Enforcement
1. One entitlement service answers "may this account do X". No feature reads a
   subscription row.
2. Every grant and revocation is audited with actor, reason and timestamp.
3. Quota exhaustion degrades gracefully and states what was reserved and refunded.
4. A lapsed payment moves to a **read-only** entitlement rather than deleting
   access — candidates must always retrieve what was sent on their behalf.

# Payment & Commercial Architecture

**Decision:** `../adr/ADR-0010-payment-entitlement.md`

## What exists (substantial — preserve)
Invoicing (1,385 lines), tax, dunning, credit notes, payment allocation, document
numbering, PDF invoice rendering, and a multi-gateway abstraction (Stripe, PayPal,
manual, mock), covered by a large share of the 670 passing tests.

Stripe: real Checkout sessions, prices mapped from configuration rather than
created on the fly, and a **signature-verified webhook treated as the authority
on subscription state** — never the browser redirect. That is the correct design.

## The structural gap
**Payment state and entitlement state are fused.** Feature access derives from
`Subscription` plus a monthly counter. There is no way to express a trial, a comp
account, a grandfathered price, a B2G licence paid by invoice, a partial refund
that does not revoke access, or a lapse that retains read-only access.

## Target model
```
customer → product → price → subscription → ENTITLEMENT → usage
                                    │
                              invoice → payment → credit/refund
```
- Payment state answers *did money move?*
- Entitlement state answers *what may this account do right now?*
- A successful payment **grants** an entitlement — a separate, dated, audited act.
- **Every feature check reads entitlements.** No feature check reads
  `Subscription.status`.

## Four commercial models
| Model | Buyer | Shape |
| --- | --- | --- |
| B2C | Candidate | Subscription + application quota |
| B2B | Employer / recruiter / staffing | Seats, pooled quota, services |
| B2B/B2G | Employment-service organisation | Licence, often invoiced, per-organisation terms |
| B2C/B2B | Career consulting / learning | Packages, one-off services |

`Organization` already carries `seats`, `applicationsPerMonthPooled` and
`perSeatCap` — wired in Stage 15.

## Hard separation
**Employer-paid placement fees and candidate-paid services must never share a
billing path.** Distinct products, distinct entitlements, distinct invoices. A
candidate must never be charged on an employer-paid engagement, and the schema
must make that impossible rather than merely unlikely (Stage 19).

## Non-negotiables
- **No card data is stored.** Stripe holds it.
- Webhook idempotency before any entitlement grant (Stage 01).
- Stripe Tax for tax determination; the existing tax engine handles
  jurisdictional registration and collection policy.
- **Stripe Connect only for a future marketplace** — not now.
- Prices live in the gateway dashboard and are mapped by configuration, so
  charged amounts remain auditable in one place. This existing decision is kept.

## Validation requirement
Stripe is `IMPLEMENTED-NOT-VALIDATED` and is **revenue-critical**. Stage 15
requires full test-mode E2E — checkout, webhook, replay, failure, dunning,
cancellation — before it may be described as anything more.

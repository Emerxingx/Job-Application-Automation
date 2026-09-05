# ADR-0010 — Separate payment state from entitlement state

**Status:** Accepted · **Date:** 2026-09-02 · **Implemented:** Stage 15, 2026-09-05, by ADR-0030 (`src/lib/entitlements/`, migration `20260905120000_entitlements`); Stripe remains IMPLEMENTED-NOT-VALIDATED (no test-mode key in the build environment), so the entitlement consequences of gateway events are proven against the functions the webhook calls, not against Stripe

## Context
The existing commercial layer is substantial and sound: invoicing (1,385 lines),
tax, dunning, credit notes, payment allocation, document numbering, PDF invoices,
a multi-gateway abstraction (Stripe, PayPal, manual, mock), and 670 passing tests.

But **payment state and entitlement state are fused.** Feature access is derived
from `Subscription` plus a monthly application counter. There is no `entitlement`
concept, so it is impossible to express: a free trial, a comp account, a
grandfathered price, a B2G licence paid by invoice, a partial refund that does
*not* revoke access, or a lapsed payment that retains read-only access.

Four commercial models must coexist: B2C candidate subscription; B2B employer,
recruiter and staffing subscriptions and services; B2B/B2G employment-service
licensing; and B2C/B2B career consulting and learning.

## Decision
Introduce an explicit entitlement layer:

```
customer → product → price → subscription → ENTITLEMENT → usage → invoice → payment → credit/refund
```

- **Payment state** answers *did money move?*
- **Entitlement state** answers *what may this account do right now?*
- A successful payment **grants** an entitlement. It is not the same object, and
  the grant is recorded, dated and auditable.
- Entitlements are grantable without a payment (trial, comp, pilot, public-sector
  licence) and revocable without a refund.
- All feature checks read entitlements. **No feature check reads
  `Subscription.status` directly.**

`PlanPrice` and `BillingProfile` already exist unused and are wired here.

## Consequences
- One place answers "can this account do X", which is what makes the
  entitlement matrix (`docs/product/ENTITLEMENT_MATRIX.md`) enforceable.
- The B2B and B2G models get seat-based and pooled entitlements without
  distorting the B2C subscription model. `Organization` already carries
  `seats`, `applicationsPerMonthPooled` and `perSeatCap` — wired here.
- **Employer-paid placement fees and candidate-paid services must never share a
  billing path** (`Stage 19`). Distinct products, distinct entitlements.
- **No card data is stored.** Stripe holds it. This is unchanged and non-negotiable.
- Stripe Connect is deferred until a genuine marketplace exists.
- Stripe webhook idempotency (`WebhookEvent`, currently unused) is a precondition
  — a replayed event must not double-grant an entitlement.

## Revisit when
Usage-based or metered pricing is introduced, which will make `usage` a
first-class billing input rather than a quota counter.

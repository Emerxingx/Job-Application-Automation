# ADR-0030 - The entitlement layer: rows granted by plan transitions, trials and staff; resolved by max; never touched by a refund

**Status:** Accepted (Stage 15, 2026-09-05) · **Implements:** ADR-0010 (the decision to separate payment state from entitlement state), `MASTER_BUILD_PLAN.md` Stage 15 · **Depends on:** ADR-0002 (migrations), ADR-0005 (RLS), Stage 01 webhook idempotency and ordering (`WebhookEvent`)

## Context

ADR-0010 decided that "did money move?" and "what may this account do?"
are different questions with different answers, and that no feature check
reads `Subscription.status`. It did not say how. Before this stage the
application allowance was `Plan.applicationsPerMonth` gated on
`status !== 'canceled'`, the agent ceiling was `Plan.maxAgents` read in
three places, `PlanPrice` and `BillingProfile` were unused, and a refund
had no defined effect on access because access had no representation of
its own.

## Decision

1. **An `Entitlement` row is the unit of access.** Owned by a user or by an
   organization (RLS `userOrOrg`), naming one `capability` from the registry
   in `src/lib/entitlements/capabilities.ts` (a boolean or a quantity), one
   `source` (`plan` · `trial` · `comp` · `pilot` · `licence` · `bonus` ·
   `staff`), a `sourceRef`, an optional `expiresAt`, and a `revokedAt` with a
   `revokedReason` when it ends. Revoked rows stay; they are the trail.
2. **Grants are idempotent by `dedupeKey`** (subject : capability : source :
   sourceRef). A replayed webhook, a second click and a re-sync after a plan
   change back to the earlier plan land on the one row - reactivated, never
   duplicated. A grant that changes nothing writes nothing, not even an audit
   row; every grant that changes something and every revocation is an
   `AuditLog` row (`entitlement.granted`, `entitlement.revoked`) carrying the
   capability, source and reason - never an amount.
3. **The answer is resolved, not stored:** for each capability, the MAX
   quantity across a person's active rows and those of every organization
   they are an accepted member of, or `true` if any boolean row says so, or
   the registry's free-tier baseline when no row applies. A comp on top of a
   plan therefore never lowers what the plan gave, and a zero grant never
   lowers the baseline.
4. **Plan transitions are the only automatic writer.** `activatePlan` syncs
   the plan's rows (`sourceRef = subscriptionId:planCode`; the two quantities
   from the plan row, the rest from the matrix column the plan code's family
   belongs to) and revokes the previous plan's rows as `plan_changed`;
   `startTrial` grants with source `trial` and the trial's expiry;
   `cancelSubscription` at period end sets the rows' expiry to the period
   end (access until then, then the baseline) and immediately revokes them
   as `canceled`; `suspendSubscription` (dunning exhausted) revokes as
   `payment_lapsed`; a recovered payment re-syncs. `past_due` and `grace`
   change nothing: dunning is still running.
5. **Feature checks read the layer only.** `getQuota` takes the allowance
   from `applications_per_month` (plus the subscription's bonus) and
   `canApply` no longer reads status; the agent ceiling is the `agents`
   quantity on the tenant path. A static test refuses a feature module that
   branches on `Subscription.status` or reads a plan column; payment-state
   readers (billing pages, console, CRM, revenue analytics, exports, the
   subscription module, the webhook) are named and allowed.
6. **A refund never revokes.** The webhook records `charge.refunded` as
   `billing.refund.recorded` and calls nothing in the layer (static test);
   nothing under `src/lib/billing` may revoke. Taking access away is a staff
   act on `/console/entitlements`, under step-up, with a reason.
7. **`PlanPrice` and `BillingProfile` are wired.** Checkout resolves the
   price in the customer's presentment currency from `PlanPrice` (falling
   back to the plan's CAD columns and saying so in the response), ensures
   the `BillingProfile` exists before any money moves, and passes the cell's
   gateway price id to the provider. The usage window stays on
   `Subscription`: every account has one (signup activates the starter
   plan), so a comp without a payment still has a month to count against.

## Consequences

- One place answers "may this account do X"; the matrix is enforceable.
- The matrix's B2C quantities (30 / 100 / 300) and the seeded plans
  (25 / 120 / 400) disagree; the plan row wins because it is what the
  customer was shown. Reconciling them is a product decision, recorded as
  such in the Stage 15 evidence, not a silent edit.
- Organization-owned rows reach members now; per-seat accounting against
  `Organization.perSeatCap` is Stage 18-19 work and is not claimed.
- No scheduler exists: `sweepExpired` marks expired rows for the trail when
  it is run; the resolver ignores them regardless, so nothing depends on it.
- Stripe has still never been called live or in test mode from this codebase
  (no key here); the entitlement consequences of every gateway event are
  proven against the local functions the webhook calls, not against Stripe.

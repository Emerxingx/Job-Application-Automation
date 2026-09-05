# Stage 15 - Payments, subscriptions and entitlements - evidence

Recorded 2026-09-05 on branch `claude/stage-15-payments-entitlements`
(PR #27), stacked on Stage 14 (PR #26) - 13 (#25) - 12 (#24) - 11 (#23) -
10 (#22) - 09 (#21) - 08 (#20) - 07 (#19) - 06 (#18) - 05 (#17) - 04 (#16) -
03 (#15) - 02 (#14) - 01 (#13, PARTIAL). Every line was run or read; nothing
is PASS on the strength of a mock, a skipped test or a document. This stage's
honest centre: **entitlement state now exists apart from payment state and
every feature check reads it - proven against the database and enforced by
a static test - while Stripe has still never been called from this codebase,
live or in test mode, because no key exists in the build environment. The
plan's exit gate ("Stripe SANDBOX-VALIDATED minimum; entitlement layer live")
is therefore half met: the layer is live; the sandbox validation is BLOCKED
on a credential and is stated, not approximated.**

## 1. What the stage was for

`MASTER_BUILD_PLAN.md` Stage 15: separate payment state from entitlement
state; validate Stripe. Introduce an explicit entitlement layer (ADR-0010):
customer → product → price → subscription → entitlement → usage → invoice →
payment → credit/refund. Wire `PlanPrice` and `BillingProfile`. Validate
Stripe in test mode end to end. No card data stored. Security: webhook
idempotency verified; entitlement changes audited; refunds do not silently
revoke. Testing: Stripe test-mode E2E including replay, failure and dunning;
entitlement independence tests. Acceptance: entitlement is grantable without
payment and revocable without refund. Exit gate: Stripe SANDBOX-VALIDATED
minimum; entitlement layer live.

## 2. The entitlement layer - `PASS`

ADR-0030. `Entitlement` (migration `20260905120000_entitlements`, RLS
`userOrOrg` in `20260905120100_rls_entitlements`, generated): user- or
organization-owned rows naming a capability from the registry
(`src/lib/entitlements/capabilities.ts`: 14 capabilities, each a boolean or
a quantity with a free-tier baseline), a source (`plan` · `trial` · `comp` ·
`pilot` · `licence` · `bonus` · `staff`), a source reference, an optional
expiry, and a revocation with a reason. `dedupeKey` makes every grant
idempotent; revoked rows stay for the trail; every change that changes
something is an audit row without an amount.

`src/lib/entitlements/service.ts` is the only writer and the only reader
feature code uses: `grantEntitlement`, `revokeEntitlement`, `revokeBySource`,
`entitlementsFor` / `quantityFor` / `can` (resolved by max across the person
and their accepted organizations, free baseline otherwise),
`syncPlanEntitlements`, `applySubscriptionAccess`, `expirePlanEntitlementsAt`,
`sweepExpired`, `describeEntitlements`.

## 3. Payment state drives entitlements, and nothing else does - `PASS`

`src/lib/subscription.ts`: `activatePlan` syncs the plan's rows and revokes
the previous plan's as `plan_changed` (a replayed activation keeps the
window and writes nothing); `startTrial` grants with source `trial` and the
trial's expiry on a `trialing` subscription with no payment;
`cancelSubscription` at period end expires the rows at the period end and
immediately revokes them as `canceled`; `setSubscriptionStatus` from the
gateway keeps access on `past_due`, revokes on `canceled`, re-syncs on
`active` (a recovered payment); `suspendSubscription` (dunning exhausted)
revokes as `payment_lapsed`. The Stripe webhook now also handles
`invoice.paid` (recovery) and `charge.refunded` - the latter RECORDS the
refund (`billing.refund.recorded`) and calls nothing in the layer.

`getQuota` takes the allowance from the `applications_per_month`
entitlement plus the subscription's bonus, and `canApply` no longer reads
status. The agent ceiling (`POST /api/agents`, the agents pages) is the
`agents` quantity on the tenant path. The public analytics summary's quota
block reads the entitlement, read-only. The seed grants the demo account's
rows.

## 4. Grantable without payment, revocable without refund - `PASS`

`/console/entitlements` (billing ops see; admins change) and
`/api/console/entitlements`: look an account up, see the resolved answer and
every row behind it, grant a comp / pilot / licence / bonus / staff row with
a quantity, an optional expiry and a reason under step-up, revoke one with a
reason. Every action is an audit row on the console's audit feed.

## 5. `PlanPrice` and `BillingProfile` wired - `PASS`

`resolvePrice` answers in the customer's presentment currency from an
active `PlanPrice` cell (with its gateway price id) and falls back to the
plan's CAD columns, saying which. `POST /api/billing/checkout` ensures the
`BillingProfile` exists before any money moves (`src/lib/billing/profile.ts`,
currency by country, frozen once set), prices in its currency, passes the
currency and the price id to the provider, and tells the client when the
CAD default applied. The Stripe provider prefers a `PlanPrice` price id over
its environment map.

## 6. Tests - `PASS`

`tests/entitlements.test.ts` (6 pure, 10 database) and
`tests/entitlements-static.test.ts` (3): every case in `TEST_STRATEGY.md`
§Stage 15 - a grant without payment is what the quota reads; a revoke
without refund removes it; the same grant twice is one row and a replayed
activation writes no audit row and no second allowance; an upgrade revokes
as `plan_changed` and the quota and agent ceiling follow; past due keeps
access; suspension revokes as `payment_lapsed` and the free baseline
remains; recovery re-grants; cancel at period end keeps access until then
and the baseline after; a refund recorded changes no row; immediate cancel
revokes; a trial expires and converts; an organization's licence reaches
accepted members only; RLS shows the owner only; no feature module branches
on `Subscription.status` or reads a plan column; the refund handler and
`src/lib/billing` cannot revoke. Stage 01's replay and ordering tests
(`tests/webhook-events.test.ts`) and the payments and subscription suites
stand unchanged. The review round (§11) added: the cap rule (pure and
against the database), a staff revocation surviving a plan re-sync and a
recovered payment, a non-plan grant without a `sourceRef` refused, a
re-purchase after cancel-at-period-end starting a new term, a second trial
of a plan refused on the trail, an account with no subscription row having
a quota, and `resolvePrice` under `requireExternalPriceId`.

## 7. Stripe - `BLOCKED (CREDENTIAL)`

No `STRIPE_SECRET_KEY` / webhook secret exists in this environment, test
mode or otherwise, and none can be minted here. Checkout, the signed
webhook end to end, Smart Retries, Stripe Tax and the refund flow have never
been exercised against Stripe. The webhook's dispatch, replay and ordering
are tested locally; the entitlement consequences of every event type are
tested against the functions it dispatches to. `INTEGRATION_REGISTER.md`
keeps Stripe at IMPLEMENTED-NOT-VALIDATED with the reason. External action
STRIPE-TEST-KEY.

## 8. Gate status

| Gate | Result |
| --- | --- |
| Lint | 0 errors, 7 warnings (baseline ceiling 8; one pre-existing warning resolved) |
| Typecheck | 0 |
| Tests | **1109 / 1109**, 0 skipped (Stage 14: 1087) - new: `entitlements` 16, `entitlements-static` 3 |
| Build | passes; `/console/entitlements` and `/api/console/entitlements` present |
| Migrations | **thirty-eight** (two new, additive; RLS generated); fresh-database rehearsal: 38 applied, `migrate diff` clean, **121** forced-RLS tables in `public` (122 counting the `sensitive` schema's one table, which the RLS manifest also covers) |

## 9. Exit gate - verdict

| Condition | State |
| --- | --- |
| Entitlement layer live | **MET** - rows, service, plan sync, console, static enforcement |
| Entitlement grantable without payment, revocable without refund | **MET** - tested |
| Every feature check reads entitlements, not `Subscription.status` | **MET** - static test; quota and agent ceiling migrated |
| Webhook idempotency and ordering | **MET** (Stage 01) - tests stand |
| Refunds never silently revoke | **MET** - recorded, never dispatched to the layer (static + database tests) |
| `PlanPrice` / `BillingProfile` wired | **MET** |
| Stripe SANDBOX-VALIDATED | **BLOCKED (CREDENTIAL)** - no test-mode key here |
| Stripe Tax | **NOT IMPLEMENTED** - the built-in Canadian and US tables (Stage 01 era) apply; Stripe Tax needs the Stripe validation first |
| Staging rehearsal | **NOT VERIFIED** (R-34) |

**Verdict: Stage 15 engineering is complete; its exit is BLOCKED on the
Stripe test-mode credential.** Everything provable without Stripe is proven.

## 10. What a founder or operator has to do

1. **STRIPE-TEST-KEY (CREDENTIAL):** a Stripe test-mode secret key and
   webhook signing secret in the deployment's environment (never in the
   repository), then run checkout → webhook → entitlement end to end, replay
   an event, fail a payment, refund one, and record the traces here.
2. **Product decision:** the matrix's B2C quantities (30 / 100 / 300
   applications) versus the seeded plans (25 / 120 / 400). The rows carry
   the seeded values. Choose one and the other becomes a migration of the
   `Plan` rows, not a code change.
3. `PlanPrice` rows for USD (and Stripe price ids) if US customers are to be
   charged in USD; until then they see the CAD price with a note.

## 11. Independent review

An independent adversarial review of the Stage 15 diff (a separate agent
with the whole tree, asked to break the entitlement layer, the payment
transitions and the honesty of the evidence) returned 4 HIGH, 4 MEDIUM and
4 LOW findings. Every HIGH and MEDIUM is fixed on the branch; the LOWs are
fixed or recorded here. Nothing was suppressed.

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| H1 | HIGH | The max-merge rule could never take an account BELOW its plan or the free baseline: a zero grant was ignored, so staff had no way to cap an abusive account short of revoking every row. | Fixed: `cap` is a new source that LOWERS (`resolveEntitlements` applies the lowest cap after every grant; a boolean cap blocks), grantable on `/console/entitlements`; pure and database tests. |
| H2 | HIGH | A staff revocation of a plan row was undone by the next plan sync: a replayed `checkout.session.completed` or a recovered payment reactivated the row `grantEntitlement` had been told to revoke for cause. | Fixed: a row with `revokedReason: staff` is not reactivated by a non-staff grant (`blocked: 'staff_revoked'`); a sync leaves it; staff can grant it back. Tested across `activatePlan` and `setSubscriptionStatus('active')`. |
| H3 | HIGH | `activatePlan` treated a re-purchase after cancel-at-period-end as a replay (same plan, same interval, status active), so the flag never cleared and the entitlements kept their expiry. | Fixed: a replay requires `!cancelAtPeriodEnd`; tested. |
| H4 | HIGH | `getQuota` returned `null` for an account with no `Subscription` row and several pages read `null` as unlimited, so a comp granted before any checkout had no ceiling. | Fixed: `baselineQuota` - the `applications_per_month` entitlement against the calendar month's `Application` rows, never null; `consumeQuota`/`refundQuota` move no counter for it; tested. |
| M1 | MEDIUM | `startTrial` allowed a second trial of the same plan after the first expired: the trail existed but was not consulted. | Fixed: any `trial` row for the plan, active or not, refuses; tested. |
| M2 | MEDIUM | `resolvePrice` handed a real gateway a `PlanPrice` cell with no gateway price id, and the Stripe provider then charged the CAD environment price under the customer's currency label. | Fixed: `requireExternalPriceId` (set by checkout when the provider is not mock/manual) skips such a cell and the CAD default applies, stated in the response; the Stripe provider refuses a non-CAD checkout without a price id; tested. |
| M3 | MEDIUM | The CRM customer list still showed the plan column as the allowance (`allowanceFor`) while the detail page showed the entitlement, so a comp or a cap was invisible in the list. | Fixed: `quantitiesForMany` resolves the list's allowance in one query; an organization's pooled rows are not folded into the list, and the code says so. |
| M4 | MEDIUM | `charge.refunded` wrote an audit row and nothing else: the `Payment` ledger never learned the refund, so lifetime value and the invoice trail overstated revenue. | Fixed: the handler sets `amountRefundedCents` and `refunded`/`partially_refunded` on the `Payment` whose `externalId` is the charge's payment intent (absolute values, so a replay converges) and records whether a row matched. Entitlements are still untouched (static test unchanged). |
| L1 | LOW | Two identical grants racing (two webhook deliveries) could hit the `dedupeKey` unique index and fail one delivery. | Fixed: the loser re-reads the winner's row and converges. |
| L2 | LOW | A non-plan grant without a `sourceRef` collapsed two unrelated comps into one row. | Fixed: refused with a message; tested. |
| L3 | LOW | The evidence's "121 forced-RLS tables" omitted the `sensitive` schema's table (122 in total). | Recorded: the count is the `public` schema's, stated as such in §8. |
| L4 | LOW | The matrix/plan quantity mismatch (30/100/300 vs 25/120/400) remains a product decision. | Recorded (§10); unchanged by design. |

Verification after the fixes: typecheck 0, lint 0 errors / 7 warnings,
`1109 / 1109` tests (0 skipped), build passes. The review's gate counts
are in §8.

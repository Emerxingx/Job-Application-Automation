import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { recordSecurityEvent } from '@/lib/security-audit';
import type Stripe from 'stripe';
import { activatePlan, setSubscriptionStatus } from '@/lib/subscription';
import {
  markWebhookFailed,
  markWebhookProcessed,
  normalizeStripeEventType,
  recordWebhookEvent,
  type SubjectType,
} from '@/lib/billing/webhook-events';
import type { BillingInterval } from '@/lib/types';

/**
 * Stripe webhook.
 *
 * This is the authority on subscription state — never the browser redirect.
 * A customer who closes the tab after paying still gets their plan, and a
 * customer who edits the success URL gets nothing.
 *
 * The raw body is required for signature verification, so this route opts out
 * of any body parsing and runs on Node rather than the edge (the Stripe SDK
 * needs Node crypto).
 *
 * EVERY VERIFIED EVENT IS RECORDED BEFORE IT IS DISPATCHED.
 *
 * Stripe retries until it receives a 2xx, so the same `evt_…` genuinely arrives
 * more than once — and before Stage 01 this route dispatched on every delivery,
 * so a replayed `checkout.session.completed` activated a plan twice. It also
 * cannot guarantee order, so a delayed `subscription.updated(active)` could
 * land after `subscription.deleted` and resurrect a cancelled subscription.
 * `recordWebhookEvent` closes both: a unique key on (provider, event id) for
 * replay, and a comparison against the newest processed event for the same
 * subject for ordering. See src/lib/billing/webhook-events.ts.
 *
 * Duplicate and stale deliveries return 200. They are normal operation, not
 * errors — answering non-2xx would make Stripe retry an event we have
 * deliberately declined to apply.
 */
/** Who drives every transition from here, for the entitlement trail. */
const BY = 'webhook:stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isBillingInterval(value: unknown): value is BillingInterval {
  return value === 'monthly' || value === 'quarterly' || value === 'annual';
}

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header.' }, { status: 400 });
  }

  let event: Stripe.Event;
  let payload: string;
  try {
    const { constructWebhookEvent } = await import('@/lib/providers/payments/stripe');
    payload = await request.text();
    event = constructWebhookEvent(payload, signature);
  } catch (error) {
    // A bad signature is an attacker or a misconfiguration; either way, refuse.
    console.error('[stripe-webhook] signature verification failed:', error);
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
  }

  // Identify the subject whose transitions must stay ordered.
  let subjectType: SubjectType | undefined;
  let subjectId: string | undefined;
  const object = event.data.object as { id?: unknown; subscription?: unknown };
  if (event.type.startsWith('customer.subscription.')) {
    subjectType = 'subscription';
    subjectId = typeof object.id === 'string' ? object.id : undefined;
  } else if (event.type.startsWith('invoice.')) {
    subjectType = 'subscription';
    subjectId = typeof object.subscription === 'string' ? object.subscription : undefined;
  } else if (event.type === 'checkout.session.completed') {
    subjectType = 'subscription';
    const sub = (event.data.object as Stripe.Checkout.Session).subscription;
    subjectId = typeof sub === 'string' ? sub : undefined;
  }

  const outcome = await recordWebhookEvent({
    provider: 'stripe',
    externalEventId: event.id,
    type: normalizeStripeEventType(event.type),
    rawType: event.type,
    subjectType,
    subjectId,
    payload,
    livemode: event.livemode,
    // Stripe's own timestamp, in seconds. Receipt time cannot detect
    // out-of-order delivery; this can.
    occurredAt: new Date(event.created * 1000),
  });

  if (outcome.action !== 'process') {
    console.info(
      `[stripe-webhook] ${event.id} (${event.type}) not dispatched: ${outcome.action}`,
    );
    // 200 on purpose — see the module comment.
    return NextResponse.json({ received: true, dispatched: false, reason: outcome.action });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? session.metadata?.userId;
        const planCode = session.metadata?.planCode;
        const interval = session.metadata?.interval;

        if (!userId || !planCode || !isBillingInterval(interval)) {
          console.error('[stripe-webhook] checkout session missing metadata:', session.id);
          break;
        }

        await activatePlan(userId, planCode, interval, {
          external: {
            customerId: typeof session.customer === 'string' ? session.customer : undefined,
            subscriptionId:
              typeof session.subscription === 'string' ? session.subscription : undefined,
          },
          by: BY,
        });
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const status =
          subscription.status === 'active' || subscription.status === 'trialing'
            ? 'active'
            : subscription.status === 'past_due' || subscription.status === 'unpaid'
              ? 'past_due'
              : subscription.status === 'canceled'
                ? 'canceled'
                : null;
        if (status) await setSubscriptionStatus(subscription.id, status, { by: BY });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await setSubscriptionStatus(subscription.id, 'canceled', { by: BY });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId =
          typeof (invoice as { subscription?: unknown }).subscription === 'string'
            ? ((invoice as { subscription: string }).subscription)
            : undefined;
        if (subId) await setSubscriptionStatus(subId, 'past_due', { by: BY });
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        // Stage 15: a paid invoice on a subscription that was past due is the
        // recovery - the plan's entitlements are re-synced through the status.
        const invoice = event.data.object as Stripe.Invoice;
        const subId =
          typeof (invoice as { subscription?: unknown }).subscription === 'string'
            ? ((invoice as { subscription: string }).subscription)
            : undefined;
        if (subId) await setSubscriptionStatus(subId, 'active', { by: BY });
        break;
      }

      case 'charge.refunded': {
        // Stage 15 (ADR-0010): a refund is money moving back. It is RECORDED
        // and it NEVER revokes an entitlement on its own - revocation is a
        // separate, audited staff act on /console/entitlements. Deliberately
        // no call into the entitlement service here.
        const charge = event.data.object as Stripe.Charge;
        // The ledger side: the Payment row that carries this charge's payment
        // intent learns the refunded amount and its status. Absolute values, so
        // a replay converges; a charge with no local Payment (a payment made
        // before this code, or through another path) is recorded as unmatched
        // rather than invented.
        const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        const amountRefunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
        const fullyRefunded = charge.refunded === true || (typeof charge.amount === 'number' && amountRefunded >= charge.amount);
        const matched = paymentIntent
          ? await db.payment.updateMany({
              where: { provider: 'stripe', externalId: paymentIntent },
              data: { amountRefundedCents: amountRefunded, status: fullyRefunded ? 'refunded' : amountRefunded > 0 ? 'partially_refunded' : undefined },
            })
          : { count: 0 };
        await recordSecurityEvent({
          event: 'billing.refund.recorded',
          actor: { type: 'system' },
          entityType: 'Charge',
          entityId: charge.id,
          summary: matched.count > 0 ? 'Refund recorded on the payment ledger; entitlements unchanged' : 'Refund recorded from the gateway with no matching payment row; entitlements unchanged',
          detail: { provider: 'stripe', refunded: fullyRefunded, paymentsUpdated: matched.count, customer: typeof charge.customer === 'string' ? charge.customer : null },
        });
        break;
      }

      default:
        // Unhandled types are acknowledged so Stripe stops retrying them.
        break;
    }
  } catch (error) {
    // Returning 500 makes Stripe retry, which is what we want for a transient
    // database failure — the event is not lost. The row is marked `failed`, and
    // because the retry carries the SAME event id it will be recognised as a
    // duplicate rather than double-applied.
    console.error(`[stripe-webhook] handling ${event.type} failed:`, error);
    await markWebhookFailed(outcome.eventId, error instanceof Error ? error.message : 'unknown').catch(
      (e) => console.error('[stripe-webhook] could not mark event failed:', e),
    );
    return NextResponse.json({ error: 'Handler failed.' }, { status: 500 });
  }

  await markWebhookProcessed(outcome.eventId).catch((e) =>
    console.error('[stripe-webhook] could not mark event processed:', e),
  );

  return NextResponse.json({ received: true, dispatched: true });
}

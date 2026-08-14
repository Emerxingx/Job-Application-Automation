import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { activatePlan, setSubscriptionStatus } from '@/lib/subscription';
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
 */
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
  try {
    const { constructWebhookEvent } = await import('@/lib/providers/payments/stripe');
    const payload = await request.text();
    event = constructWebhookEvent(payload, signature);
  } catch (error) {
    // A bad signature is an attacker or a misconfiguration; either way, refuse.
    console.error('[stripe-webhook] signature verification failed:', error);
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
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
          customerId: typeof session.customer === 'string' ? session.customer : undefined,
          subscriptionId:
            typeof session.subscription === 'string' ? session.subscription : undefined,
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
        if (status) await setSubscriptionStatus(subscription.id, status);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await setSubscriptionStatus(subscription.id, 'canceled');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId =
          typeof (invoice as { subscription?: unknown }).subscription === 'string'
            ? ((invoice as { subscription: string }).subscription)
            : undefined;
        if (subId) await setSubscriptionStatus(subId, 'past_due');
        break;
      }

      default:
        // Unhandled types are acknowledged so Stripe stops retrying them.
        break;
    }
  } catch (error) {
    // Returning 500 makes Stripe retry, which is what we want for a transient
    // database failure — the event is not lost.
    console.error(`[stripe-webhook] handling ${event.type} failed:`, error);
    return NextResponse.json({ error: 'Handler failed.' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

import Stripe from 'stripe';
import type { BillingInterval } from '@/lib/types';
import type { CheckoutSession, PaymentProvider } from './index';

/**
 * Stripe subscription billing.
 *
 * Prices are not created on the fly — a deployment maps each plan/interval
 * pair to a Price created in the Stripe dashboard, so the amounts customers
 * are charged live in one auditable place rather than in application code.
 *
 * Map them with either form:
 *   STRIPE_PRICE_PROFESSIONAL_MONTHLY=price_123
 *   STRIPE_PRICE_MAP={"professional:monthly":"price_123", ...}
 */

let client: Stripe | null = null;

function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.');
  // Pinned to the version this integration was written against; the SDK's
  // bundled types are the source of truth for what that is.
  client = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  return client;
}

function priceMap(): Record<string, string> {
  const raw = process.env.STRIPE_PRICE_MAP;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    console.warn('[stripe] STRIPE_PRICE_MAP is not valid JSON; ignoring it.');
    return {};
  }
}

/** Resolve the Stripe Price for a plan/interval pair. */
export function priceIdFor(planCode: string, interval: BillingInterval): string | undefined {
  const fromMap = priceMap()[`${planCode}:${interval}`];
  if (fromMap) return fromMap;
  const envKey = `STRIPE_PRICE_${planCode.toUpperCase()}_${interval.toUpperCase()}`;
  return process.env[envKey];
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';

  async createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    interval: BillingInterval;
    amountCents: number;
    currency?: string;
    externalPriceId?: string | null;
  }): Promise<CheckoutSession> {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    // Stage 15: a PlanPrice row's own price id wins over the environment map.
    const price = input.externalPriceId ?? priceIdFor(input.planCode, input.interval);

    if (!price) {
      throw new Error(
        `No Stripe price configured for ${input.planCode}/${input.interval}. ` +
          `Set STRIPE_PRICE_${input.planCode.toUpperCase()}_${input.interval.toUpperCase()}.`,
      );
    }

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: input.email,
      // Carried back on the webhook so the subscription lands on the right user.
      client_reference_id: input.userId,
      metadata: { userId: input.userId, planCode: input.planCode, interval: input.interval },
      subscription_data: {
        metadata: { userId: input.userId, planCode: input.planCode, interval: input.interval },
      },
      success_url: `${appUrl}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/dashboard/billing?checkout=cancelled`,
      allow_promotion_codes: true,
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL.');

    return { id: session.id, url: session.url, simulated: false };
  }

  async cancel(subscriptionId: string): Promise<{ ok: boolean }> {
    if (!subscriptionId) return { ok: false };
    try {
      // Cancel at period end: the applicant keeps the applications they paid for.
      await stripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      return { ok: true };
    } catch (error) {
      console.error('[stripe] cancel failed:', error);
      return { ok: false };
    }
  }
}

/** Verify and parse a webhook payload. Throws when the signature is invalid. */
export function constructWebhookEvent(payload: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  return stripe().webhooks.constructEvent(payload, signature, secret);
}

export function stripeClient(): Stripe {
  return stripe();
}

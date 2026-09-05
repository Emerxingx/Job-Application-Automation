import type { BillingInterval } from '@/lib/types';

export interface CheckoutSession {
  id: string;
  url: string;
  /** True when no real gateway ran, so the caller activates the plan directly. */
  simulated: boolean;
}

/**
 * Payment gateway contract.
 *
 * The mock implementation activates subscriptions immediately so the whole
 * product is walkable without Stripe credentials. Swapping in Stripe means
 * implementing this interface and setting PAYMENT_PROVIDER=stripe.
 */
export interface PaymentProvider {
  readonly name: string;

  createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    interval: BillingInterval;
    amountCents: number;
    /** Stage 15: the customer's presentment currency from their billing profile (CAD | USD). */
    currency?: string;
    /** Stage 15: the gateway's own price id for this (plan, interval, currency) cell, from PlanPrice, when one is recorded. */
    externalPriceId?: string | null;
  }): Promise<CheckoutSession>;

  cancel(subscriptionId: string): Promise<{ ok: boolean }>;
}

class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async createCheckout(input: {
    userId: string;
    planCode: string;
    interval: BillingInterval;
  }): Promise<CheckoutSession> {
    const id = `mock_cs_${input.userId.slice(-6)}_${input.planCode}_${input.interval}`;
    return {
      id,
      url: `/dashboard/billing?activated=${input.planCode}&interval=${input.interval}`,
      simulated: true,
    };
  }

  async cancel(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;

  const configured = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

  if (configured === 'stripe') {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.warn('[payments] PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY is unset; using the mock gateway.');
    } else {
      // Required lazily so the Stripe SDK never loads in mock deployments.
      const { StripePaymentProvider } = require('./stripe') as typeof import('./stripe');
      cached = new StripePaymentProvider();
      return cached;
    }
  } else if (configured !== 'mock') {
    console.warn(`[payments] PAYMENT_PROVIDER="${configured}" is not implemented; using the mock gateway.`);
  }

  cached = new MockPaymentProvider();
  return cached;
}

/** Test seam — clears the memoized provider. */
export function resetPaymentProvider(): void {
  cached = null;
}

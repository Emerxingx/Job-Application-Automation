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
  // Stripe implementation drops in here when PAYMENT_PROVIDER=stripe.
  cached = new MockPaymentProvider();
  return cached;
}

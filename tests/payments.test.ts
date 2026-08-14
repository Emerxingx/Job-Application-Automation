import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_FALLBACK_ORDER,
  GatewayError,
  GatewayNotConfiguredError,
  assertRefundable,
  defaultGatewayName,
  enabledGatewayNames,
  fallbackOrder,
  gatewayBlockedReason,
  isGatewayEnabled,
  isGatewayName,
  listGateways,
  markGatewayDown,
  markGatewayUp,
  normalizeStripeEventType,
  registerGateway,
  resetGatewayRegistry,
  resolveForRefund,
  resolveGateway,
  resolveGatewayWithFallback,
  subjectTypeFor,
  validateRefundAmount,
} from '../src/lib/providers/payments/registry';
import type {
  GatewayCapabilities,
  GatewayName,
  PaymentGateway,
} from '../src/lib/providers/payments/registry';
import {
  PayPalPaymentProvider,
  centsToPayPalAmount,
  normalizePayPalEventType,
  paypalApiBase,
  paypalPlanIdFor,
  payPalAmountToCents,
  resetPayPalToken,
} from '../src/lib/providers/payments/paypal';
import {
  ManualPaymentProvider,
  bankTransferInstructions,
  manualReference,
} from '../src/lib/providers/payments/manual';
import {
  DEFAULT_DUNNING_POLICY,
  DUNNING_ACTIONABLE_STATES,
  DUNNING_GRACE_DAYS,
  DUNNING_SCHEDULE_DAYS,
  addDays,
  applyAttemptResult,
  buildDunningTimeline,
  classifyFailure,
  computeNextAction,
  dunningIdempotencyKey,
  graceDaysRemaining,
  isRetryable,
  isWithinGrace,
  outcomeForFailure,
  parseDunningSchedule,
  scheduledAttemptAt,
  serializeChannels,
  serializeDunningSchedule,
} from '../src/lib/billing/dunning';
import type { DunningInput } from '../src/lib/billing/dunning';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Every variable that can change a selection decision is cleared before each
// test, so a developer's real .env can never make a test pass or fail.
const ENV_KEYS = [
  'PAYMENT_PROVIDER',
  'PAYMENT_GATEWAY',
  'PAYMENT_GATEWAY_FALLBACK',
  'STRIPE_SECRET_KEY',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'PAYPAL_ENV',
  'PAYPAL_API_BASE',
  'PAYPAL_PLAN_MAP',
  'PAYPAL_PLAN_PROFESSIONAL_MONTHLY',
  'BANK_TRANSFER_BENEFICIARY',
  'BANK_TRANSFER_EMAIL',
  'BANK_TRANSFER_INSTITUTION',
  'BANK_TRANSFER_TRANSIT',
  'BANK_TRANSFER_ACCOUNT',
  'BANK_TRANSFER_SWIFT',
];

let saved: Record<string, string | undefined> = {};
let warnings: string[] = [];
const realWarn = console.warn;
const realFetch = globalThis.fetch;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  resetPayPalToken();
  resetGatewayRegistry();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  console.warn = realWarn;
  globalThis.fetch = realFetch;
  resetPayPalToken();
  resetGatewayRegistry();
});

/** A stand-in gateway, so registry behaviour is testable without credentials. */
function fakeGateway(name: GatewayName, capabilities: Partial<GatewayCapabilities> = {}): PaymentGateway {
  return {
    name,
    capabilities: {
      checkout: true,
      orders: true,
      refunds: true,
      webhooks: true,
      recurring: false,
      gatewayManagedRetries: false,
      ...capabilities,
    },
    isConfigured: () => true,
    async createCheckout() {
      return { id: `${name}_cs`, url: `/checkout/${name}`, simulated: false };
    },
    async cancel() {
      return { ok: true };
    },
    async createOrder(input) {
      return {
        provider: name,
        externalId: `${name}_order`,
        status: 'created',
        amountCents: input.amountCents,
        currency: input.currency,
        raw: {},
      };
    },
    async capture(input) {
      return {
        provider: name,
        externalId: `${name}_capture`,
        status: 'succeeded',
        amountCents: input.amountCents ?? 0,
        currency: 'CAD',
        feeCents: 0,
        netCents: input.amountCents ?? 0,
        raw: {},
      };
    },
    async refund(input) {
      return {
        provider: name,
        externalId: `${name}_refund`,
        status: 'succeeded',
        amountCents: input.amountCents,
        currency: input.currency,
        raw: {},
      };
    },
    async verifyWebhook() {
      throw new GatewayError('not used in this test', { code: 'unsupported_operation' });
    },
  };
}

/** Register an always-available stand-in under a real gateway name. */
function stubGateway(name: GatewayName, capabilities: Partial<GatewayCapabilities> = {}): void {
  const gateway = fakeGateway(name, capabilities);
  registerGateway({
    name,
    label: `Stub ${name}`,
    capabilities: gateway.capabilities,
    unavailableReason: () => null,
    create: () => gateway,
  });
}

// ---------------------------------------------------------------------------
// Registry: resolution and fallback
// ---------------------------------------------------------------------------

describe('gateway registry resolution', () => {
  it('knows only the gateway names the schema can persist', () => {
    assert.equal(isGatewayName('stripe'), true);
    assert.equal(isGatewayName('paypal'), true);
    assert.equal(isGatewayName('manual'), true);
    // The dev-only mock provider has no ledger identity, so it is not a gateway.
    assert.equal(isGatewayName('mock'), false);
    assert.equal(isGatewayName('square'), false);
  });

  it('resolves a registered gateway by name and caches the instance', () => {
    const gateway = resolveGateway('manual');
    assert.equal(gateway.name, 'manual');
    assert.equal(resolveGateway('manual'), gateway, 'resolution must be memoized');
  });

  it('lists the documented fallback order with manual last', () => {
    assert.deepEqual([...DEFAULT_FALLBACK_ORDER], ['stripe', 'paypal', 'manual']);
    assert.deepEqual(fallbackOrder(), ['stripe', 'paypal', 'manual']);
  });

  it('honours a deployment-specific fallback order but keeps manual terminal', () => {
    process.env.PAYMENT_GATEWAY_FALLBACK = 'manual,paypal,stripe';
    assert.deepEqual(fallbackOrder(), ['paypal', 'stripe', 'manual']);
  });

  it('ignores unknown names in the fallback order and says so once', () => {
    process.env.PAYMENT_GATEWAY_FALLBACK = 'square,paypal';
    assert.deepEqual(fallbackOrder(), ['paypal', 'stripe', 'manual']);
    assert.ok(
      warnings.some((line) => line.includes('square')),
      'an unknown gateway in the order must be reported',
    );
  });

  it('falls back to the next gateway when the preferred one is down', () => {
    stubGateway('stripe');
    stubGateway('paypal');

    const healthy = resolveGatewayWithFallback('stripe');
    assert.equal(healthy.name, 'stripe');
    assert.equal(healthy.fellBack, false);

    markGatewayDown('stripe', 'connection reset', 60);

    const routed = resolveGatewayWithFallback('stripe');
    assert.equal(routed.name, 'paypal', 'an outage must route to the next gateway');
    assert.equal(routed.requested, 'stripe');
    assert.equal(routed.fellBack, true);
    assert.match(routed.reason ?? '', /connection reset/);

    markGatewayUp('stripe');
    assert.equal(resolveGatewayWithFallback('stripe').name, 'stripe', 'recovery must restore routing');
  });

  it('takes a gateway out of rotation for a bounded window, not forever', () => {
    stubGateway('stripe');
    markGatewayDown('stripe', 'timeout', 300);

    assert.equal(isGatewayEnabled('stripe'), false);
    const row = listGateways().find((entry) => entry.name === 'stripe')!;
    assert.equal(row.configured, true, 'credentials are fine; only health is not');
    assert.equal(row.healthy, false);
    assert.ok(row.downUntil!.getTime() > Date.now(), 'the outage must carry an expiry');
    assert.ok(row.downUntil!.getTime() <= Date.now() + 300_000);

    markGatewayUp('stripe');
    assert.equal(isGatewayEnabled('stripe'), true);
  });

  it('degrades to the manual gateway when every other gateway is unusable', () => {
    // No credentials anywhere: stripe and paypal are both unavailable.
    assert.deepEqual(enabledGatewayNames(), ['manual']);
    const resolution = resolveGatewayWithFallback();
    assert.equal(resolution.name, 'manual');
    assert.equal(resolution.gateway.isConfigured(), true);
  });

  it('skips gateways that lack a required capability', () => {
    stubGateway('stripe', { refunds: false });
    stubGateway('paypal', { refunds: true });

    const resolution = resolveGatewayWithFallback('stripe', { require: ['refunds'] });
    assert.equal(resolution.name, 'paypal');
    assert.equal(resolution.fellBack, true);
    assert.match(resolution.reason ?? '', /does not support refunds/);
  });

  it('throws when no gateway can satisfy the requirement', () => {
    resetGatewayRegistry();
    // Manual is the only gateway available without credentials, and it has no
    // webhooks — so a webhook-capable request cannot be satisfied.
    assert.throws(
      () => resolveGatewayWithFallback(undefined, { require: ['webhooks'] }),
      (error: unknown) =>
        error instanceof GatewayError && error.code === 'no_gateway_available' && error.retryable,
    );
  });

  it('reports every gateway for the console, marking the default', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    const rows = listGateways();
    assert.deepEqual(
      rows.map((row) => row.name),
      ['stripe', 'paypal', 'manual'],
    );

    const stripe = rows.find((row) => row.name === 'stripe')!;
    assert.equal(stripe.configured, true);
    assert.equal(stripe.isDefault, true);
    assert.equal(stripe.blockedReason, null);
    assert.equal(stripe.capabilities.gatewayManagedRetries, true, 'Smart Retries are gateway-owned');

    const paypal = rows.find((row) => row.name === 'paypal')!;
    assert.equal(paypal.configured, false);
    assert.match(paypal.blockedReason ?? '', /PAYPAL_CLIENT_ID/);

    const manual = rows.find((row) => row.name === 'manual')!;
    assert.equal(manual.configured, true);
    assert.equal(manual.capabilities.webhooks, false);
  });
});

// ---------------------------------------------------------------------------
// Registry: selection when credentials are missing
// ---------------------------------------------------------------------------

describe('gateway selection when credentials are missing', () => {
  it('does not select a gateway whose credentials are absent', () => {
    assert.match(gatewayBlockedReason('stripe') ?? '', /STRIPE_SECRET_KEY/);
    assert.equal(isGatewayEnabled('stripe'), false);
    assert.equal(defaultGatewayName(), 'manual');
  });

  it('names the missing PayPal variable, and both when both are absent', () => {
    assert.match(gatewayBlockedReason('paypal') ?? '', /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set/);

    process.env.PAYPAL_CLIENT_ID = 'client-id';
    assert.match(gatewayBlockedReason('paypal') ?? '', /PAYPAL_CLIENT_SECRET is not set/);

    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    assert.equal(gatewayBlockedReason('paypal'), null);
    assert.equal(isGatewayEnabled('paypal'), true);
  });

  it('treats an empty environment variable as unset', () => {
    // .env ships STRIPE_SECRET_KEY="" as a placeholder; that is not a key.
    process.env.STRIPE_SECRET_KEY = '   ';
    assert.equal(isGatewayEnabled('stripe'), false);
    assert.equal(defaultGatewayName(), 'manual');
  });

  it('follows PAYMENT_PROVIDER when that gateway is usable', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.PAYMENT_PROVIDER = 'stripe';
    assert.equal(defaultGatewayName(), 'stripe');
  });

  it('falls back rather than failing when PAYMENT_PROVIDER names an unusable gateway', () => {
    process.env.PAYMENT_PROVIDER = 'stripe'; // no STRIPE_SECRET_KEY
    assert.equal(defaultGatewayName(), 'manual');
    assert.ok(
      warnings.some((line) => line.includes('PAYMENT_PROVIDER') && line.includes('falling back')),
      'the operator must be told their configured gateway was passed over',
    );
  });

  it('lets PAYMENT_GATEWAY win over the legacy PAYMENT_PROVIDER', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.PAYMENT_GATEWAY = 'paypal';
    assert.equal(defaultGatewayName(), 'paypal');
  });

  it('accepts the legacy PAYMENT_PROVIDER=mock without complaint', () => {
    process.env.PAYMENT_PROVIDER = 'mock';
    assert.equal(defaultGatewayName(), 'manual');
    assert.equal(
      warnings.some((line) => line.includes('mock')),
      false,
      'the documented dev value must not produce a warning',
    );
  });

  it('throws a typed error naming the variable when asked for it directly', () => {
    assert.throws(
      () => resolveGateway('stripe'),
      (error: unknown) =>
        error instanceof GatewayNotConfiguredError &&
        error.code === 'not_configured' &&
        /STRIPE_SECRET_KEY/.test(error.message),
    );
  });

  it('never falls back for a refund', () => {
    stubGateway('paypal');
    // Stripe took the money, so only Stripe can send it back — even though a
    // perfectly healthy PayPal is registered and would happily take the call.
    assert.throws(
      () => resolveForRefund('stripe'),
      (error: unknown) =>
        error instanceof GatewayNotConfiguredError && /only be refunded there/.test(error.message),
    );
    assert.equal(resolveForRefund('paypal').name, 'paypal');
  });

  it('refuses to refund a payment taken through an unknown provider', () => {
    assert.throws(
      () => resolveForRefund('square'),
      (error: unknown) => error instanceof GatewayError && error.code === 'unknown_gateway',
    );
  });
});

// ---------------------------------------------------------------------------
// Refund amount validation
// ---------------------------------------------------------------------------

describe('refund amount validation', () => {
  it('allows a refund up to exactly what was captured', () => {
    const full = validateRefundAmount({ capturedCents: 5900, requestedCents: 5900 });
    assert.equal(full.ok, true);
    assert.equal(full.refundableCents, 5900);

    const partial = validateRefundAmount({ capturedCents: 5900, requestedCents: 1 });
    assert.equal(partial.ok, true);
  });

  it('refuses to refund more than was captured', () => {
    const result = validateRefundAmount({ capturedCents: 5900, requestedCents: 5901 });
    assert.equal(result.ok, false);
    assert.equal(result.refundableCents, 5900);
    assert.match(result.reason ?? '', /\$59\.00/);
  });

  it('counts refunds already sent against the ceiling', () => {
    const result = validateRefundAmount({
      capturedCents: 5900,
      alreadyRefundedCents: 4000,
      requestedCents: 1901,
    });
    assert.equal(result.ok, false);
    assert.equal(result.refundableCents, 1900);

    const allowed = validateRefundAmount({
      capturedCents: 5900,
      alreadyRefundedCents: 4000,
      requestedCents: 1900,
    });
    assert.equal(allowed.ok, true);
  });

  it('refuses a second refund once the payment is fully refunded', () => {
    const result = validateRefundAmount({
      capturedCents: 5900,
      alreadyRefundedCents: 5900,
      requestedCents: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.refundableCents, 0);
    assert.match(result.reason ?? '', /already fully refunded/);
  });

  it('rejects zero, negative and fractional amounts', () => {
    assert.equal(validateRefundAmount({ capturedCents: 5900, requestedCents: 0 }).ok, false);
    assert.equal(validateRefundAmount({ capturedCents: 5900, requestedCents: -100 }).ok, false);
    // Money is integer cents everywhere; 19.995 is a bug upstream.
    const fractional = validateRefundAmount({ capturedCents: 5900, requestedCents: 19.5 });
    assert.equal(fractional.ok, false);
    assert.match(fractional.reason ?? '', /whole cents/);
  });

  it('refuses to refund a payment that captured nothing', () => {
    const result = validateRefundAmount({ capturedCents: 0, requestedCents: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.refundableCents, 0);
  });

  it('throws a typed gateway error from the assertion form', () => {
    assert.throws(
      () => assertRefundable('stripe', { capturedCents: 100, requestedCents: 500 }),
      (error: unknown) =>
        error instanceof GatewayError &&
        error.code === 'invalid_refund_amount' &&
        error.provider === 'stripe' &&
        error.retryable === false,
    );
  });

  it('enforces the ceiling in the manual gateway before any money is promised', async () => {
    const manual = new ManualPaymentProvider();
    await assert.rejects(
      manual.refund({
        externalPaymentId: 'pay_1',
        amountCents: 10_000,
        currency: 'CAD',
        idempotencyKey: 'jp_ref_cn_1',
        capturedCents: 5900,
      }),
      (error: unknown) => error instanceof GatewayError && error.code === 'invalid_refund_amount',
    );

    const owed = await manual.refund({
      externalPaymentId: 'pay_1',
      amountCents: 2900,
      currency: 'CAD',
      idempotencyKey: 'jp_ref_cn_2',
      capturedCents: 5900,
    });
    // Honest: a human still has to send the transfer.
    assert.equal(owed.status, 'pending');
    assert.equal(owed.provider, 'manual');
    assert.equal(owed.amountCents, 2900);
  });

  it('enforces the ceiling in the PayPal gateway before the network call', async () => {
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    globalThis.fetch = (() => {
      throw new Error('the refund ceiling must be checked before PayPal is called');
    }) as typeof fetch;

    const paypal = new PayPalPaymentProvider();
    await assert.rejects(
      paypal.refund({
        externalPaymentId: 'CAPTURE123',
        amountCents: 6000,
        currency: 'CAD',
        idempotencyKey: 'jp_ref_cn_3',
        capturedCents: 5900,
        alreadyRefundedCents: 0,
      }),
      (error: unknown) => error instanceof GatewayError && error.code === 'invalid_refund_amount',
    );
  });
});

// ---------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------

describe('paypal gateway', () => {
  it('warns but does not throw when credentials are absent', () => {
    const paypal = new PayPalPaymentProvider();
    assert.equal(paypal.isConfigured(), false);
    assert.ok(
      warnings.some((line) => line.includes('PAYPAL_CLIENT_ID')),
      'an unconfigured gateway must say so once, not crash the process',
    );
  });

  it('fails cleanly, without a network call, when credentials are absent', async () => {
    globalThis.fetch = (() => {
      throw new Error('PayPal must not be called without credentials');
    }) as typeof fetch;

    const paypal = new PayPalPaymentProvider();
    await assert.rejects(
      paypal.createOrder({
        reference: 'inv_1',
        userId: 'user_1',
        amountCents: 5900,
        currency: 'CAD',
        description: 'Professional plan',
        idempotencyKey: 'jp_ord_1',
      }),
      (error: unknown) =>
        error instanceof GatewayNotConfiguredError && /PAYPAL_CLIENT_ID/.test(error.message),
    );
  });

  it('requires a webhook id before it will trust an inbound event', async () => {
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    const paypal = new PayPalPaymentProvider();

    await assert.rejects(
      paypal.verifyWebhook({ payload: '{}', headers: {} }),
      (error: unknown) =>
        error instanceof GatewayNotConfiguredError && /PAYPAL_WEBHOOK_ID/.test(error.message),
    );
  });

  it('rejects an event that is missing its signature headers', async () => {
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    process.env.PAYPAL_WEBHOOK_ID = 'WH-123';
    const paypal = new PayPalPaymentProvider();

    await assert.rejects(
      paypal.verifyWebhook({
        payload: JSON.stringify({ id: 'evt', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
        headers: { 'paypal-auth-algo': 'SHA256withRSA' },
      }),
      (error: unknown) =>
        error instanceof GatewayError &&
        error.code === 'signature_verification_failed' &&
        /paypal-transmission-id/.test(error.message),
    );
  });

  it('defaults to the sandbox and switches on PAYPAL_ENV', () => {
    assert.match(paypalApiBase(), /sandbox/);
    process.env.PAYPAL_ENV = 'live';
    assert.equal(paypalApiBase(), 'https://api-m.paypal.com');
  });

  it('maps plans to billing plan ids from either configuration form', () => {
    assert.equal(paypalPlanIdFor('professional', 'monthly'), undefined);

    process.env.PAYPAL_PLAN_PROFESSIONAL_MONTHLY = 'P-ENV';
    assert.equal(paypalPlanIdFor('professional', 'monthly'), 'P-ENV');

    process.env.PAYPAL_PLAN_MAP = JSON.stringify({ 'professional:monthly': 'P-MAP' });
    assert.equal(paypalPlanIdFor('professional', 'monthly'), 'P-MAP', 'the map wins');
  });

  it('converts cents to PayPal amounts without floating point error', () => {
    assert.equal(centsToPayPalAmount(5900), '59.00');
    assert.equal(centsToPayPalAmount(1999), '19.99');
    assert.equal(centsToPayPalAmount(5), '0.05');
    assert.equal(centsToPayPalAmount(0), '0.00');
    assert.equal(centsToPayPalAmount(100000), '1000.00');
  });

  it('parses PayPal amounts back to exact cents', () => {
    assert.equal(payPalAmountToCents('19.99'), 1999);
    assert.equal(payPalAmountToCents('0.05'), 5);
    assert.equal(payPalAmountToCents('59'), 5900);
    assert.equal(payPalAmountToCents('1000.00'), 100000);

    // Round-tripping every amount in a realistic band must be lossless — this
    // is the property that stops a cent leaking per transaction.
    for (let cents = 0; cents <= 20000; cents += 7) {
      assert.equal(payPalAmountToCents(centsToPayPalAmount(cents)), cents);
    }
  });

  it('refuses fractional cents and unsupported currencies', () => {
    assert.throws(() => centsToPayPalAmount(19.5), GatewayError);
    assert.throws(() => centsToPayPalAmount(5900, 'JPY'), GatewayError);
    assert.throws(() => payPalAmountToCents('not-money'), GatewayError);
  });

  it('normalises PayPal event types into the shared vocabulary', () => {
    assert.equal(normalizePayPalEventType('PAYMENT.CAPTURE.COMPLETED'), 'payment.succeeded');
    assert.equal(normalizePayPalEventType('PAYMENT.CAPTURE.DENIED'), 'payment.failed');
    assert.equal(normalizePayPalEventType('PAYMENT.CAPTURE.REFUNDED'), 'refund.succeeded');
    assert.equal(normalizePayPalEventType('CHECKOUT.ORDER.APPROVED'), 'checkout.completed');
    assert.equal(normalizePayPalEventType('BILLING.SUBSCRIPTION.ACTIVATED'), 'subscription.updated');
    assert.equal(normalizePayPalEventType('BILLING.SUBSCRIPTION.CANCELLED'), 'subscription.canceled');
    assert.equal(normalizePayPalEventType('CUSTOMER.DISPUTE.CREATED'), 'dispute.opened');
    // Unrecognised events are recorded, never thrown at.
    assert.equal(normalizePayPalEventType('SOMETHING.NEW'), 'unknown');
  });

  it('normalises Stripe event types into the same vocabulary', () => {
    assert.equal(normalizeStripeEventType('checkout.session.completed'), 'checkout.completed');
    assert.equal(normalizeStripeEventType('invoice.payment_failed'), 'invoice.payment_failed');
    assert.equal(normalizeStripeEventType('customer.subscription.deleted'), 'subscription.canceled');
    assert.equal(normalizeStripeEventType('charge.dispute.created'), 'dispute.opened');
    assert.equal(normalizeStripeEventType('radar.early_fraud_warning.created'), 'unknown');
  });

  it('agrees with itself about what each event is about', () => {
    assert.equal(subjectTypeFor('subscription.canceled'), 'subscription');
    assert.equal(subjectTypeFor('invoice.paid'), 'invoice');
    assert.equal(subjectTypeFor('payment.succeeded'), 'payment');
    assert.equal(subjectTypeFor('unknown'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Manual gateway
// ---------------------------------------------------------------------------

describe('manual gateway', () => {
  it('is always available, because it has no credentials to be missing', () => {
    const manual = new ManualPaymentProvider();
    assert.equal(manual.isConfigured(), true);
    assert.equal(manual.capabilities.webhooks, false);
    assert.equal(manual.capabilities.gatewayManagedRetries, false);
  });

  it('refuses to verify a webhook it can never receive', async () => {
    const manual = new ManualPaymentProvider();
    await assert.rejects(
      manual.verifyWebhook({ payload: '{}', headers: {} }),
      (error: unknown) => error instanceof GatewayError && error.code === 'unsupported_operation',
    );
  });

  it('derives a short, stable payer reference from the payment id', () => {
    assert.equal(manualReference('ckm1x2y3z4abcd1234'), 'JP-ABCD1234');
    assert.equal(manualReference('clzzzz00000012345678'), 'JP-12345678');
    assert.equal(manualReference('abc'), 'JP-ABC');
  });

  it('prints transfer instructions that always name the reference', () => {
    const bare = bankTransferInstructions('JP-12345678');
    assert.equal(bare.beneficiary, 'JobPilot AI Inc.');
    assert.ok(bare.steps.some((step) => step.includes('JP-12345678')));

    process.env.BANK_TRANSFER_EMAIL = 'ap@jobpilot.example';
    process.env.BANK_TRANSFER_INSTITUTION = '003';
    process.env.BANK_TRANSFER_TRANSIT = '12345';
    process.env.BANK_TRANSFER_ACCOUNT = '7654321';
    const configured = bankTransferInstructions('JP-12345678', 'USD');
    assert.equal(configured.currency, 'USD');
    assert.ok(configured.steps.some((step) => step.includes('ap@jobpilot.example')));
    assert.ok(configured.steps.some((step) => step.includes('7654321')));
  });
});

// ---------------------------------------------------------------------------
// Dunning: the schedule
// ---------------------------------------------------------------------------

const T0 = new Date('2026-03-01T12:00:00.000Z');

function dunningInput(overrides: Partial<DunningInput> = {}): DunningInput {
  return {
    invoiceId: 'inv_1',
    invoiceStatus: 'open',
    amountDueCents: 5900,
    state: 'scheduled',
    gatewayOwned: false,
    attemptCount: 0,
    firstFailedAt: T0,
    lastFailureCode: 'insufficient_funds',
    hasUsablePaymentMethod: true,
    ...overrides,
  };
}

describe('dunning schedule', () => {
  it('retries on days 0, 1, 3, 5 and 7', () => {
    assert.deepEqual([...DUNNING_SCHEDULE_DAYS], [0, 1, 3, 5, 7]);
    assert.equal(DEFAULT_DUNNING_POLICY.maxAttempts, 5);
    assert.equal(DEFAULT_DUNNING_POLICY.graceDays, DUNNING_GRACE_DAYS);

    const timeline = buildDunningTimeline(T0);
    assert.deepEqual(
      timeline.attempts.map((attempt) => attempt.attemptNumber),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      timeline.attempts.map((attempt) => attempt.scheduledFor.toISOString()),
      [0, 1, 3, 5, 7].map((day) => addDays(T0, day).toISOString()),
    );
    assert.equal(timeline.finalAttemptAt.getTime(), addDays(T0, 7).getTime());
    assert.equal(timeline.graceEndsAt.getTime(), addDays(T0, 10).getTime());
    assert.equal(timeline.suspendAt.getTime(), timeline.graceEndsAt.getTime());
  });

  it('measures a day as 24 hours of absolute time, not a wall clock', () => {
    // 2026-03-08 is the North American DST switch; the retry must still be
    // exactly 24h later, not 23h or 25h.
    const beforeDst = new Date('2026-03-07T12:00:00.000Z');
    assert.equal(addDays(beforeDst, 1).getTime() - beforeDst.getTime(), 86_400_000);
  });

  it('reads and sanitises the schedule column', () => {
    assert.deepEqual(parseDunningSchedule('[0,1,3,5,7]'), [0, 1, 3, 5, 7]);
    assert.deepEqual(parseDunningSchedule('[3,1,0,1]'), [0, 1, 3], 'sorted and de-duplicated');
    assert.deepEqual(parseDunningSchedule('[-2,0,1.5,4]'), [0, 4], 'negatives and fractions dropped');
    assert.deepEqual(parseDunningSchedule('not json'), [0, 1, 3, 5, 7], 'malformed falls back');
    assert.deepEqual(parseDunningSchedule(null), [0, 1, 3, 5, 7]);
    assert.deepEqual(parseDunningSchedule('[]'), [0, 1, 3, 5, 7], 'an empty schedule is not a policy');
    assert.equal(serializeDunningSchedule([0, 1, 3]), '[0,1,3]');
  });

  it('computes when each attempt is due, and nothing past the last', () => {
    assert.equal(scheduledAttemptAt(T0, 1)!.getTime(), T0.getTime());
    assert.equal(scheduledAttemptAt(T0, 4)!.getTime(), addDays(T0, 5).getTime());
    assert.equal(scheduledAttemptAt(T0, 5)!.getTime(), addDays(T0, 7).getTime());
    assert.equal(scheduledAttemptAt(T0, 6), null);
  });

  it('honours a custom policy', () => {
    const timeline = buildDunningTimeline(T0, { scheduleDays: [0, 2], graceDays: 1 });
    assert.equal(timeline.attempts.length, 2);
    assert.equal(timeline.graceEndsAt.getTime(), addDays(T0, 3).getTime());
  });

  it('builds a deterministic idempotency key per attempt', () => {
    assert.equal(dunningIdempotencyKey('inv_1', 1), 'jp_dun_inv_1_1');
    const keys = new Set([1, 2, 3, 4, 5].map((n) => dunningIdempotencyKey('inv_1', n)));
    assert.equal(keys.size, 5, 'each attempt must be a distinct charge to the gateway');
  });

  it('lists exactly the states the retry cron should scan', () => {
    assert.deepEqual([...DUNNING_ACTIONABLE_STATES], [
      'scheduled',
      'retrying',
      'awaiting_action',
      'grace',
    ]);
  });
});

describe('dunning failure classification', () => {
  it('separates soft declines from permanent ones', () => {
    assert.equal(classifyFailure('insufficient_funds'), 'soft');
    assert.equal(classifyFailure('card_declined'), 'soft');
    assert.equal(classifyFailure('stolen_card'), 'hard');
    assert.equal(classifyFailure('expired_card'), 'action_required');
    assert.equal(classifyFailure('api_error'), 'error');
    assert.equal(classifyFailure('INSTRUMENT_DECLINED'), 'soft', 'PayPal codes map too');
    assert.equal(classifyFailure(null), 'unknown');
    assert.equal(classifyFailure('brand_new_code'), 'unknown');
  });

  it('retries only what can succeed later', () => {
    assert.equal(isRetryable('soft'), true);
    assert.equal(isRetryable('unknown'), true, 'an unrecognised code gets the benefit of the doubt');
    assert.equal(isRetryable('error'), true);
    assert.equal(isRetryable('hard'), false);
    assert.equal(isRetryable('action_required'), false);
  });

  it('records the outcome the schema expects', () => {
    assert.equal(outcomeForFailure('soft'), 'soft_decline');
    assert.equal(outcomeForFailure('hard'), 'hard_decline');
    assert.equal(outcomeForFailure('error'), 'error');
  });
});

// ---------------------------------------------------------------------------
// Dunning: the decision
// ---------------------------------------------------------------------------

describe('computeNextAction', () => {
  it('charges the first attempt as soon as the invoice fails', () => {
    const decision = computeNextAction(dunningInput(), T0);
    assert.equal(decision.action, 'retry_payment');
    assert.equal(decision.dueNow, true);
    assert.equal(decision.attemptNumber, 1);
    assert.equal(decision.idempotencyKey, 'jp_dun_inv_1_1');
    assert.equal(decision.nextState, 'retrying');
    assert.equal(decision.stage, 'retrying');
    assert.equal(decision.runAt!.getTime(), addDays(T0, 1).getTime(), 'runAt points at attempt 2');
    assert.equal(decision.gracePeriodEndsAt!.getTime(), addDays(T0, 10).getTime());
  });

  it('waits, without charging, until the next attempt is due', () => {
    const decision = computeNextAction(
      dunningInput({ attemptCount: 1, state: 'retrying' }),
      addDays(T0, 0.5),
    );
    assert.equal(decision.action, 'wait');
    assert.equal(decision.dueNow, false);
    assert.equal(decision.idempotencyKey, null, 'a wait must never carry a charge key');
    assert.equal(decision.runAt!.getTime(), addDays(T0, 1).getTime());
  });

  it('charges attempt 2 the moment it comes due', () => {
    const decision = computeNextAction(
      dunningInput({ attemptCount: 1, state: 'retrying' }),
      addDays(T0, 1),
    );
    assert.equal(decision.action, 'retry_payment');
    assert.equal(decision.attemptNumber, 2);
    assert.equal(decision.idempotencyKey, 'jp_dun_inv_1_2');
    assert.equal(decision.notification?.channels.includes('email'), true);
  });

  it('flags the final attempt so the warning can say so', () => {
    const decision = computeNextAction(
      dunningInput({ attemptCount: 4, state: 'retrying' }),
      addDays(T0, 7),
    );
    assert.equal(decision.attemptNumber, 5);
    assert.equal(decision.notification?.template, 'dunning.final_warning');
    assert.equal(decision.notification?.severity, 'danger');
  });

  it('never charges when the gateway owns the retries', () => {
    const decision = computeNextAction(
      dunningInput({ gatewayOwned: true, attemptCount: 1, state: 'retrying' }),
      addDays(T0, 3),
    );
    assert.equal(decision.action, 'skip_gateway_owned');
    assert.equal(decision.suspendSubscription, false);
    assert.equal(decision.notification, null, 'the gateway sends its own dunning mail');
    // The access clock keeps running even though we never charge.
    assert.equal(decision.runAt!.getTime(), addDays(T0, 10).getTime());
  });

  it('still suspends a gateway-owned invoice once grace has ended', () => {
    const decision = computeNextAction(
      dunningInput({ gatewayOwned: true, attemptCount: 5, state: 'grace' }),
      addDays(T0, 10),
    );
    assert.equal(decision.action, 'suspend', 'a gateway that never recovers must not leave a free account');
  });

  it('does not retry a hard decline', () => {
    const decision = computeNextAction(
      dunningInput({ attemptCount: 1, state: 'retrying', lastFailureCode: 'stolen_card' }),
      addDays(T0, 3),
    );
    assert.equal(decision.action, 'request_payment_method');
    assert.equal(decision.nextState, 'awaiting_action');
    assert.equal(decision.idempotencyKey, null);
    assert.equal(decision.notification?.template, 'dunning.action_required');
    assert.match(decision.reason, /permanent/);
  });

  it('does not burn an attempt when there is no usable payment method', () => {
    const decision = computeNextAction(
      dunningInput({ attemptCount: 0, hasUsablePaymentMethod: false }),
      addDays(T0, 1),
    );
    assert.equal(decision.action, 'request_payment_method');
    assert.equal(decision.attemptNumber, null);
    assert.match(decision.reason, /no usable payment method/i);
  });

  it('enters grace once every retry is spent, and announces it once', () => {
    const entering = computeNextAction(
      dunningInput({ attemptCount: 5, state: 'retrying' }),
      addDays(T0, 7.5),
    );
    assert.equal(entering.action, 'enter_grace');
    assert.equal(entering.dueNow, true);
    assert.equal(entering.nextState, 'grace');
    assert.equal(entering.notification?.template, 'dunning.grace_started');
    assert.equal(entering.gracePeriodEndsAt!.getTime(), addDays(T0, 10).getTime());

    const already = computeNextAction(
      dunningInput({ attemptCount: 5, state: 'grace' }),
      addDays(T0, 8),
    );
    assert.equal(already.action, 'enter_grace');
    assert.equal(already.dueNow, false, 're-entering grace must not re-notify');
    assert.equal(already.notification, null);
  });

  it('recovers the moment the invoice is settled', () => {
    const paid = computeNextAction(
      dunningInput({ invoiceStatus: 'paid', amountDueCents: 0, attemptCount: 3, state: 'retrying' }),
      addDays(T0, 5),
    );
    assert.equal(paid.action, 'mark_recovered');
    assert.equal(paid.nextState, 'recovered');
    assert.equal(paid.stage, 'recovered');
    assert.equal(paid.suspendSubscription, false);
    assert.equal(paid.notification?.severity, 'success');
  });

  it('recovers even when the status has not caught up, if nothing is due', () => {
    const decision = computeNextAction(dunningInput({ amountDueCents: 0 }), addDays(T0, 2));
    assert.equal(decision.action, 'mark_recovered');
  });

  it('stops for a void or uncollectible invoice', () => {
    for (const invoiceStatus of ['void', 'uncollectible'] as const) {
      const decision = computeNextAction(dunningInput({ invoiceStatus }), addDays(T0, 2));
      assert.equal(decision.action, 'stop');
      assert.equal(decision.nextState, 'canceled');
      assert.equal(decision.suspendSubscription, false);
    }
  });

  it('stops once dunning is already closed out', () => {
    for (const state of ['recovered', 'canceled', 'exhausted'] as const) {
      const decision = computeNextAction(dunningInput({ state }), addDays(T0, 20));
      assert.equal(decision.action, 'stop', `${state} is terminal`);
    }
  });

  it('charges the retries a stalled cron never made', () => {
    // The cron was down for eleven days. The customer never got their five
    // attempts, so the right move is to charge, not to suspend.
    const decision = computeNextAction(dunningInput({ attemptCount: 0 }), addDays(T0, 11));
    assert.equal(decision.action, 'retry_payment');
    assert.equal(decision.attemptNumber, 1);
  });
});

// ---------------------------------------------------------------------------
// Dunning: grace-period boundaries
// ---------------------------------------------------------------------------

describe('grace period boundaries', () => {
  const graceEnd = addDays(T0, 10);

  it('treats grace as half-open: live until the instant it ends', () => {
    assert.equal(isWithinGrace(new Date(graceEnd.getTime() - 1), graceEnd), true);
    assert.equal(isWithinGrace(graceEnd, graceEnd), false, 'the boundary instant is outside grace');
    assert.equal(isWithinGrace(new Date(graceEnd.getTime() + 1), graceEnd), false);
    assert.equal(isWithinGrace(T0, null), false, 'no grace date means no grace');
  });

  it('keeps access one millisecond before the deadline', () => {
    const decision = computeNextAction(
      dunningInput({ attemptCount: 5, state: 'grace' }),
      new Date(graceEnd.getTime() - 1),
    );
    assert.equal(decision.action, 'enter_grace');
    assert.equal(decision.suspendSubscription, false);
  });

  it('suspends exactly at the deadline', () => {
    const decision = computeNextAction(dunningInput({ attemptCount: 5, state: 'grace' }), graceEnd);
    assert.equal(decision.action, 'suspend');
    assert.equal(decision.nextState, 'exhausted');
    assert.equal(decision.stage, 'suspended');
    assert.equal(decision.suspendSubscription, true);
    assert.equal(decision.notification?.template, 'dunning.suspended');
    assert.equal(decision.notification?.severity, 'danger');
  });

  it('stays suspended after the deadline', () => {
    const decision = computeNextAction(
      dunningInput({ attemptCount: 5, state: 'grace' }),
      new Date(graceEnd.getTime() + 1),
    );
    assert.equal(decision.action, 'suspend');
  });

  it('suspends a customer who never fixed a hard decline, but not before', () => {
    const blocked = dunningInput({ attemptCount: 1, state: 'awaiting_action', lastFailureCode: 'stolen_card' });

    const before = computeNextAction(blocked, new Date(graceEnd.getTime() - 1));
    assert.equal(before.action, 'request_payment_method');

    const at = computeNextAction(blocked, graceEnd);
    assert.equal(at.action, 'suspend');
  });

  it('respects a grace end that was persisted rather than recomputed', () => {
    // Support extended this customer's grace by two days; the stored date wins.
    const extended = addDays(T0, 12);
    const decision = computeNextAction(
      dunningInput({ attemptCount: 5, state: 'grace', gracePeriodEndsAt: extended }),
      graceEnd,
    );
    assert.equal(decision.action, 'enter_grace');
    assert.equal(decision.gracePeriodEndsAt!.getTime(), extended.getTime());
  });

  it('counts whole days of grace remaining, and never a negative one', () => {
    assert.equal(graceDaysRemaining(addDays(T0, 7), graceEnd), 3);
    assert.equal(graceDaysRemaining(addDays(T0, 9.5), graceEnd), 1);
    assert.equal(graceDaysRemaining(graceEnd, graceEnd), 0);
    assert.equal(graceDaysRemaining(addDays(T0, 30), graceEnd), 0);
    assert.equal(graceDaysRemaining(T0, null), 0);
  });

  it('honours a shortened grace policy end to end', () => {
    const policy = { scheduleDays: [0, 1], graceDays: 1 };
    const shortGraceEnd = addDays(T0, 2);

    const inGrace = computeNextAction(
      dunningInput({ attemptCount: 2, state: 'grace', policy }),
      new Date(shortGraceEnd.getTime() - 1),
    );
    assert.equal(inGrace.action, 'enter_grace');

    const suspended = computeNextAction(
      dunningInput({ attemptCount: 2, state: 'grace', policy }),
      shortGraceEnd,
    );
    assert.equal(suspended.action, 'suspend');
  });
});

// ---------------------------------------------------------------------------
// Dunning: folding results back in
// ---------------------------------------------------------------------------

describe('applyAttemptResult', () => {
  it('closes dunning out on a successful attempt', () => {
    const result = applyAttemptResult({
      invoiceId: 'inv_1',
      attemptNumber: 3,
      succeeded: true,
      firstFailedAt: T0,
    });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.nextState, 'recovered');
    assert.equal(result.nextRetryAt, null);
    assert.equal(result.gracePeriodEndsAt, null);
  });

  it('schedules the next retry after a soft decline', () => {
    const result = applyAttemptResult({
      invoiceId: 'inv_1',
      attemptNumber: 2,
      succeeded: false,
      failureCode: 'insufficient_funds',
      firstFailedAt: T0,
    });
    assert.equal(result.outcome, 'soft_decline');
    assert.equal(result.nextState, 'retrying');
    assert.equal(result.nextRetryAt!.getTime(), addDays(T0, 3).getTime());
  });

  it('moves to grace after the last scheduled attempt', () => {
    const result = applyAttemptResult({
      invoiceId: 'inv_1',
      attemptNumber: 5,
      succeeded: false,
      failureCode: 'insufficient_funds',
      firstFailedAt: T0,
    });
    assert.equal(result.nextState, 'grace');
    assert.equal(result.nextRetryAt!.getTime(), addDays(T0, 10).getTime());
  });

  it('stops retrying after a hard decline', () => {
    const result = applyAttemptResult({
      invoiceId: 'inv_1',
      attemptNumber: 1,
      succeeded: false,
      failureCode: 'stolen_card',
      firstFailedAt: T0,
    });
    assert.equal(result.outcome, 'hard_decline');
    assert.equal(result.nextState, 'awaiting_action');
    assert.equal(result.gracePeriodEndsAt!.getTime(), addDays(T0, 10).getTime());
  });

  it('does not consume an attempt when the gateway owns the retry', () => {
    const result = applyAttemptResult({
      invoiceId: 'inv_1',
      attemptNumber: 3,
      succeeded: false,
      gatewayOwned: true,
      firstFailedAt: T0,
    });
    assert.equal(result.outcome, 'skipped_gateway_owned');
    assert.equal(result.attemptCount, 2, 'a skip is not an attempt');
  });

  it('serialises notified channels for the attempt row', () => {
    assert.equal(serializeChannels(['in_app', 'email']), '["in_app","email"]');
    assert.equal(serializeChannels([]), '[]');
  });
});

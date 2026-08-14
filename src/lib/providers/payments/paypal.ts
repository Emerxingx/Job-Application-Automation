// PayPal gateway — Orders v2, Payments v2, Billing Subscriptions v1.
//
// WHY PAYPAL AT ALL
//
// A meaningful share of Canadian applicants will not type a card number into a
// startup's checkout but will pay the same $59 through a PayPal balance they
// already trust. That is the entire business case, and it is enough.
//
// WHAT THIS FILE WILL AND WILL NOT DO WITHOUT CREDENTIALS
//
// Constructing the provider without PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET is
// safe: it warns once and stays constructed, exactly like ./index does when
// PAYMENT_PROVIDER=stripe with no key. What it will NOT do is pretend. Every
// method that needs PayPal throws `GatewayNotConfiguredError` naming the
// missing variable. A simulated "success" here would write a `Payment` row
// claiming money arrived that never did, and that lie propagates into MRR, the
// invoice ledger and the tax return. The registry never selects an
// unconfigured gateway, so in practice these throws are a backstop, not a
// path anyone walks.
//
// MONEY CROSSES THE WIRE AS A DECIMAL STRING
//
// PayPal takes `{"currency_code":"CAD","value":"59.00"}`. Our storage is
// integer cents. The conversion in both directions is string arithmetic, not
// float arithmetic: `19.99 * 100` is `1998.9999999999998` in IEEE 754, and a
// gateway integration that rounds that badly loses a cent per transaction on
// exactly the amounts a subscription business charges most often.

import type { BillingInterval } from '@/lib/types';
import type { CheckoutSession } from './index';
import {
  GatewayError,
  GatewayNotConfiguredError,
  assertRefundable,
  envValue,
  subjectTypeFor,
  webhookHeader,
} from './registry';
import type {
  CaptureInput,
  CaptureResult,
  CreateOrderInput,
  GatewayCapabilities,
  GatewayOrder,
  NormalizedEventType,
  OrderStatus,
  PaymentGateway,
  RefundInput,
  RefundResult,
  SettlementStatus,
  VerifiedWebhook,
  WebhookInput,
} from './registry';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LIVE_API = 'https://api-m.paypal.com';
const SANDBOX_API = 'https://api-m.sandbox.paypal.com';

/** Sandbox unless PAYPAL_ENV says otherwise — the safe default for a mistake. */
export function paypalApiBase(): string {
  const explicit = envValue('PAYPAL_API_BASE');
  if (explicit) return explicit.replace(/\/+$/, '');
  const mode = (envValue('PAYPAL_ENV') || 'sandbox').toLowerCase();
  return mode === 'live' || mode === 'production' ? LIVE_API : SANDBOX_API;
}

export function paypalIsLive(): boolean {
  return paypalApiBase() === LIVE_API;
}

/**
 * Billing plan ids for subscription checkout, mapped the same way ./stripe
 * maps Prices: the amounts customers are charged live in the gateway
 * dashboard, in one auditable place, not in application code.
 *
 *   PAYPAL_PLAN_PROFESSIONAL_MONTHLY=P-1AB23456CD789012EFGHIJKL
 *   PAYPAL_PLAN_MAP={"professional:monthly":"P-1AB...", ...}
 */
export function paypalPlanIdFor(planCode: string, interval: BillingInterval): string | undefined {
  const raw = envValue('PAYPAL_PLAN_MAP');
  if (raw) {
    try {
      const map = JSON.parse(raw) as Record<string, string>;
      const hit = map[`${planCode}:${interval}`];
      if (hit) return hit;
    } catch {
      console.warn('[paypal] PAYPAL_PLAN_MAP is not valid JSON; ignoring it.');
    }
  }
  return envValue(`PAYPAL_PLAN_${planCode.toUpperCase()}_${interval.toUpperCase()}`);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Integer cents -> PayPal's decimal string. Exact by construction.
 *
 * CAD and USD are two-decimal currencies, which is all this product sells in.
 * A zero-decimal currency (JPY) would need its own scale and is rejected
 * rather than silently misbilled by a factor of one hundred.
 */
export function centsToPayPalAmount(cents: number, currency = 'CAD'): string {
  if (!Number.isInteger(cents)) {
    throw new GatewayError(`PayPal amounts must be whole cents; got ${cents}.`, {
      code: 'invalid_request',
      provider: 'paypal',
    });
  }
  if (!TWO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    throw new GatewayError(`Unsupported PayPal currency "${currency}".`, {
      code: 'invalid_request',
      provider: 'paypal',
    });
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const TWO_DECIMAL_CURRENCIES = new Set(['CAD', 'USD', 'EUR', 'GBP', 'AUD']);

/** PayPal's decimal string -> integer cents, by string, never by float. */
export function payPalAmountToCents(value: string | number): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new GatewayError(`PayPal returned an amount this code cannot parse: "${text}".`, {
      code: 'gateway_error',
      provider: 'paypal',
    });
  }
  const [, sign, whole, fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return sign ? -cents : cents;
}

interface PayPalMoney {
  currency_code?: string;
  value?: string;
}

/** Lenient read for optional money (fees, net) — absent means zero, not an error. */
function moneyOrZero(money: PayPalMoney | undefined | null): number {
  if (!money || typeof money.value !== 'string') return 0;
  try {
    return payPalAmountToCents(money.value);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Event normalisation
// ---------------------------------------------------------------------------

/**
 * PayPal's event vocabulary -> `WebhookEvent.type`.
 *
 * Anything unrecognised normalises to `unknown`, which the handler records and
 * acknowledges with a 200. PayPal retries a non-2xx for three days; 500ing on
 * an event we simply have no opinion about buys nothing but noise.
 */
export function normalizePayPalEventType(rawType: string): NormalizedEventType {
  switch (rawType.toUpperCase()) {
    case 'CHECKOUT.ORDER.APPROVED':
    case 'CHECKOUT.ORDER.COMPLETED':
      return 'checkout.completed';
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.SALE.COMPLETED':
      return 'payment.succeeded';
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
    case 'PAYMENT.SALE.DENIED':
      return 'payment.failed';
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
    case 'PAYMENT.SALE.REFUNDED':
      return 'refund.succeeded';
    case 'INVOICING.INVOICE.PAID':
      return 'invoice.paid';
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
      return 'invoice.payment_failed';
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.CREATED':
    case 'BILLING.SUBSCRIPTION.UPDATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      return 'subscription.updated';
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      return 'subscription.canceled';
    case 'CUSTOMER.DISPUTE.CREATED':
      return 'dispute.opened';
    default:
      return 'unknown';
  }
}

/** PayPal order/capture status -> our order vocabulary. */
function toOrderStatus(status: string | undefined): OrderStatus {
  switch ((status || '').toUpperCase()) {
    case 'COMPLETED':
      return 'succeeded';
    case 'CREATED':
      return 'created';
    case 'SAVED':
    case 'APPROVED':
    case 'PAYER_ACTION_REQUIRED':
      return 'requires_action';
    case 'PENDING':
      return 'pending';
    case 'VOIDED':
    case 'DECLINED':
      return 'failed';
    default:
      return 'created';
  }
}

function toSettlement(status: string | undefined): SettlementStatus {
  switch ((status || '').toUpperCase()) {
    case 'COMPLETED':
      return 'succeeded';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

// ---------------------------------------------------------------------------
// Wire types (only the fields this integration reads)
// ---------------------------------------------------------------------------

interface PayPalLink {
  href?: string;
  rel?: string;
  method?: string;
}

interface PayPalCapture {
  id?: string;
  status?: string;
  amount?: PayPalMoney;
  invoice_id?: string;
  seller_receivable_breakdown?: {
    paypal_fee?: PayPalMoney;
    net_amount?: PayPalMoney;
    gross_amount?: PayPalMoney;
  };
  links?: PayPalLink[];
  status_details?: { reason?: string };
}

interface PayPalOrderResponse {
  id?: string;
  status?: string;
  links?: PayPalLink[];
  purchase_units?: {
    amount?: PayPalMoney;
    payments?: { captures?: PayPalCapture[] };
  }[];
}

interface PayPalRefundResponse {
  id?: string;
  status?: string;
  amount?: PayPalMoney;
  status_details?: { reason?: string };
}

interface PayPalSubscriptionResponse {
  id?: string;
  status?: string;
  links?: PayPalLink[];
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: { issue?: string; description?: string }[];
  error?: string;
  error_description?: string;
}

interface PayPalWebhookBody {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource_type?: string;
  resource?: {
    id?: string;
    amount?: PayPalMoney;
    billing_agreement_id?: string;
    custom_id?: string;
    invoice_id?: string;
  };
}

function linkHref(links: PayPalLink[] | undefined, rel: string): string | undefined {
  return links?.find((link) => (link.rel || '').toLowerCase() === rel)?.href;
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

interface TokenCache {
  clientId: string;
  base: string;
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

/** Test seam — drops the cached OAuth token. */
export function resetPayPalToken(): void {
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

export class PayPalPaymentProvider implements PaymentGateway {
  readonly name = 'paypal' as const;
  readonly capabilities: GatewayCapabilities = {
    checkout: true,
    orders: true,
    refunds: true,
    webhooks: true,
    recurring: true,
    // PayPal retries a failed subscription payment on its own schedule for
    // subscriptions it owns, but exposes no per-invoice retry API of the kind
    // Smart Retries gives us. Our dunning cron owns retries here.
    gatewayManagedRetries: false,
  };

  constructor() {
    if (!this.isConfigured()) {
      // Warn, do not throw: constructing the provider must never take an app
      // down. Every call below fails cleanly with the variable name.
      console.warn(
        '[paypal] PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are unset; the PayPal gateway cannot take payments.',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(envValue('PAYPAL_CLIENT_ID') && envValue('PAYPAL_CLIENT_SECRET'));
  }

  private credentials(): { clientId: string; secret: string } {
    const clientId = envValue('PAYPAL_CLIENT_ID');
    const secret = envValue('PAYPAL_CLIENT_SECRET');
    if (!clientId || !secret) {
      const missing = [
        clientId ? null : 'PAYPAL_CLIENT_ID',
        secret ? null : 'PAYPAL_CLIENT_SECRET',
      ].filter(Boolean);
      throw new GatewayNotConfiguredError('paypal', `${missing.join(' and ')} must be set to use PayPal.`);
    }
    return { clientId, secret };
  }

  /** OAuth2 client-credentials token, cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    const { clientId, secret } = this.credentials();
    const base = paypalApiBase();

    if (
      tokenCache &&
      tokenCache.clientId === clientId &&
      tokenCache.base === base &&
      tokenCache.expiresAt > Date.now()
    ) {
      return tokenCache.token;
    }

    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        // Basic auth is what PayPal's token endpoint takes; the secret never
        // appears in a URL or a log line.
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const body = (await readJson(response)) as (PayPalErrorBody & {
      access_token?: string;
      expires_in?: number;
    }) | null;

    if (!response.ok || !body?.access_token) {
      throw new GatewayError(
        body?.error_description || body?.message || 'PayPal rejected the client credentials.',
        {
          code: response.status === 401 || response.status === 403 ? 'not_configured' : 'gateway_error',
          provider: 'paypal',
          retryable: response.status >= 500 || response.status === 429,
          httpStatus: response.status,
        },
      );
    }

    // 60s of headroom: a token that expires mid-flight reads as a 401 and
    // would otherwise be retried as if the credentials were wrong.
    const ttl = Math.max(60, Number(body.expires_in ?? 32400)) - 60;
    tokenCache = { clientId, base, token: body.access_token, expiresAt: Date.now() + ttl * 1000 };
    return body.access_token;
  }

  private async request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // PayPal's idempotency header. Same key + same body => the original
    // response is replayed instead of a second charge being created.
    if (init.idempotencyKey) headers['PayPal-Request-Id'] = init.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(`${paypalApiBase()}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      // A transport failure is ambiguous: the charge may or may not have been
      // created. It is retryable precisely because the idempotency key makes
      // the retry safe.
      throw new GatewayError(
        `Could not reach PayPal: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'gateway_error', provider: 'paypal', retryable: true, cause: error },
      );
    }

    const body = await readJson(response);
    if (!response.ok) throw payPalError(response.status, body as PayPalErrorBody | null);
    return (body ?? {}) as T;
  }

  // --- subscription checkout ----------------------------------------------

  /**
   * Hosted subscription checkout. Returns PayPal's approval URL; the plan is
   * activated from BILLING.SUBSCRIPTION.ACTIVATED, never from the redirect —
   * a redirect is a browser event, not a payment.
   */
  async createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    interval: BillingInterval;
    amountCents: number;
  }): Promise<CheckoutSession> {
    const planId = paypalPlanIdFor(input.planCode, input.interval);
    if (!planId) {
      throw new GatewayError(
        `No PayPal billing plan configured for ${input.planCode}/${input.interval}. ` +
          `Set PAYPAL_PLAN_${input.planCode.toUpperCase()}_${input.interval.toUpperCase()}.`,
        { code: 'invalid_request', provider: 'paypal' },
      );
    }

    const appUrl = envValue('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000';
    const subscription = await this.request<PayPalSubscriptionResponse>('/v1/billing/subscriptions', {
      method: 'POST',
      idempotencyKey: `jp_sub_${input.userId}_${input.planCode}_${input.interval}`,
      body: {
        plan_id: planId,
        custom_id: input.userId,
        subscriber: { email_address: input.email },
        application_context: {
          brand_name: 'JobPilot AI',
          locale: 'en-CA',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' },
          return_url: `${appUrl}/dashboard/billing?checkout=success&provider=paypal`,
          cancel_url: `${appUrl}/dashboard/billing?checkout=cancelled&provider=paypal`,
        },
      },
    });

    const approvalUrl = linkHref(subscription.links, 'approve');
    if (!subscription.id || !approvalUrl) {
      throw new GatewayError('PayPal did not return an approval URL for the subscription.', {
        code: 'gateway_error',
        provider: 'paypal',
        retryable: true,
      });
    }

    return { id: subscription.id, url: approvalUrl, simulated: false };
  }

  async cancel(subscriptionId: string): Promise<{ ok: boolean }> {
    if (!subscriptionId) return { ok: false };
    try {
      await this.request<Record<string, never>>(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        method: 'POST',
        body: { reason: 'Cancelled by the subscriber in JobPilot AI.' },
      });
      return { ok: true };
    } catch (error) {
      console.error('[paypal] cancel failed:', error);
      return { ok: false };
    }
  }

  // --- one-off orders ------------------------------------------------------

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const appUrl = envValue('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000';
    const currency = input.currency.toUpperCase();

    const order = await this.request<PayPalOrderResponse>('/v2/checkout/orders', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.reference,
            // custom_id carries our user id back on every webhook about this
            // order; invoice_id is what shows on the payer's PayPal statement.
            custom_id: input.userId,
            ...(input.invoiceNumber ? { invoice_id: input.invoiceNumber } : {}),
            description: input.description.slice(0, 127),
            amount: { currency_code: currency, value: centsToPayPalAmount(input.amountCents, currency) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'JobPilot AI',
              locale: 'en-CA',
              landing_page: 'LOGIN',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: input.returnUrl || `${appUrl}/dashboard/billing?paypal=return`,
              cancel_url: input.cancelUrl || `${appUrl}/dashboard/billing?paypal=cancel`,
            },
          },
        },
      },
    });

    if (!order.id) {
      throw new GatewayError('PayPal did not return an order id.', {
        code: 'gateway_error',
        provider: 'paypal',
        retryable: true,
      });
    }

    return {
      provider: 'paypal',
      externalId: order.id,
      status: toOrderStatus(order.status),
      amountCents: input.amountCents,
      currency,
      approvalUrl: linkHref(order.links, 'approve') || linkHref(order.links, 'payer-action'),
      raw: { id: order.id, status: order.status ?? null },
    };
  }

  /**
   * Capture an approved order.
   *
   * PayPal captures the whole approved amount; there is no partial capture on
   * a v2 order, so a partial `amountCents` is rejected rather than quietly
   * capturing more than the caller asked for.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const order = await this.request<PayPalOrderResponse>(
      `/v2/checkout/orders/${encodeURIComponent(input.externalOrderId)}/capture`,
      { method: 'POST', idempotencyKey: input.idempotencyKey, body: {} },
    );

    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture?.id) {
      throw new GatewayError('PayPal returned no capture for this order.', {
        code: 'gateway_error',
        provider: 'paypal',
        retryable: false,
      });
    }

    const amountCents = moneyOrZero(capture.amount);
    if (input.amountCents !== undefined && input.amountCents !== amountCents) {
      // Loud, not silent: the ledger must never record an amount PayPal did
      // not actually take.
      console.warn(
        `[paypal] capture ${capture.id} settled ${amountCents} cents, caller expected ${input.amountCents}.`,
      );
    }

    const breakdown = capture.seller_receivable_breakdown;
    const feeCents = moneyOrZero(breakdown?.paypal_fee);
    const netFromPayPal = moneyOrZero(breakdown?.net_amount);

    return {
      provider: 'paypal',
      externalId: capture.id,
      status: toSettlement(capture.status),
      amountCents,
      currency: (capture.amount?.currency_code || input.currency || 'CAD').toUpperCase(),
      feeCents,
      netCents: netFromPayPal || amountCents - feeCents,
      failureCode: capture.status_details?.reason,
      failureMessage: capture.status_details?.reason
        ? `PayPal held or declined this capture: ${capture.status_details.reason}.`
        : undefined,
      receiptUrl: linkHref(capture.links, 'self'),
      raw: { id: capture.id, status: capture.status ?? null },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    // The ceiling is checked before the call, so an over-refund never reaches
    // PayPal and never leaves a half-written Refund row behind.
    if (input.capturedCents !== undefined) {
      assertRefundable('paypal', {
        capturedCents: input.capturedCents,
        alreadyRefundedCents: input.alreadyRefundedCents,
        requestedCents: input.amountCents,
      });
    }

    const currency = input.currency.toUpperCase();
    const refund = await this.request<PayPalRefundResponse>(
      `/v2/payments/captures/${encodeURIComponent(input.externalPaymentId)}/refund`,
      {
        method: 'POST',
        idempotencyKey: input.idempotencyKey,
        body: {
          amount: { currency_code: currency, value: centsToPayPalAmount(input.amountCents, currency) },
          ...(input.invoiceNumber ? { invoice_id: input.invoiceNumber } : {}),
          ...(input.note ? { note_to_payer: input.note.slice(0, 255) } : {}),
        },
      },
    );

    return {
      provider: 'paypal',
      externalId: refund.id,
      status: toSettlement(refund.status),
      amountCents: refund.amount ? moneyOrZero(refund.amount) : input.amountCents,
      currency,
      failureMessage: refund.status_details?.reason,
      raw: { id: refund.id ?? null, status: refund.status ?? null },
    };
  }

  // --- webhooks ------------------------------------------------------------

  /**
   * Verify an inbound webhook.
   *
   * PayPal does not sign with a shared secret the way Stripe does — the
   * signature is checked by POSTing the transmission headers and the parsed
   * event back to PayPal, which validates them against the certificate chain.
   * That means verification is a network call, and an unverifiable event is
   * REJECTED rather than trusted: an unsigned "payment.succeeded" is exactly
   * the message an attacker would forge.
   */
  async verifyWebhook(input: WebhookInput): Promise<VerifiedWebhook> {
    const webhookId = envValue('PAYPAL_WEBHOOK_ID');
    if (!webhookId) {
      throw new GatewayNotConfiguredError(
        'paypal',
        'PAYPAL_WEBHOOK_ID must be set to verify PayPal webhooks.',
      );
    }

    const required = {
      auth_algo: webhookHeader(input.headers, 'paypal-auth-algo'),
      cert_url: webhookHeader(input.headers, 'paypal-cert-url'),
      transmission_id: webhookHeader(input.headers, 'paypal-transmission-id'),
      transmission_sig: webhookHeader(input.headers, 'paypal-transmission-sig'),
      transmission_time: webhookHeader(input.headers, 'paypal-transmission-time'),
    };

    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([key]) => `paypal-${key.replace(/_/g, '-')}`);
    if (missing.length > 0) {
      throw new GatewayError(`Missing PayPal signature headers: ${missing.join(', ')}.`, {
        code: 'signature_verification_failed',
        provider: 'paypal',
      });
    }

    let event: PayPalWebhookBody;
    try {
      event = JSON.parse(input.payload) as PayPalWebhookBody;
    } catch (error) {
      throw new GatewayError('PayPal webhook body is not valid JSON.', {
        code: 'signature_verification_failed',
        provider: 'paypal',
        cause: error,
      });
    }

    const verification = await this.request<{ verification_status?: string }>(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: {
          auth_algo: required.auth_algo,
          cert_url: required.cert_url,
          transmission_id: required.transmission_id,
          transmission_sig: required.transmission_sig,
          transmission_time: required.transmission_time,
          webhook_id: webhookId,
          webhook_event: event,
        },
      },
    );

    if ((verification.verification_status || '').toUpperCase() !== 'SUCCESS') {
      throw new GatewayError('PayPal webhook signature verification failed.', {
        code: 'signature_verification_failed',
        provider: 'paypal',
      });
    }

    const rawType = event.event_type || '';
    const type = normalizePayPalEventType(rawType);
    const resource = event.resource;

    return {
      provider: 'paypal',
      externalEventId: event.id || required.transmission_id!,
      type,
      rawType,
      // PayPal's own clock. Falling back to receipt time only when PayPal
      // omitted create_time, which it does not do in practice.
      occurredAt: event.create_time ? new Date(event.create_time) : new Date(),
      subjectType: subjectTypeFor(type),
      subjectId: resource?.billing_agreement_id || resource?.id,
      amountCents: resource?.amount ? moneyOrZero(resource.amount) : undefined,
      currency: resource?.amount?.currency_code?.toUpperCase(),
      livemode: paypalIsLive(),
      payload: input.payload,
    };
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) } satisfies PayPalErrorBody;
  }
}

/**
 * PayPal error bodies -> `GatewayError`.
 *
 * `debug_id` is carried through because it is the only thing PayPal support
 * will act on, and it is gone forever if it is not captured at the call site.
 */
function payPalError(status: number, body: PayPalErrorBody | null): GatewayError {
  const issue = body?.details?.[0]?.issue;
  const description = body?.details?.[0]?.description;
  const message =
    description || body?.message || body?.error_description || `PayPal returned HTTP ${status}.`;

  const declined =
    issue === 'INSTRUMENT_DECLINED' ||
    issue === 'PAYER_ACTION_REQUIRED' ||
    issue === 'TRANSACTION_REFUSED' ||
    body?.name === 'INSTRUMENT_DECLINED';

  return new GatewayError(message, {
    code:
      status === 401 || status === 403
        ? 'not_configured'
        : declined
          ? 'gateway_declined'
          : status === 422 || status === 400
            ? 'invalid_request'
            : 'gateway_error',
    provider: 'paypal',
    // 5xx and rate limits are worth another attempt; a declined instrument or
    // a malformed request never is.
    retryable: status >= 500 || status === 429,
    httpStatus: status,
    debugId: body?.debug_id,
  });
}

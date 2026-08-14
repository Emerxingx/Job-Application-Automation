// Payment gateway registry.
//
// WHY A REGISTRY AND NOT ONE MORE `if (env === 'x')`
//
// `getPaymentProvider()` in ./index answers "which single gateway is this
// deployment using?". That question stops being answerable the moment a
// business takes card payments in Canada through Stripe, PayPal for the
// applicants who refuse to hand a card to a startup, and bank transfer for the
// enterprise accounts that pay on net-30 terms. All three are live at once,
// and every stored `Payment.provider` says which one moved the money.
//
// So this file holds a REGISTRY: many gateways registered by name, each one
// reporting whether it is actually configured, resolved on demand and cached.
// ./index is untouched and still works — a deployment that only wants Stripe
// keeps setting PAYMENT_PROVIDER=stripe and nothing here changes for it.
//
// THREE RULES THAT ARE STRUCTURAL, NOT CONVENTIONAL
//
// 1. A GATEWAY NAME IS A DATABASE VALUE. `GatewayName` is exactly the set the
//    schema's `provider` discriminator allows — stripe | paypal | manual. A
//    name that cannot be persisted is not a gateway; the dev-only `mock`
//    provider stays in ./index where it belongs, outside the ledger.
//
// 2. CHARGES MAY FALL BACK. REFUNDS MAY NOT. If Stripe is down, a new charge
//    can be taken through PayPal — the customer does not care which rails the
//    money rode. A refund is the opposite: money must return down the rails it
//    came up, to the payment instrument it came from. `resolveForRefund()`
//    therefore never falls back, and says so loudly when the gateway that took
//    the money is unavailable.
//
// 3. AN UNCONFIGURED GATEWAY IS NEVER SELECTED. Missing credentials are a
//    registration-time fact (`unavailableReason()`), not a runtime surprise.
//    Selection skips such gateways silently; asking for one by name throws a
//    typed error naming the environment variable that is missing.

import type { BillingInterval } from '@/lib/types';
// Type-only: keeps this module free of a runtime cycle with ./index, which is
// the legacy single-provider entry point.
import type { CheckoutSession, PaymentProvider } from './index';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The gateway discriminator. These strings are written verbatim to
 * `Payment.provider`, `Invoice.provider`, `Refund.provider`,
 * `WebhookEvent.provider` and `PaymentMethod.provider`, so this union and the
 * schema comments are one vocabulary, not two.
 */
export type GatewayName = 'stripe' | 'paypal' | 'manual';

export const GATEWAY_NAMES: readonly GatewayName[] = ['stripe', 'paypal', 'manual'];

export function isGatewayName(value: unknown): value is GatewayName {
  return typeof value === 'string' && (GATEWAY_NAMES as readonly string[]).includes(value);
}

/**
 * Documented fallback order for NEW charges.
 *
 * Stripe first (lowest fees, gateway-managed retries), PayPal second (works
 * without a card on file), manual last. `manual` is the terminal fallback and
 * is deliberately un-failable: it takes no network call, so "every gateway is
 * down" degrades to "we issue an invoice and a human confirms the transfer"
 * rather than to a 500 on the pricing page.
 *
 * Override per deployment with PAYMENT_GATEWAY_FALLBACK="paypal,stripe".
 */
export const DEFAULT_FALLBACK_ORDER: readonly GatewayName[] = ['stripe', 'paypal', 'manual'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable failure classes every gateway raises. */
export type GatewayErrorCode =
  | 'not_configured'
  | 'unknown_gateway'
  | 'no_gateway_available'
  | 'unsupported_operation'
  | 'invalid_refund_amount'
  | 'invalid_request'
  | 'signature_verification_failed'
  | 'gateway_declined'
  | 'gateway_error';

/**
 * One error type for the whole provider layer.
 *
 * `retryable` is the field callers actually branch on: a 500 from PayPal is
 * worth another attempt, a declined card is not, and dunning needs to tell
 * those apart without string-matching messages.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly provider?: GatewayName;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly debugId?: string;

  constructor(
    message: string,
    options: {
      code?: GatewayErrorCode;
      provider?: GatewayName;
      retryable?: boolean;
      httpStatus?: number;
      debugId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = options.code ?? 'gateway_error';
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.debugId = options.debugId;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Raised when a gateway is asked to work without its credentials. */
export class GatewayNotConfiguredError extends GatewayError {
  constructor(provider: GatewayName, message: string) {
    super(message, { code: 'not_configured', provider, retryable: false });
    this.name = 'GatewayNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * What a gateway can actually do.
 *
 * Selection is capability-aware: a caller that needs a refund must not be
 * handed a gateway that cannot refund just because it happens to be first in
 * the fallback order.
 */
export interface GatewayCapabilities {
  /** Hosted checkout for a subscription plan. */
  checkout: boolean;
  /** One-off order create + capture, for invoices and top-ups. */
  orders: boolean;
  refunds: boolean;
  /** Signed inbound events. `manual` has none. */
  webhooks: boolean;
  /** The gateway itself keeps the subscription schedule. */
  recurring: boolean;
  /**
   * The gateway retries failed payments on its own (Stripe Smart Retries).
   * This is the value that must land in `DunningState.gatewayOwned` — when it
   * is true our cron must never retry, or the customer is charged twice.
   */
  gatewayManagedRetries: boolean;
}

export type OrderStatus = 'created' | 'requires_action' | 'pending' | 'succeeded' | 'failed';
export type SettlementStatus = 'succeeded' | 'pending' | 'failed';

export interface CreateOrderInput {
  /** Our own reference, usually an `Invoice.id`. Echoed back by the gateway. */
  reference: string;
  userId: string;
  email?: string;
  /** Integer cents. Never a float — see the money rule in the schema. */
  amountCents: number;
  /** ISO 4217, uppercase. CAD or USD in this product. */
  currency: string;
  description: string;
  invoiceId?: string;
  invoiceNumber?: string;
  /**
   * Persisted on `PaymentAttempt.idempotencyKey` BEFORE the network call, so a
   * retry after a timeout cannot double-charge.
   */
  idempotencyKey: string;
  returnUrl?: string;
  cancelUrl?: string;
  /** Gateway customer id, when one already exists for this user. */
  externalCustomerId?: string;
}

export interface GatewayOrder {
  provider: GatewayName;
  /** Gateway order/intent id. Becomes `Payment.externalId`. */
  externalId: string;
  status: OrderStatus;
  amountCents: number;
  currency: string;
  /** Where to send the payer when the gateway needs their approval. */
  approvalUrl?: string;
  /** Client-side confirmation secret, when the gateway uses one. */
  clientSecret?: string;
  /** Free-form gateway payload, stored on `PaymentAttempt.responseSnapshot`. */
  raw: Record<string, unknown>;
}

export interface CaptureInput {
  /** The order/intent id returned by `createOrder`. */
  externalOrderId: string;
  /** Partial capture, in cents. Omit to capture the full authorised amount. */
  amountCents?: number;
  currency?: string;
  idempotencyKey: string;
}

export interface CaptureResult {
  provider: GatewayName;
  /** The capture/charge id. This is what a refund is issued against. */
  externalId: string;
  status: SettlementStatus;
  amountCents: number;
  currency: string;
  /** Gateway fee as reported. Material at $29/mo — always recorded. */
  feeCents: number;
  netCents: number;
  failureCode?: string;
  failureMessage?: string;
  receiptUrl?: string;
  raw: Record<string, unknown>;
}

export interface RefundInput {
  /** The capture id from `CaptureResult.externalId` (`Payment.externalId`). */
  externalPaymentId: string;
  amountCents: number;
  currency: string;
  /** Schema vocabulary: duplicate | fraudulent | requested_by_customer | goodwill | error. */
  reason?: string;
  /** Deterministic `jp_ref_<creditNoteId>`; persisted before the call. */
  idempotencyKey: string;
  /**
   * What was captured, and what has already been sent back. Supplied by the
   * caller from the `Payment` row so the ceiling is enforced BEFORE any money
   * moves — see `validateRefundAmount`.
   */
  capturedCents?: number;
  alreadyRefundedCents?: number;
  /** Shown to the payer where the gateway supports it. */
  note?: string;
  invoiceNumber?: string;
}

export interface RefundResult {
  provider: GatewayName;
  externalId?: string;
  status: SettlementStatus;
  amountCents: number;
  currency: string;
  failureMessage?: string;
  raw: Record<string, unknown>;
}

/** `WebhookEvent.type` — normalised so handlers never learn a gateway's dialect. */
export type NormalizedEventType =
  | 'checkout.completed'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'refund.succeeded'
  | 'dispute.opened'
  | 'unknown';

export const NORMALIZED_EVENT_TYPES: readonly NormalizedEventType[] = [
  'checkout.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'subscription.updated',
  'subscription.canceled',
  'payment.succeeded',
  'payment.failed',
  'refund.succeeded',
  'dispute.opened',
  'unknown',
];

/** Headers as a `Request` gives them, or as a plain object in a test. */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export interface WebhookInput {
  /** The RAW body. Never a re-serialised object — signatures cover bytes. */
  payload: string;
  headers: HeaderSource;
}

/** Exactly the columns a `WebhookEvent` row needs, and nothing else. */
export interface VerifiedWebhook {
  provider: GatewayName;
  externalEventId: string;
  type: NormalizedEventType;
  rawType: string;
  /** The GATEWAY's timestamp, not receipt time — the ordering guard keys on it. */
  occurredAt: Date;
  subjectType?: 'subscription' | 'invoice' | 'payment';
  subjectId?: string;
  amountCents?: number;
  currency?: string;
  livemode: boolean;
  /** The verified raw body, stored only after the signature checked out. */
  payload: string;
}

/**
 * The multi-gateway contract.
 *
 * It extends the existing `PaymentProvider` rather than replacing it, so every
 * gateway registered here is still usable anywhere `getPaymentProvider()` is
 * used today.
 */
export interface PaymentGateway extends PaymentProvider {
  readonly name: GatewayName;
  readonly capabilities: GatewayCapabilities;

  /** True when credentials are present and the gateway can reach its API. */
  isConfigured(): boolean;

  createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    interval: BillingInterval;
    amountCents: number;
  }): Promise<CheckoutSession>;

  cancel(subscriptionId: string): Promise<{ ok: boolean }>;

  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  verifyWebhook(input: WebhookInput): Promise<VerifiedWebhook>;
}

// ---------------------------------------------------------------------------
// Shared helpers every gateway uses
// ---------------------------------------------------------------------------

/** Read an env var, treating "" as unset — .env ships empty placeholders. */
export function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Case-insensitive header read that works for `Headers` and plain objects. */
export function webhookHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value[0];
    return value ?? undefined;
  }
  return undefined;
}

export interface RefundValidation {
  ok: boolean;
  /** The largest refund still permitted against this payment, in cents. */
  refundableCents: number;
  reason?: string;
}

/**
 * The refund ceiling.
 *
 * You cannot refund more than was captured, and you cannot refund what has
 * already been refunded. Gateways enforce this too, but discovering it from a
 * gateway error means a `Refund` row already exists in a half-known state; and
 * the `manual` gateway has no gateway to enforce it at all. So it is enforced
 * here, in one pure function, before any money moves.
 *
 * Cents are integers by construction (see the schema's money rule): a
 * fractional request is a bug upstream, not a rounding opportunity.
 */
export function validateRefundAmount(input: {
  capturedCents: number;
  alreadyRefundedCents?: number;
  requestedCents: number;
}): RefundValidation {
  const captured = Math.trunc(input.capturedCents);
  const already = Math.max(0, Math.trunc(input.alreadyRefundedCents ?? 0));
  const requested = input.requestedCents;

  if (!Number.isFinite(captured) || captured <= 0) {
    return { ok: false, refundableCents: 0, reason: 'Nothing was captured on this payment.' };
  }
  if (!Number.isInteger(requested)) {
    return {
      ok: false,
      refundableCents: Math.max(0, captured - already),
      reason: 'Refund amounts are whole cents.',
    };
  }
  if (requested <= 0) {
    return {
      ok: false,
      refundableCents: Math.max(0, captured - already),
      reason: 'A refund must be greater than zero.',
    };
  }

  const refundable = Math.max(0, captured - Math.min(already, captured));
  if (refundable === 0) {
    return { ok: false, refundableCents: 0, reason: 'This payment is already fully refunded.' };
  }
  if (requested > refundable) {
    return {
      ok: false,
      refundableCents: refundable,
      reason:
        `Cannot refund ${formatCents(requested)}: only ${formatCents(refundable)} of ` +
        `${formatCents(captured)} remains refundable.`,
    };
  }
  return { ok: true, refundableCents: refundable };
}

/** Throwing form of `validateRefundAmount`, used inside gateway `refund()`. */
export function assertRefundable(
  provider: GatewayName,
  input: { capturedCents: number; alreadyRefundedCents?: number; requestedCents: number },
): RefundValidation {
  const result = validateRefundAmount(input);
  if (!result.ok) {
    throw new GatewayError(result.reason ?? 'Refund amount is not valid.', {
      code: 'invalid_refund_amount',
      provider,
      retryable: false,
    });
  }
  return result;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface GatewayRegistration {
  name: GatewayName;
  /** Shown in /console. */
  label: string;
  capabilities: GatewayCapabilities;
  /**
   * Null when the gateway is ready to use; otherwise the human-readable reason
   * it is not — normally the environment variable that is missing. Called on
   * every selection, so it must be cheap and must not touch the network.
   */
  unavailableReason(): string | null;
  /** Built once per process and cached by the registry. */
  create(): PaymentGateway;
}

interface HealthRecord {
  downUntil: number;
  reason: string;
}

const registrations = new Map<GatewayName, GatewayRegistration>();
const instances = new Map<GatewayName, PaymentGateway>();
const health = new Map<GatewayName, HealthRecord>();
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Register (or replace) a gateway. Replacing drops any cached instance. */
export function registerGateway(registration: GatewayRegistration): void {
  registrations.set(registration.name, registration);
  instances.delete(registration.name);
}

export function unregisterGateway(name: GatewayName): void {
  registrations.delete(name);
  instances.delete(name);
  health.delete(name);
}

export function getGatewayRegistration(name: GatewayName): GatewayRegistration | undefined {
  return registrations.get(name);
}

// --- runtime health --------------------------------------------------------

/**
 * Take a gateway out of rotation after an outage.
 *
 * Credentials tell us whether a gateway COULD work; only a failed call tells us
 * whether it currently does. A caller that catches a retryable `GatewayError`
 * marks the gateway down, and selection routes around it until the window
 * expires — without a deploy, and without a human noticing at 3am.
 */
export function markGatewayDown(name: GatewayName, reason: string, seconds = 300): void {
  health.set(name, { downUntil: Date.now() + Math.max(1, seconds) * 1000, reason });
  console.warn(`[payments] gateway "${name}" marked down for ${seconds}s: ${reason}`);
}

export function markGatewayUp(name: GatewayName): void {
  health.delete(name);
}

export function gatewayHealth(name: GatewayName): {
  healthy: boolean;
  reason: string | null;
  downUntil: Date | null;
} {
  const record = health.get(name);
  if (!record) return { healthy: true, reason: null, downUntil: null };
  if (record.downUntil <= Date.now()) {
    health.delete(name);
    return { healthy: true, reason: null, downUntil: null };
  }
  return { healthy: false, reason: record.reason, downUntil: new Date(record.downUntil) };
}

// --- selection -------------------------------------------------------------

/** The configured fallback order, always ending at a terminal gateway. */
export function fallbackOrder(): GatewayName[] {
  const configured = envValue('PAYMENT_GATEWAY_FALLBACK');
  let order: GatewayName[];

  if (configured) {
    const parsed = configured.split(',').map((part) => part.trim().toLowerCase());
    const valid = parsed.filter(isGatewayName);
    const invalid = parsed.filter((part) => part.length > 0 && !isGatewayName(part));
    if (invalid.length > 0) {
      warnOnce(
        `fallback:${invalid.join(',')}`,
        `[payments] PAYMENT_GATEWAY_FALLBACK lists unknown gateways: ${invalid.join(', ')}; ignoring them.`,
      );
    }
    order = [...new Set(valid)];
  } else {
    order = [...DEFAULT_FALLBACK_ORDER];
  }

  // Anything registered but unlisted still gets a chance, after the listed
  // ones — a new gateway should not be invisible because an old env var
  // predates it. `manual` sorts last: it is the safety net, not a preference.
  for (const name of registrations.keys()) {
    if (!order.includes(name)) order.push(name);
  }
  return order.sort((a, b) => Number(a === 'manual') - Number(b === 'manual'));
}

function capabilitiesSatisfied(
  registration: GatewayRegistration,
  required: readonly (keyof GatewayCapabilities)[],
): boolean {
  return required.every((capability) => registration.capabilities[capability]);
}

/** Why a gateway cannot be used right now, or null when it can. */
export function gatewayBlockedReason(
  name: GatewayName,
  required: readonly (keyof GatewayCapabilities)[] = [],
): string | null {
  const registration = registrations.get(name);
  if (!registration) return `No gateway named "${name}" is registered.`;

  const missing = registration.unavailableReason();
  if (missing) return missing;

  const status = gatewayHealth(name);
  if (!status.healthy) return `Temporarily unavailable: ${status.reason}`;

  const unmet = required.filter((capability) => !registration.capabilities[capability]);
  if (unmet.length > 0) return `The ${registration.label} gateway does not support ${unmet.join(', ')}.`;

  return null;
}

export function isGatewayEnabled(name: GatewayName): boolean {
  return gatewayBlockedReason(name) === null;
}

/** Every usable gateway, in fallback order. */
export function enabledGatewayNames(
  required: readonly (keyof GatewayCapabilities)[] = [],
): GatewayName[] {
  return fallbackOrder().filter((name) => gatewayBlockedReason(name, required) === null);
}

export interface GatewayStatus {
  name: GatewayName;
  label: string;
  capabilities: GatewayCapabilities;
  configured: boolean;
  healthy: boolean;
  downUntil: Date | null;
  /** Null when usable; otherwise why not. Safe to show staff. */
  blockedReason: string | null;
  isDefault: boolean;
}

/** Everything /console needs to render the gateway table. */
export function listGateways(): GatewayStatus[] {
  const preferred = defaultGatewayName();
  return fallbackOrder()
    .map((name) => registrations.get(name))
    .filter((registration): registration is GatewayRegistration => Boolean(registration))
    .map((registration) => {
      const status = gatewayHealth(registration.name);
      return {
        name: registration.name,
        label: registration.label,
        capabilities: registration.capabilities,
        configured: registration.unavailableReason() === null,
        healthy: status.healthy,
        downUntil: status.downUntil,
        blockedReason: gatewayBlockedReason(registration.name),
        isDefault: registration.name === preferred,
      };
    });
}

/**
 * Which gateway new charges go to, in priority order:
 *
 *   1. PAYMENT_GATEWAY — the explicit multi-gateway choice.
 *   2. PAYMENT_PROVIDER — the existing single-provider variable, so a Stripe
 *      deployment needs no new configuration.
 *   3. The first usable gateway in the fallback order.
 *   4. `manual`, which is always usable.
 *
 * A named-but-unusable gateway logs once and falls through rather than
 * throwing: a missing Stripe key must not take checkout offline entirely.
 */
export function defaultGatewayName(): GatewayName {
  for (const variable of ['PAYMENT_GATEWAY', 'PAYMENT_PROVIDER'] as const) {
    const raw = envValue(variable)?.toLowerCase();
    if (!raw) continue;
    // "mock" is the documented dev value for ./index and has no ledger
    // identity, so it is skipped here without complaint.
    if (raw === 'mock') continue;
    if (!isGatewayName(raw)) {
      warnOnce(`${variable}:${raw}`, `[payments] ${variable}="${raw}" is not a known gateway; ignoring it.`);
      continue;
    }
    const blocked = gatewayBlockedReason(raw);
    if (!blocked) return raw;
    warnOnce(
      `${variable}:blocked:${raw}`,
      `[payments] ${variable}="${raw}" cannot be used (${blocked}); falling back.`,
    );
  }

  const [first] = enabledGatewayNames();
  return first ?? 'manual';
}

/**
 * Resolve one gateway by name. Throws when it is unknown or unusable — use
 * this when the caller genuinely needs THAT gateway (refunds, webhooks,
 * cancelling a subscription the gateway owns).
 */
export function resolveGateway(name: GatewayName): PaymentGateway {
  const blocked = gatewayBlockedReason(name);
  if (blocked) {
    const registration = registrations.get(name);
    if (!registration) {
      throw new GatewayError(blocked, { code: 'unknown_gateway', retryable: false });
    }
    throw new GatewayNotConfiguredError(name, blocked);
  }

  const cached = instances.get(name);
  if (cached) return cached;

  // Non-null: gatewayBlockedReason() already proved the registration exists.
  const created = registrations.get(name)!.create();
  instances.set(name, created);
  return created;
}

export interface GatewayResolution {
  gateway: PaymentGateway;
  name: GatewayName;
  /** What the caller asked for, when it asked for anything. */
  requested: GatewayName | null;
  fellBack: boolean;
  /** Why the requested gateway was passed over. Worth logging. */
  reason: string | null;
}

/**
 * Resolve a gateway for a NEW charge, falling back on an outage.
 *
 * Never use this for refunds, captures of an existing order, or webhook
 * verification: those belong to whichever gateway already holds the money.
 */
export function resolveGatewayWithFallback(
  preferred?: GatewayName | null,
  options: { require?: readonly (keyof GatewayCapabilities)[] } = {},
): GatewayResolution {
  const required = options.require ?? [];
  const requested = preferred ?? null;
  const first = preferred ?? defaultGatewayName();

  const firstBlocked = gatewayBlockedReason(first, required);
  if (!firstBlocked) {
    return { gateway: resolveGateway(first), name: first, requested, fellBack: false, reason: null };
  }

  for (const name of fallbackOrder()) {
    if (name === first) continue;
    if (gatewayBlockedReason(name, required) !== null) continue;
    console.warn(`[payments] "${first}" unavailable (${firstBlocked}); routing to "${name}".`);
    return { gateway: resolveGateway(name), name, requested, fellBack: true, reason: firstBlocked };
  }

  throw new GatewayError(
    `No payment gateway is available${required.length ? ` with ${required.join(', ')}` : ''}. ` +
      `Last reason: ${firstBlocked}`,
    { code: 'no_gateway_available', retryable: true },
  );
}

/**
 * Resolve the gateway that must handle a refund. NO FALLBACK, by design:
 * money returns down the rails it arrived on, or it does not return yet.
 */
export function resolveForRefund(provider: string): PaymentGateway {
  if (!isGatewayName(provider)) {
    throw new GatewayError(`Cannot refund a payment taken through "${provider}".`, {
      code: 'unknown_gateway',
      retryable: false,
    });
  }
  const blocked = gatewayBlockedReason(provider, ['refunds']);
  if (blocked) {
    throw new GatewayNotConfiguredError(
      provider,
      `This payment was taken through ${provider} and can only be refunded there, but ${blocked}`,
    );
  }
  return resolveGateway(provider);
}

/** The default gateway instance. The registry equivalent of `getPaymentProvider()`. */
export function getGateway(): PaymentGateway {
  return resolveGatewayWithFallback().gateway;
}

// ---------------------------------------------------------------------------
// Built-in gateways
// ---------------------------------------------------------------------------

/**
 * Every built-in is registered with a LAZY `create()`.
 *
 * Nothing here imports ./stripe, ./paypal or ./manual at module scope. That is
 * what keeps the Stripe SDK out of a mock deployment's bundle (the existing
 * behaviour of ./index) and what keeps this module free of an import cycle
 * with the gateways, which import these types back.
 */
function registerBuiltIns(): void {
  registerGateway({
    name: 'stripe',
    label: 'Stripe',
    capabilities: {
      checkout: true,
      orders: true,
      refunds: true,
      webhooks: true,
      recurring: true,
      // Smart Retries. DunningState.gatewayOwned must be set from this.
      gatewayManagedRetries: true,
    },
    unavailableReason: () =>
      envValue('STRIPE_SECRET_KEY') ? null : 'STRIPE_SECRET_KEY is not set.',
    create: () => new StripeGateway(),
  });

  registerGateway({
    name: 'paypal',
    label: 'PayPal',
    capabilities: {
      checkout: true,
      orders: true,
      refunds: true,
      webhooks: true,
      recurring: true,
      gatewayManagedRetries: false,
    },
    unavailableReason: () => {
      const missing: string[] = [];
      if (!envValue('PAYPAL_CLIENT_ID')) missing.push('PAYPAL_CLIENT_ID');
      if (!envValue('PAYPAL_CLIENT_SECRET')) missing.push('PAYPAL_CLIENT_SECRET');
      return missing.length === 0 ? null : `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.`;
    },
    create: () => {
      const { PayPalPaymentProvider } = require('./paypal') as typeof import('./paypal');
      return new PayPalPaymentProvider();
    },
  });

  registerGateway({
    name: 'manual',
    label: 'Manual / bank transfer',
    capabilities: {
      checkout: true,
      orders: true,
      // A finance person sends the money back; the ledger still records it.
      refunds: true,
      webhooks: false,
      recurring: false,
      gatewayManagedRetries: false,
    },
    // The terminal fallback. It has no credentials, so it cannot be missing any.
    unavailableReason: () => null,
    create: () => {
      const { ManualPaymentProvider } = require('./manual') as typeof import('./manual');
      return new ManualPaymentProvider();
    },
  });
}

/** Test seam — clears instances, health and warnings, then re-registers built-ins. */
export function resetGatewayRegistry(): void {
  registrations.clear();
  instances.clear();
  health.clear();
  warned.clear();
  registerBuiltIns();
}

registerBuiltIns();

// ---------------------------------------------------------------------------
// Stripe adapter
// ---------------------------------------------------------------------------

/**
 * Adapts the existing `StripePaymentProvider` to the multi-gateway contract.
 *
 * ./stripe is deliberately untouched: it already owns hosted checkout and
 * cancellation and is in production use. This class adds the four operations
 * the registry needs on top of the client that file already exports, and loads
 * it lazily so the SDK never enters a deployment that does not use Stripe.
 */
class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;
  readonly capabilities: GatewayCapabilities = {
    checkout: true,
    orders: true,
    refunds: true,
    webhooks: true,
    recurring: true,
    gatewayManagedRetries: true,
  };

  private base: PaymentProvider | null = null;

  private module(): typeof import('./stripe') {
    return require('./stripe') as typeof import('./stripe');
  }

  private provider(): PaymentProvider {
    if (!this.base) this.base = new (this.module().StripePaymentProvider)();
    return this.base;
  }

  isConfigured(): boolean {
    return Boolean(envValue('STRIPE_SECRET_KEY'));
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new GatewayNotConfiguredError('stripe', 'STRIPE_SECRET_KEY is not set.');
    }
  }

  async createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    interval: BillingInterval;
    amountCents: number;
  }): Promise<CheckoutSession> {
    this.assertConfigured();
    return this.provider().createCheckout(input);
  }

  async cancel(subscriptionId: string): Promise<{ ok: boolean }> {
    if (!this.isConfigured()) return { ok: false };
    return this.provider().cancel(subscriptionId);
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    this.assertConfigured();
    const stripe = this.module().stripeClient();
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          description: input.description,
          ...(input.externalCustomerId ? { customer: input.externalCustomerId } : {}),
          ...(input.email ? { receipt_email: input.email } : {}),
          automatic_payment_methods: { enabled: true },
          metadata: {
            userId: input.userId,
            reference: input.reference,
            ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
            ...(input.invoiceNumber ? { invoiceNumber: input.invoiceNumber } : {}),
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        provider: 'stripe',
        externalId: intent.id,
        status: stripeIntentStatus(intent.status),
        amountCents: intent.amount,
        currency: intent.currency.toUpperCase(),
        clientSecret: intent.client_secret ?? undefined,
        raw: { id: intent.id, status: intent.status },
      };
    } catch (error) {
      throw wrapStripeError(error, 'Could not start a Stripe payment.');
    }
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    this.assertConfigured();
    const stripe = this.module().stripeClient();
    try {
      const intent = await stripe.paymentIntents.capture(
        input.externalOrderId,
        {
          ...(input.amountCents !== undefined ? { amount_to_capture: input.amountCents } : {}),
          expand: ['latest_charge.balance_transaction'],
        },
        { idempotencyKey: input.idempotencyKey },
      );

      // `latest_charge` is a string unless expanded; the balance transaction
      // inside it is where Stripe reports the fee it actually took.
      const charge =
        intent.latest_charge && typeof intent.latest_charge === 'object'
          ? (intent.latest_charge as {
              id: string;
              receipt_url?: string | null;
              balance_transaction?: unknown;
            })
          : null;
      const balance =
        charge && charge.balance_transaction && typeof charge.balance_transaction === 'object'
          ? (charge.balance_transaction as { fee?: number; net?: number })
          : null;

      const amountCents = intent.amount_received || intent.amount;
      const feeCents = balance?.fee ?? 0;

      return {
        provider: 'stripe',
        externalId: charge?.id ?? intent.id,
        status: stripeSettlement(intent.status),
        amountCents,
        currency: intent.currency.toUpperCase(),
        feeCents,
        netCents: balance?.net ?? amountCents - feeCents,
        receiptUrl: charge?.receipt_url ?? undefined,
        raw: { id: intent.id, status: intent.status },
      };
    } catch (error) {
      throw wrapStripeError(error, 'Could not capture the Stripe payment.');
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.assertConfigured();
    if (input.capturedCents !== undefined) {
      assertRefundable('stripe', {
        capturedCents: input.capturedCents,
        alreadyRefundedCents: input.alreadyRefundedCents,
        requestedCents: input.amountCents,
      });
    }

    const stripe = this.module().stripeClient();
    try {
      // Stripe accepts either a payment intent or a charge id; both are ids we
      // may have stored on Payment.externalId depending on the flow.
      const target = input.externalPaymentId.startsWith('ch_')
        ? { charge: input.externalPaymentId }
        : { payment_intent: input.externalPaymentId };

      const refund = await stripe.refunds.create(
        {
          ...target,
          amount: input.amountCents,
          reason: stripeRefundReason(input.reason),
          metadata: { idempotencyKey: input.idempotencyKey },
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        provider: 'stripe',
        externalId: refund.id,
        status: refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' ? 'failed' : 'pending',
        amountCents: refund.amount,
        currency: refund.currency.toUpperCase(),
        failureMessage: refund.failure_reason ?? undefined,
        raw: { id: refund.id, status: refund.status },
      };
    } catch (error) {
      throw wrapStripeError(error, 'Could not refund the Stripe payment.');
    }
  }

  async verifyWebhook(input: WebhookInput): Promise<VerifiedWebhook> {
    this.assertConfigured();
    const signature = webhookHeader(input.headers, 'stripe-signature');
    if (!signature) {
      throw new GatewayError('Missing the stripe-signature header.', {
        code: 'signature_verification_failed',
        provider: 'stripe',
      });
    }

    let event: ReturnType<typeof import('./stripe').constructWebhookEvent>;
    try {
      event = this.module().constructWebhookEvent(input.payload, signature);
    } catch (error) {
      throw new GatewayError(
        error instanceof Error ? error.message : 'Stripe signature verification failed.',
        { code: 'signature_verification_failed', provider: 'stripe', cause: error },
      );
    }

    // The event object is a union of every Stripe resource; we read only the
    // handful of fields every member happens to share.
    const object = (event.data?.object ?? {}) as unknown as Record<string, unknown>;
    const type = normalizeStripeEventType(event.type);

    return {
      provider: 'stripe',
      externalEventId: event.id,
      type,
      rawType: event.type,
      // Stripe timestamps are unix seconds, and this is the gateway's clock —
      // the ordering guard is meaningless with our own receipt time.
      occurredAt: new Date(event.created * 1000),
      subjectType: subjectTypeFor(type),
      subjectId: typeof object.id === 'string' ? object.id : undefined,
      amountCents: numberOrUndefined(object.amount ?? object.amount_paid ?? object.amount_due),
      currency: typeof object.currency === 'string' ? object.currency.toUpperCase() : undefined,
      livemode: Boolean(event.livemode),
      payload: input.payload,
    };
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Which entity a normalised event is about — `WebhookEvent.subjectType`. */
export function subjectTypeFor(type: NormalizedEventType): 'subscription' | 'invoice' | 'payment' | undefined {
  switch (type) {
    case 'subscription.updated':
    case 'subscription.canceled':
      return 'subscription';
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return 'invoice';
    case 'payment.succeeded':
    case 'payment.failed':
    case 'refund.succeeded':
    case 'dispute.opened':
    case 'checkout.completed':
      return 'payment';
    default:
      return undefined;
  }
}

/** Stripe's event vocabulary -> ours. Unknown types are recorded, never thrown. */
export function normalizeStripeEventType(rawType: string): NormalizedEventType {
  switch (rawType) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return 'checkout.completed';
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return 'invoice.paid';
    case 'invoice.payment_failed':
    case 'invoice.marked_uncollectible':
      return 'invoice.payment_failed';
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return 'subscription.updated';
    case 'customer.subscription.deleted':
      return 'subscription.canceled';
    case 'payment_intent.succeeded':
    case 'charge.succeeded':
      return 'payment.succeeded';
    case 'payment_intent.payment_failed':
    case 'charge.failed':
      return 'payment.failed';
    case 'charge.refunded':
    case 'refund.created':
      return 'refund.succeeded';
    case 'charge.dispute.created':
      return 'dispute.opened';
    default:
      return 'unknown';
  }
}

function stripeIntentStatus(status: string): OrderStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
      return 'requires_action';
    case 'processing':
      return 'pending';
    case 'canceled':
      return 'failed';
    default:
      return 'created';
  }
}

function stripeSettlement(status: string): SettlementStatus {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'canceled') return 'failed';
  return 'pending';
}

/**
 * Our reason vocabulary is wider than Stripe's enum (`goodwill` and `error`
 * have no Stripe equivalent), so anything outside the enum is sent as
 * `requested_by_customer` and the real reason lives on our `Refund.reason`.
 */
function stripeRefundReason(reason?: string): 'duplicate' | 'fraudulent' | 'requested_by_customer' {
  if (reason === 'duplicate' || reason === 'fraudulent') return reason;
  return 'requested_by_customer';
}

function wrapStripeError(error: unknown, fallbackMessage: string): GatewayError {
  if (error instanceof GatewayError) return error;
  const detail = error as { type?: string; code?: string; statusCode?: number; message?: string };
  const status = typeof detail?.statusCode === 'number' ? detail.statusCode : undefined;
  const retryable =
    detail?.type === 'StripeConnectionError' ||
    detail?.type === 'StripeAPIError' ||
    (status !== undefined && (status >= 500 || status === 429));

  return new GatewayError(detail?.message || fallbackMessage, {
    code: detail?.type === 'StripeCardError' ? 'gateway_declined' : 'gateway_error',
    provider: 'stripe',
    retryable,
    httpStatus: status,
    cause: error,
  });
}

// Manual gateway — bank transfer, wire, cheque, Interac e-Transfer.
//
// WHY A "GATEWAY" WITH NO GATEWAY
//
// Enterprise buyers do not put a $6,000 annual seat block on a corporate card;
// procurement sends a purchase order and accounts payable pays an invoice on
// net-30 terms. Today that money arrives in a bank account and someone tells
// the product about it by hand. Modelling that as a first-class gateway rather
// than as a special case has one large consequence: the offline money lands in
// the SAME ledger as the card money. `Payment`, `PaymentAllocation`, MRR and
// the revenue rollups do not learn a second shape, and no report has to
// remember to add "…plus the wires".
//
// The exchange is:
//
//   1. `createOrder` (or `createCheckout`) records an INTENT — a `Payment` row
//      with status `pending`, plus the reference the payer must quote.
//   2. Money moves through a channel this code cannot see.
//   3. A staff member confirms receipt: `markManualPaymentPaid()` flips the
//      payment to `succeeded`, allocates it against an invoice, and updates
//      the invoice's cached totals in the SAME transaction.
//
// STEP 2 IS NOT AUTOMATABLE, SO STEP 3 IS ATTRIBUTED. Every confirmation
// records which staff member said the money arrived, because "the system said
// so" is not an answer an auditor accepts about a payment nobody can see.
//
// NOTHING HERE ACTIVATES A PLAN ON ITS OWN. `createCheckout` returns
// `simulated: false` precisely so the caller does NOT activate the
// subscription: an unpaid bank transfer that grants access is a free product.
// Activation happens on confirmation, and only when the caller asks for it.

import { db } from '@/lib/db';
import type { BillingInterval } from '@/lib/types';
import { activatePlan } from '@/lib/subscription';
import type { CheckoutSession } from './index';
import { GatewayError, assertRefundable, envValue } from './registry';
import type {
  CaptureInput,
  CaptureResult,
  CreateOrderInput,
  GatewayCapabilities,
  GatewayOrder,
  PaymentGateway,
  RefundInput,
  RefundResult,
  VerifiedWebhook,
  WebhookInput,
} from './registry';

// ---------------------------------------------------------------------------
// Payment instructions
// ---------------------------------------------------------------------------

export interface BankTransferInstructions {
  beneficiary: string;
  /** Interac e-Transfer address — how most Canadian SMBs actually pay. */
  email?: string;
  institution?: string;
  transit?: string;
  accountNumber?: string;
  swift?: string;
  currency: string;
  /** The memo the payer must quote so finance can match the deposit. */
  reference: string;
  /** Plain-language steps, ready to render or drop into an email. */
  steps: string[];
}

/**
 * The reference a payer quotes on the transfer.
 *
 * Derived from the payment id rather than stored, so it cannot drift from the
 * row it points at, and short enough that a person retypes it correctly into a
 * bank's 35-character memo field.
 */
export function manualReference(paymentId: string): string {
  return `JP-${paymentId.slice(-8).toUpperCase()}`;
}

/** Bank details, from the environment. Absent details are simply not printed. */
export function bankTransferInstructions(reference: string, currency = 'CAD'): BankTransferInstructions {
  const beneficiary = envValue('BANK_TRANSFER_BENEFICIARY') || 'JobPilot AI Inc.';
  const email = envValue('BANK_TRANSFER_EMAIL');
  const institution = envValue('BANK_TRANSFER_INSTITUTION');
  const transit = envValue('BANK_TRANSFER_TRANSIT');
  const accountNumber = envValue('BANK_TRANSFER_ACCOUNT');
  const swift = envValue('BANK_TRANSFER_SWIFT');

  const steps: string[] = [];
  if (email) steps.push(`Send an Interac e-Transfer to ${email}.`);
  if (institution && transit && accountNumber) {
    steps.push(
      `Or wire to ${beneficiary} — institution ${institution}, transit ${transit}, account ${accountNumber}${
        swift ? `, SWIFT ${swift}` : ''
      }.`,
    );
  }
  if (steps.length === 0) {
    // A deployment that has not configured bank details still gets a coherent
    // page: finance sends the details with the invoice.
    steps.push(`Contact billing for ${beneficiary}'s transfer details.`);
  }
  steps.push(`Quote ${reference} in the memo — payments without it take days longer to match.`);
  steps.push('Access opens as soon as our team confirms the transfer, usually within one business day.');

  return { beneficiary, email, institution, transit, accountNumber, swift, currency, reference, steps };
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

export class ManualPaymentProvider implements PaymentGateway {
  readonly name = 'manual' as const;
  readonly capabilities: GatewayCapabilities = {
    checkout: true,
    orders: true,
    // A person sends the money back, but the ledger still records it here.
    refunds: true,
    webhooks: false,
    recurring: false,
    gatewayManagedRetries: false,
  };

  /** Always true. There are no credentials to be missing — that is the point. */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Record the intent to pay for a plan by transfer.
   *
   * `simulated: false` is deliberate: the caller must NOT activate the plan.
   * Nothing has been paid yet.
   */
  async createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    interval: BillingInterval;
    amountCents: number;
  }): Promise<CheckoutSession> {
    const payment = await recordManualIntent({
      userId: input.userId,
      amountCents: input.amountCents,
      currency: 'CAD',
      description: `Bank transfer for the ${input.planCode} plan (${input.interval})`,
      idempotencyKey: `jp_manual_${input.userId}_${input.planCode}_${input.interval}`,
    });

    const params = new URLSearchParams({
      transfer: manualReference(payment.id),
      plan: input.planCode,
      interval: input.interval,
    });
    return { id: payment.id, url: `/dashboard/billing?${params.toString()}`, simulated: false };
  }

  /** There is no gateway-side subscription to cancel; the caller owns the record. */
  async cancel(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const payment = await recordManualIntent({
      userId: input.userId,
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      invoiceId: input.invoiceId,
    });

    return {
      provider: 'manual',
      externalId: payment.id,
      status: payment.status === 'succeeded' ? 'succeeded' : 'pending',
      amountCents: payment.amountCents,
      currency: payment.currency,
      raw: {
        reference: manualReference(payment.id),
        instructions: bankTransferInstructions(manualReference(payment.id), payment.currency),
      },
    };
  }

  /**
   * Report whether the transfer has arrived.
   *
   * Capture cannot be forced — that is what "manual" means — so this reads the
   * intent rather than settling it, and returns `pending` until a staff member
   * has confirmed receipt. A poller can call it safely on any schedule.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const payment = await db.payment.findUnique({ where: { id: input.externalOrderId } });
    if (!payment) {
      throw new GatewayError(`No manual payment intent ${input.externalOrderId}.`, {
        code: 'invalid_request',
        provider: 'manual',
      });
    }

    return {
      provider: 'manual',
      externalId: payment.id,
      status: payment.status === 'succeeded' ? 'succeeded' : payment.status === 'failed' ? 'failed' : 'pending',
      amountCents: payment.amountCents,
      currency: payment.currency,
      feeCents: payment.feeCents,
      netCents: payment.netCents || payment.amountCents - payment.feeCents,
      failureMessage:
        payment.status === 'succeeded'
          ? undefined
          : `Awaiting confirmation of transfer ${manualReference(payment.id)}.`,
      raw: { id: payment.id, status: payment.status },
    };
  }

  /**
   * Validate a manual refund.
   *
   * Nothing here moves money: a human sends the transfer back. What this does
   * is enforce the ceiling that a card gateway would otherwise enforce for us,
   * reading the captured and already-refunded amounts straight from the ledger
   * when the caller does not supply them. Returning `pending` is the honest
   * answer — the refund is owed, not yet sent.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    let capturedCents = input.capturedCents;
    let alreadyRefundedCents = input.alreadyRefundedCents;

    if (capturedCents === undefined) {
      const payment = await db.payment.findUnique({ where: { id: input.externalPaymentId } });
      if (!payment) {
        throw new GatewayError(`No manual payment ${input.externalPaymentId} to refund.`, {
          code: 'invalid_request',
          provider: 'manual',
        });
      }
      if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
        throw new GatewayError(
          `Manual payment ${manualReference(payment.id)} has not been confirmed as received, so there is nothing to refund.`,
          { code: 'invalid_refund_amount', provider: 'manual' },
        );
      }
      capturedCents = payment.amountCents;
      alreadyRefundedCents = payment.amountRefundedCents;
    }

    assertRefundable('manual', {
      capturedCents,
      alreadyRefundedCents,
      requestedCents: input.amountCents,
    });

    return {
      provider: 'manual',
      status: 'pending',
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      failureMessage: undefined,
      raw: {
        instruction: 'Finance must send this refund by transfer and then mark the refund settled.',
        reference: manualReference(input.externalPaymentId),
      },
    };
  }

  /** Manual payments have no inbound events. A webhook here is a routing bug. */
  async verifyWebhook(_input: WebhookInput): Promise<VerifiedWebhook> {
    throw new GatewayError('The manual gateway receives no webhooks.', {
      code: 'unsupported_operation',
      provider: 'manual',
    });
  }
}

// ---------------------------------------------------------------------------
// Ledger writes
// ---------------------------------------------------------------------------

export interface ManualIntentInput {
  userId: string;
  amountCents: number;
  currency?: string;
  description: string;
  /**
   * Deterministic key. Persisted on `PaymentAttempt` BEFORE anything else, so
   * a double-submitted checkout produces one intent, not two invoices' worth
   * of confusion for whoever reconciles the bank statement.
   */
  idempotencyKey: string;
  invoiceId?: string;
}

/**
 * Record a pending manual payment, idempotently.
 *
 * The uniqueness lives on `PaymentAttempt.idempotencyKey`, so concurrency is
 * settled by the database rather than by a read-then-write race: the loser of
 * the race catches the unique violation and returns the winner's row.
 */
export async function recordManualIntent(input: ManualIntentInput) {
  const existing = await db.paymentAttempt.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { payment: true },
  });
  if (existing) return existing.payment;

  const currency = (input.currency || 'CAD').toUpperCase();

  try {
    return await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          userId: input.userId,
          provider: 'manual',
          // No gateway id exists for a bank transfer. NULL, never "" — an
          // empty string collides on the second row under the
          // @@unique([provider, externalId]) index.
          externalId: null,
          kind: 'manual',
          method: 'bank_transfer',
          status: 'pending',
          amountCents: input.amountCents,
          currency,
          netCents: input.amountCents,
          description: input.description,
        },
      });

      await tx.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          attemptNumber: 1,
          idempotencyKey: input.idempotencyKey,
          provider: 'manual',
          status: 'pending',
          requestSnapshot: JSON.stringify({
            amountCents: input.amountCents,
            currency,
            invoiceId: input.invoiceId ?? null,
            reference: manualReference(payment.id),
          }),
        },
      });

      return payment;
    });
  } catch (error) {
    // P2002: another request won the race on the idempotency key.
    const attempt = await db.paymentAttempt.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { payment: true },
    });
    if (attempt) return attempt.payment;
    throw error;
  }
}

export interface MarkPaidInput {
  paymentId: string;
  /** `User.id` of the staff member confirming receipt. Attribution is mandatory. */
  staffId: string;
  staffEmail: string;
  /** Allocate the money against this invoice and refresh its cached totals. */
  invoiceId?: string;
  /** Partial allocation, in cents. Defaults to the whole payment. */
  allocateCents?: number;
  /** When the money actually landed, if that is not now. */
  receivedAt?: Date;
  /** Bank reference, cheque number — whatever finance can point at later. */
  externalReference?: string;
  /** Activate this plan once the money is recorded. */
  activate?: { planCode: string; interval: BillingInterval };
}

export interface MarkPaidResult {
  paymentId: string;
  amountCents: number;
  allocatedCents: number;
  invoiceId: string | null;
  invoicePaid: boolean;
  planActivated: boolean;
}

/**
 * Staff confirmation: the transfer arrived.
 *
 * The payment flip, the allocation and the invoice's cached totals are ONE
 * transaction, because `Invoice.amountPaidCents` is a cache over
 * `PaymentAllocation` and the schema requires a cache to be written with the
 * rows it summarises. The cache is RECOMPUTED from the allocations rather than
 * incremented, so running this twice cannot drift the total.
 *
 * Plan activation happens after the commit, on purpose. `activatePlan` is an
 * upsert, so a crash between the two steps leaves money correctly recorded and
 * entitlement re-runnable — the failure mode that costs a support ticket
 * rather than the one that costs the money.
 */
export async function markManualPaymentPaid(input: MarkPaidInput): Promise<MarkPaidResult> {
  const receivedAt = input.receivedAt ?? new Date();

  const result = await db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
    if (!payment) {
      throw new GatewayError(`No manual payment ${input.paymentId}.`, {
        code: 'invalid_request',
        provider: 'manual',
      });
    }
    if (payment.provider !== 'manual') {
      throw new GatewayError(
        `Payment ${input.paymentId} was taken through ${payment.provider}; only manual payments are confirmed by hand.`,
        { code: 'invalid_request', provider: 'manual' },
      );
    }

    const alreadySucceeded = payment.status === 'succeeded';
    if (!alreadySucceeded) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'succeeded',
          succeededAt: receivedAt,
          receivedAt,
          capturedAt: receivedAt,
          // The bank reference doubles as the duplicate guard: @@unique([provider,
          // externalId]) means the same deposit cannot be confirmed onto two
          // payments. NULL when finance has no reference to give.
          externalId: input.externalReference || null,
        },
      });

      await tx.paymentAttempt.updateMany({
        where: { paymentId: payment.id, status: 'pending' },
        data: {
          status: 'succeeded',
          finishedAt: receivedAt,
          responseSnapshot: JSON.stringify({
            confirmedBy: input.staffEmail,
            staffId: input.staffId,
            receivedAt: receivedAt.toISOString(),
            externalReference: input.externalReference ?? null,
          }),
        },
      });
    }

    let allocatedCents = 0;
    let invoicePaid = false;

    if (input.invoiceId) {
      const invoice = await tx.invoice.findUnique({ where: { id: input.invoiceId } });
      if (!invoice) {
        throw new GatewayError(`No invoice ${input.invoiceId} to allocate against.`, {
          code: 'invalid_request',
          provider: 'manual',
        });
      }

      const existing = await tx.paymentAllocation.findFirst({
        where: { paymentId: payment.id, invoiceId: invoice.id },
      });

      if (existing) {
        allocatedCents = existing.amountCents;
      } else {
        const outstanding = Math.max(
          0,
          invoice.totalCents - invoice.amountPaidCents - invoice.amountCreditedCents,
        );
        const requested = input.allocateCents ?? Math.min(payment.amountCents, outstanding);

        if (requested <= 0) {
          throw new GatewayError(`Invoice ${invoice.number ?? invoice.id} has nothing outstanding.`, {
            code: 'invalid_request',
            provider: 'manual',
          });
        }
        if (requested > payment.amountCents) {
          throw new GatewayError(
            `Cannot allocate ${requested} cents from a ${payment.amountCents} cent payment.`,
            { code: 'invalid_request', provider: 'manual' },
          );
        }
        if (requested > outstanding) {
          throw new GatewayError(
            `Allocating ${requested} cents exceeds the ${outstanding} cents outstanding on invoice ${
              invoice.number ?? invoice.id
            }.`,
            { code: 'invalid_request', provider: 'manual' },
          );
        }

        await tx.paymentAllocation.create({
          data: { paymentId: payment.id, invoiceId: invoice.id, amountCents: requested },
        });
        allocatedCents = requested;
      }

      // Recompute, never increment: the cache is a projection of the rows.
      const sum = await tx.paymentAllocation.aggregate({
        where: { invoiceId: invoice.id },
        _sum: { amountCents: true },
      });
      const paidCents = sum._sum.amountCents ?? 0;
      const dueCents = Math.max(0, invoice.totalCents - paidCents - invoice.amountCreditedCents);
      invoicePaid = dueCents === 0;

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaidCents: paidCents,
          amountDueCents: dueCents,
          ...(invoicePaid && invoice.status === 'open'
            ? { status: 'paid', paidAt: receivedAt, dunningStage: 'recovered', nextAttemptAt: null }
            : {}),
        },
      });
    }

    return {
      paymentId: payment.id,
      amountCents: payment.amountCents,
      allocatedCents,
      invoiceId: input.invoiceId ?? null,
      invoicePaid,
      userId: payment.userId,
    };
  });

  let planActivated = false;
  if (input.activate) {
    await activatePlan(result.userId, input.activate.planCode, input.activate.interval);
    planActivated = true;
  }

  return {
    paymentId: result.paymentId,
    amountCents: result.amountCents,
    allocatedCents: result.allocatedCents,
    invoiceId: result.invoiceId,
    invoicePaid: result.invoicePaid,
    planActivated,
  };
}

/**
 * Give up on a transfer that never arrived.
 *
 * Failed, not deleted: the intent is evidence that a quote was issued, and the
 * finance team reads that history when the customer says they paid.
 */
export async function markManualPaymentFailed(input: {
  paymentId: string;
  staffId: string;
  staffEmail: string;
  reason: string;
}): Promise<void> {
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: input.paymentId },
      data: {
        status: 'failed',
        failedAt: now,
        failureCode: 'transfer_not_received',
        failureMessage: input.reason,
      },
    });
    await tx.paymentAttempt.updateMany({
      where: { paymentId: input.paymentId, status: 'pending' },
      data: {
        status: 'failed',
        finishedAt: now,
        errorType: 'validation_error',
        errorCode: 'transfer_not_received',
        errorMessage: input.reason,
        responseSnapshot: JSON.stringify({ closedBy: input.staffEmail, staffId: input.staffId }),
      },
    });
  });
}

/** The /console queue: transfers we are waiting on, oldest first. */
export async function listPendingManualPayments(limit = 50) {
  return db.payment.findMany({
    where: { provider: 'manual', status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { user: { select: { id: true, email: true, fullName: true } } },
  });
}

/** Look a payment up by the reference a payer quoted on their transfer. */
export async function findManualPaymentByReference(reference: string) {
  const suffix = reference.replace(/^JP-/i, '').trim().toLowerCase();
  if (suffix.length < 4) return null;
  return db.payment.findFirst({
    where: { provider: 'manual', id: { endsWith: suffix } },
  });
}

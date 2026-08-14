import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { priceFor } from '../subscription';
import { parseJson } from '../types';
import type { BillingInterval } from '../types';
import { allocateCreditNoteNumber, allocateInvoiceNumber } from './numbering';
import {
  buildTaxEngine,
  loadTaxTable,
  roundHalfAwayFromZero,
  summariseTaxLines,
  taxSnapshotFor,
  type ResolvedTaxLine,
  type TaxContext,
} from './tax';

/**
 * Invoice records: construction, the status machine, and credit notes.
 *
 * THE ONE INVARIANT: a stored total always equals the sum of its lines.
 * `Invoice.subtotalCents / taxCents / totalCents` are never set from a caller's
 * arithmetic — every write goes through `totalsFromLines`, and every mutation
 * of a line recomputes them in the same transaction. An invoice whose total
 * disagrees with its lines is unexplainable to a customer and indefensible to
 * an auditor, and it is the single easiest way for a billing system to lose
 * money quietly.
 *
 * THE SECOND INVARIANT: an issued invoice is immutable except for payment
 * state. Corrections are credit notes. An open invoice raised in error is
 * VOIDED with a reason and keeps its number forever — a gap in the series is a
 * red flag, a voided invoice is a normal, explainable event.
 */

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

/**
 * Legal transitions. Everything absent is illegal, and the two that matter
 * most are the ones people reach for by accident:
 *
 *   - `void -> paid` is refused: a void invoice is not a receivable, so
 *     "paying" one silently resurrects a document we told the customer to
 *     ignore, and books revenue against nothing.
 *   - `paid -> void` is refused: money moved. Reversing the document without
 *     reversing the money leaves the payment allocated to an invoice that no
 *     longer exists. Issue a credit note (and a refund) instead.
 *
 * `uncollectible` is a write-off, and a write-off that is later recovered
 * becomes `paid` — so that one edge stays open.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['open', 'void'],
  open: ['paid', 'void', 'uncollectible'],
  uncollectible: ['paid'],
  paid: [],
  void: [],
};

export class InvoiceStateError extends Error {
  readonly from: InvoiceStatus;
  readonly to: InvoiceStatus;

  constructor(from: InvoiceStatus, to: InvoiceStatus, detail?: string) {
    super(detail ?? `An invoice that is ${from} cannot become ${to}.`);
    this.name = 'InvoiceStateError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (INVOICE_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus, detail?: string): void {
  if (!canTransition(from, to)) throw new InvoiceStateError(from, to, detail);
}

// ---------------------------------------------------------------------------
// Lines and totals
// ---------------------------------------------------------------------------

export type InvoiceLineKind =
  | 'subscription'
  | 'usage'
  | 'one_time'
  | 'proration_charge'
  | 'proration_credit'
  | 'discount'
  | 'credit';

/** Kinds whose amount may be negative. Anything else must be a charge. */
export const NEGATIVE_LINE_KINDS: readonly InvoiceLineKind[] = [
  'proration_credit',
  'discount',
  'credit',
];

export interface InvoiceLineInput {
  kind?: InvoiceLineKind;
  description: string;
  planCode?: string | null;
  interval?: string | null;
  quantity?: number;
  unitAmountCents: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  sortOrder?: number;
  /** Set false for a line outside the tax base (rare; e.g. a tax-inclusive fee). */
  taxable?: boolean;
}

export interface PricedInvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  planCode: string | null;
  interval: string | null;
  quantity: number;
  unitAmountCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  sortOrder: number;
  taxComponents: ResolvedTaxLine[];
}

export interface InvoiceTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export interface PricedInvoice extends InvoiceTotals {
  lines: PricedInvoiceLine[];
  /** Every component of every line, flattened — one `InvoiceTaxLine` row each. */
  taxComponents: ResolvedTaxLine[];
  placeOfSupply: string;
  engine: 'table' | 'none';
  taxNotes: string[];
}

/** `quantity * unitAmountCents`, with the integer-cents rule enforced. */
export function lineSubtotal(line: Pick<InvoiceLineInput, 'quantity' | 'unitAmountCents'>): number {
  const quantity = line.quantity ?? 1;
  return quantity * line.unitAmountCents;
}

/** Reject anything that would produce an unexplainable invoice. */
export function validateLineInputs(lines: InvoiceLineInput[]): void {
  if (lines.length === 0) throw new Error('An invoice needs at least one line item.');

  for (const line of lines) {
    const kind = line.kind ?? 'subscription';
    if (!line.description.trim()) {
      throw new Error('Every invoice line needs a description — it is printed verbatim on the PDF.');
    }
    if (!Number.isInteger(line.unitAmountCents)) {
      throw new Error(
        `Line "${line.description}" has a non-integer amount (${line.unitAmountCents}). Money is always integer cents.`,
      );
    }
    const quantity = line.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Line "${line.description}" has an invalid quantity (${quantity}).`);
    }
    if (line.unitAmountCents < 0 && !NEGATIVE_LINE_KINDS.includes(kind)) {
      throw new Error(
        `Line "${line.description}" is negative but its kind is "${kind}". Negative amounts are only valid on ${NEGATIVE_LINE_KINDS.join(', ')}.`,
      );
    }
    if (kind === 'discount' && line.unitAmountCents > 0) {
      throw new Error(`Discount line "${line.description}" must be negative or zero.`);
    }
  }
}

/**
 * Totals from lines. This is the only place totals are computed.
 *
 * A discount is its own line with a negative amount, so `subtotalCents` counts
 * the non-discount lines and `discountCents` is the positive magnitude of the
 * discount lines. That keeps the schema's stated identity exactly true:
 *
 *     total = subtotal - discount + tax
 *
 * without double-counting the discount, which is what happens the moment
 * someone sums every line into the subtotal *and* reports a discount beside it.
 */
export function totalsFromLines(
  lines: { kind?: InvoiceLineKind; subtotalCents: number; taxCents?: number }[],
): InvoiceTotals {
  let subtotalCents = 0;
  let discountCents = 0;
  let taxCents = 0;

  for (const line of lines) {
    if ((line.kind ?? 'subscription') === 'discount') discountCents -= line.subtotalCents;
    else subtotalCents += line.subtotalCents;
    taxCents += line.taxCents ?? 0;
  }

  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
}

/**
 * Price a set of lines: per-line subtotal, per-line tax components, totals.
 *
 * Tax is resolved and rounded per line per component, then summed — never by
 * applying a rate to the invoice total. On a two-line Ontario invoice of
 * $10.005 each, per-line rounding gives 130 + 130 = 260 while whole-invoice
 * rounding gives 260 or 261 depending on the day. Only one of those matches
 * what the line items say.
 */
export function priceInvoice(lines: InvoiceLineInput[], taxContext: TaxContext): PricedInvoice {
  validateLineInputs(lines);

  const engine = buildTaxEngine(taxContext);
  const priced: PricedInvoiceLine[] = [];
  const taxComponents: ResolvedTaxLine[] = [];

  lines.forEach((line, index) => {
    const subtotalCents = lineSubtotal(line);
    const resolution = line.taxable === false ? null : engine.forAmount(subtotalCents);
    const components = resolution?.lines ?? [];
    const taxCents = components.reduce((sum, component) => sum + component.amountCents, 0);

    taxComponents.push(...components);
    priced.push({
      kind: line.kind ?? 'subscription',
      description: line.description,
      planCode: line.planCode ?? null,
      interval: line.interval ?? null,
      quantity: line.quantity ?? 1,
      unitAmountCents: line.unitAmountCents,
      subtotalCents,
      taxCents,
      totalCents: subtotalCents + taxCents,
      periodStart: line.periodStart ?? null,
      periodEnd: line.periodEnd ?? null,
      sortOrder: line.sortOrder ?? index,
      taxComponents: components,
    });
  });

  const totals = totalsFromLines(priced);

  if (totals.totalCents < 0) {
    throw new Error(
      `Invoice total is negative (${totals.totalCents} cents). A document that owes the customer money is a credit note, not an invoice.`,
    );
  }

  return {
    ...totals,
    lines: priced,
    taxComponents,
    placeOfSupply: engine.placeOfSupply,
    engine: engine.engine,
    taxNotes: engine.notes,
  };
}

/** `total - paid - credited`, floored at zero: an overpayment is a credit
 *  balance on the ledger, never a negative receivable. */
export function computeAmountDue(
  totalCents: number,
  amountPaidCents: number,
  amountCreditedCents: number,
): number {
  return Math.max(0, totalCents - amountPaidCents - amountCreditedCents);
}

export interface InvoiceBalance {
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  dueCents: number;
  settled: boolean;
}

export function invoiceBalance(invoice: {
  totalCents: number;
  amountPaidCents: number;
  amountCreditedCents: number;
}): InvoiceBalance {
  const dueCents = computeAmountDue(
    invoice.totalCents,
    invoice.amountPaidCents,
    invoice.amountCreditedCents,
  );
  return {
    totalCents: invoice.totalCents,
    paidCents: invoice.amountPaidCents,
    creditedCents: invoice.amountCreditedCents,
    dueCents,
    settled: dueCents <= 0,
  };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface SellerSnapshot {
  legalName: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  email: string;
  website: string;
  gstNumber: string;
  qstNumber: string;
}

/** Our own details, frozen onto each invoice at issue. Environment-driven so a
 *  change of address does not rewrite history. */
export function sellerSnapshot(): SellerSnapshot {
  const env = process.env;
  return {
    legalName: env.SELLER_LEGAL_NAME?.trim() || 'JobPilot AI Inc.',
    line1: env.SELLER_ADDRESS_LINE1?.trim() || '',
    line2: env.SELLER_ADDRESS_LINE2?.trim() || '',
    city: env.SELLER_CITY?.trim() || '',
    region: env.SELLER_REGION?.trim() || '',
    postalCode: env.SELLER_POSTAL_CODE?.trim() || '',
    country: env.SELLER_COUNTRY?.trim() || 'CA',
    email: env.SELLER_BILLING_EMAIL?.trim() || 'billing@jobpilot.ai',
    website: env.NEXT_PUBLIC_APP_URL?.trim() || '',
    gstNumber: env.GST_HST_NUMBER?.trim() || '',
    qstNumber: env.QST_NUMBER?.trim() || '',
  };
}

export interface BillToSnapshot {
  name: string;
  email: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  taxNumber: string;
  poNumber: string;
}

/**
 * Who the invoice is addressed to, frozen at issue. Falls back to the user
 * record when no billing profile exists — an invoice must still be addressable,
 * and the region falling back to empty is exactly what makes the tax engine
 * emit its "no province" warning rather than guessing.
 */
export function billToSnapshotFrom(
  user: { fullName: string; email: string; city: string | null; country: string },
  profile: {
    legalName: string;
    billingEmail: string;
    line1: string;
    line2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
    taxNumber: string | null;
    poNumber: string | null;
  } | null,
): BillToSnapshot {
  if (!profile) {
    return {
      name: user.fullName,
      email: user.email,
      line1: '',
      line2: '',
      city: user.city ?? '',
      region: '',
      postalCode: '',
      country: user.country,
      taxNumber: '',
      poNumber: '',
    };
  }
  return {
    name: profile.legalName || user.fullName,
    email: profile.billingEmail || user.email,
    line1: profile.line1,
    line2: profile.line2,
    city: profile.city,
    region: profile.region,
    postalCode: profile.postalCode,
    country: profile.country,
    taxNumber: profile.taxNumber ?? '',
    poNumber: profile.poNumber ?? '',
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInvoiceInput {
  userId: string;
  /** Defaults to the user's subscription. */
  subscriptionId?: string | null;
  /** Defaults to the subscription's plan. */
  planCode?: string;
  interval?: BillingInterval;
  /** Overrides the plan price. Use for prorations and negotiated amounts. */
  amountCents?: number;
  periodStart?: Date;
  periodEnd?: Date;
  /** A positive magnitude; written as a negative `discount` line. */
  discountCents?: number;
  discountDescription?: string;
  extraLines?: InvoiceLineInput[];
  currency?: string;
  collectionMethod?: 'charge_automatically' | 'send_invoice';
  dueInDays?: number;
  notes?: string;
  footer?: string;
  /** Issue immediately — allocates the number in the same transaction. */
  issue?: boolean;
  /** The date the tax table is read at. Defaults to now. */
  asOf?: Date;
}

type InvoiceWithChildren = Prisma.InvoiceGetPayload<{
  include: { lines: true; taxLines: true };
}>;

/**
 * Build the invoice for one subscription period.
 *
 * Everything — invoice, lines, tax lines, and (when `issue` is set) the number
 * allocation — happens in one transaction. A half-written invoice with lines
 * but no totals, or a number burned by a failed insert, is not a state this
 * function can leave behind.
 */
export async function createInvoiceForSubscription(
  input: CreateSubscriptionInvoiceInput,
): Promise<InvoiceWithChildren> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: {
      billingProfile: true,
      subscription: { include: { plan: true } },
    },
  });
  if (!user) throw new Error(`Unknown user ${input.userId}`);

  const subscription = user.subscription;
  const plan =
    input.planCode && input.planCode !== subscription?.plan.code
      ? await db.plan.findUnique({ where: { code: input.planCode } })
      : (subscription?.plan ?? null);
  if (!plan) {
    throw new Error(
      `Cannot invoice ${user.email}: no plan resolved (pass planCode, or activate a subscription first).`,
    );
  }

  const interval = (input.interval ?? (subscription?.interval as BillingInterval) ?? 'monthly') as BillingInterval;
  const currency = input.currency ?? user.billingProfile?.currency ?? subscription?.currency ?? 'CAD';
  const asOf = input.asOf ?? new Date();
  const periodStart = input.periodStart ?? subscription?.periodStart ?? asOf;
  const periodEnd = input.periodEnd ?? subscription?.periodEnd ?? addMonths(periodStart, 1);
  const amountCents = input.amountCents ?? priceFor(plan, interval);

  const billTo = billToSnapshotFrom(user, user.billingProfile);
  const seller = sellerSnapshot();

  const { rates, registrations } = await loadTaxTable(db);
  const taxContext: TaxContext = {
    country: billTo.country,
    region: billTo.region,
    asOf,
    exempt: user.billingProfile?.taxExempt ?? false,
    exemptionReason: user.billingProfile?.exemptionReason ?? null,
    rates,
    registrations,
  };

  const lines: InvoiceLineInput[] = [
    {
      kind: 'subscription',
      // The service period is a column on the line and is printed beneath the
      // description by the renderer, so it is deliberately not repeated here.
      description: `${plan.name} plan — ${intervalLabel(interval)} subscription`,
      planCode: plan.code,
      interval,
      quantity: 1,
      unitAmountCents: amountCents,
      periodStart,
      periodEnd,
      sortOrder: 0,
    },
    ...(input.extraLines ?? []),
  ];

  if (input.discountCents && input.discountCents > 0) {
    lines.push({
      kind: 'discount',
      description: input.discountDescription ?? 'Discount',
      quantity: 1,
      unitAmountCents: -Math.abs(input.discountCents),
      sortOrder: lines.length,
    });
  }

  const priced = priceInvoice(lines, taxContext);
  const snapshot = taxSnapshotFor(
    { engine: priced.engine, placeOfSupply: priced.placeOfSupply, notes: priced.taxNotes, lines: priced.taxComponents },
    asOf,
  );

  const dueAt = input.dueInDays != null ? addDays(asOf, input.dueInDays) : null;

  return db.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        userId: user.id,
        subscriptionId: input.subscriptionId === undefined ? (subscription?.id ?? null) : input.subscriptionId,
        status: 'draft',
        collectionMethod: input.collectionMethod ?? 'charge_automatically',
        currency,
        subtotalCents: priced.subtotalCents,
        discountCents: priced.discountCents,
        taxCents: priced.taxCents,
        totalCents: priced.totalCents,
        amountDueCents: priced.totalCents,
        planCode: plan.code,
        planName: plan.name,
        interval,
        periodStart,
        periodEnd,
        dueAt,
        billToSnapshot: JSON.stringify(billTo),
        sellerSnapshot: JSON.stringify(seller),
        taxSnapshot: JSON.stringify(snapshot),
        notes: input.notes ?? '',
        footer: input.footer ?? defaultFooter(seller),
      },
    });

    await writePricedLines(tx, invoice.id, priced);

    if (input.issue) {
      await issueInvoiceTx(tx, invoice.id, { asOf, dueInDays: input.dueInDays });
    }

    return loadInvoiceOrThrow(tx, invoice.id);
  });
}

/** Persist priced lines and their tax components. Lines first, because each
 *  tax row points at the line it was computed from. */
async function writePricedLines(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  priced: PricedInvoice,
): Promise<void> {
  for (const line of priced.lines) {
    const created = await tx.invoiceLine.create({
      data: {
        invoiceId,
        kind: line.kind,
        description: line.description,
        planCode: line.planCode,
        interval: line.interval,
        quantity: line.quantity,
        unitAmountCents: line.unitAmountCents,
        subtotalCents: line.subtotalCents,
        taxCents: line.taxCents,
        totalCents: line.totalCents,
        periodStart: line.periodStart,
        periodEnd: line.periodEnd,
        sortOrder: line.sortOrder,
      },
    });

    for (const component of line.taxComponents) {
      await tx.invoiceTaxLine.create({
        data: {
          invoiceId,
          invoiceLineId: created.id,
          taxRateId: component.taxRateId,
          code: component.code,
          label: component.label,
          jurisdiction: component.jurisdiction,
          rateParts: component.rateParts,
          taxableCents: component.taxableCents,
          amountCents: component.amountCents,
          registrationNumber: component.registrationNumber,
          source: component.source,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface IssueInvoiceOptions {
  asOf?: Date;
  dueInDays?: number;
  provider?: string | null;
}

/** draft -> open. Allocates the number, freezes the totals, sets the due date. */
export async function issueInvoice(
  invoiceId: string,
  options: IssueInvoiceOptions = {},
): Promise<InvoiceWithChildren> {
  return db.$transaction(async (tx) => {
    await issueInvoiceTx(tx, invoiceId, options);
    return loadInvoiceOrThrow(tx, invoiceId);
  });
}

async function issueInvoiceTx(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  options: IssueInvoiceOptions,
): Promise<void> {
  const invoice = await loadInvoiceOrThrow(tx, invoiceId);
  assertTransition(invoice.status as InvoiceStatus, 'open');

  const asOf = options.asOf ?? new Date();

  // Recompute rather than trust: a draft's lines may have been edited since the
  // totals were last written, and the number is about to make this permanent.
  const totals = totalsFromLines(
    invoice.lines.map((line) => ({
      kind: line.kind as InvoiceLineKind,
      subtotalCents: line.subtotalCents,
      taxCents: line.taxCents,
    })),
  );

  const year = asOf.getUTCFullYear();
  const allocated = await allocateInvoiceNumber(tx, year, invoice.series);

  const amountDueCents = computeAmountDue(
    totals.totalCents,
    invoice.amountPaidCents,
    invoice.amountCreditedCents,
  );

  // A zero-total invoice (100% coupon, credit-covered renewal) has nothing to
  // collect, so it is settled the moment it is issued. It still gets a number
  // and a document: the customer received a service and is entitled to say so.
  const settled = amountDueCents <= 0;

  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      status: settled ? 'paid' : 'open',
      number: allocated.number,
      series: allocated.series,
      issueYear: allocated.year,
      sequence: allocated.sequence,
      issuedAt: asOf,
      paidAt: settled ? asOf : null,
      dueAt:
        options.dueInDays != null
          ? addDays(asOf, options.dueInDays)
          : (invoice.dueAt ?? addDays(asOf, 14)),
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      amountDueCents,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(invoice.billToSnapshot === '{}' || invoice.sellerSnapshot === '{}'
        ? await refreshSnapshots(tx, invoice.userId)
        : {}),
    },
  });
}

async function refreshSnapshots(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ billToSnapshot: string; sellerSnapshot: string }> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: { billingProfile: true },
  });
  const billTo = user
    ? billToSnapshotFrom(user, user.billingProfile)
    : {
        name: '',
        email: '',
        line1: '',
        line2: '',
        city: '',
        region: '',
        postalCode: '',
        country: 'CA',
        taxNumber: '',
        poNumber: '',
      };
  return {
    billToSnapshot: JSON.stringify(billTo),
    sellerSnapshot: JSON.stringify(sellerSnapshot()),
  };
}

export interface VoidInvoiceOptions {
  reason: string;
  voidedAt?: Date;
}

/**
 * Cancel a document that should not exist. The number is kept forever — a void
 * invoice explains the gap it would otherwise leave.
 */
export async function voidInvoice(
  invoiceId: string,
  options: VoidInvoiceOptions,
): Promise<InvoiceWithChildren> {
  if (!options.reason.trim()) {
    throw new Error('Voiding an invoice requires a reason; it is what an auditor reads.');
  }

  return db.$transaction(async (tx) => {
    const invoice = await loadInvoiceOrThrow(tx, invoiceId);
    const status = invoice.status as InvoiceStatus;

    assertTransition(
      status,
      'void',
      status === 'paid'
        ? 'This invoice has been paid. Voiding it would leave a payment allocated to a document that no longer exists — issue a credit note and a refund instead.'
        : undefined,
    );

    if (invoice.amountPaidCents > 0) {
      throw new InvoiceStateError(
        status,
        'void',
        `${formatCents(invoice.amountPaidCents)} has already been applied to this invoice. Issue a credit note instead of voiding it.`,
      );
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'void',
        voidedAt: options.voidedAt ?? new Date(),
        voidReason: options.reason.trim(),
        amountDueCents: 0,
        nextAttemptAt: null,
        dunningStage: 'none',
      },
    });

    return loadInvoiceOrThrow(tx, invoiceId);
  });
}

export interface MarkPaidOptions {
  /** An existing `Payment` to allocate. When absent a manual payment is
   *  recorded, because `Invoice.amountPaidCents` is a cache over allocations
   *  and must never be written without the row it summarises. */
  paymentId?: string;
  amountCents?: number;
  provider?: string;
  method?: string;
  paidAt?: Date;
  description?: string;
}

/**
 * Settle an invoice. Refuses on a void invoice, refuses on a draft (a document
 * with no number cannot be receipted), and is a no-op on one already paid.
 */
export async function markInvoicePaid(
  invoiceId: string,
  options: MarkPaidOptions = {},
): Promise<InvoiceWithChildren> {
  return db.$transaction(async (tx) => {
    const invoice = await loadInvoiceOrThrow(tx, invoiceId);
    const status = invoice.status as InvoiceStatus;

    // Idempotent: gateways deliver "paid" more than once.
    if (status === 'paid') return invoice;

    assertTransition(
      status,
      'paid',
      status === 'void'
        ? 'This invoice was voided. A voided document is not a receivable and cannot be paid — raise a new invoice.'
        : status === 'draft'
          ? 'This invoice is still a draft. Issue it first so the payment settles against a numbered document.'
          : undefined,
    );

    const paidAt = options.paidAt ?? new Date();
    const outstanding = computeAmountDue(
      invoice.totalCents,
      invoice.amountPaidCents,
      invoice.amountCreditedCents,
    );

    // An existing payment can only contribute what it has not already been
    // allocated elsewhere — one $59 payment cannot settle two $59 invoices.
    let unallocated: number | null = null;
    if (options.paymentId) {
      const payment = await tx.payment.findUnique({ where: { id: options.paymentId } });
      if (!payment) throw new Error(`Unknown payment ${options.paymentId}`);
      if (payment.userId !== invoice.userId) {
        throw new Error('That payment belongs to another customer and cannot settle this invoice.');
      }
      if (payment.currency !== invoice.currency) {
        throw new Error(
          `Payment is in ${payment.currency} but the invoice is in ${invoice.currency}. Cross-currency settlement needs an explicit FX rate.`,
        );
      }
      const allocated = await tx.paymentAllocation.aggregate({
        where: { paymentId: options.paymentId },
        _sum: { amountCents: true },
      });
      unallocated = payment.amountCents - (allocated._sum.amountCents ?? 0);
    }

    const amountCents =
      options.amountCents ?? (unallocated === null ? outstanding : Math.min(outstanding, unallocated));

    if (amountCents < 0) throw new Error('A payment cannot be negative.');
    if (amountCents > outstanding) {
      throw new Error(
        `Cannot apply ${formatCents(amountCents)} to an invoice with ${formatCents(outstanding)} outstanding — the surplus belongs on the credit ledger, not on this invoice.`,
      );
    }
    if (unallocated !== null && amountCents > unallocated) {
      throw new Error(
        `Payment ${options.paymentId} has only ${formatCents(unallocated)} left to allocate.`,
      );
    }

    if (amountCents > 0) {
      let paymentId = options.paymentId;

      if (!paymentId) {
        const created = await tx.payment.create({
          data: {
            userId: invoice.userId,
            provider: options.provider ?? invoice.provider ?? 'manual',
            kind: 'manual',
            method: options.method ?? 'manual_adjustment',
            status: 'succeeded',
            amountCents,
            currency: invoice.currency,
            netCents: amountCents,
            description: options.description ?? `Payment for ${invoice.number ?? invoice.id}`,
            succeededAt: paidAt,
          },
        });
        paymentId = created.id;
      }

      // The allocation and the cache it feeds are written in one transaction —
      // that is the whole rule for a CACHE column.
      await tx.paymentAllocation.create({
        data: { paymentId, invoiceId, amountCents },
      });
    }

    const allocations = await tx.paymentAllocation.aggregate({
      where: { invoiceId },
      _sum: { amountCents: true },
    });
    const amountPaidCents = allocations._sum.amountCents ?? 0;
    const amountDueCents = computeAmountDue(
      invoice.totalCents,
      amountPaidCents,
      invoice.amountCreditedCents,
    );

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amountPaidCents,
        amountDueCents,
        status: amountDueCents <= 0 ? 'paid' : invoice.status,
        paidAt: amountDueCents <= 0 ? paidAt : null,
        nextAttemptAt: amountDueCents <= 0 ? null : invoice.nextAttemptAt,
        dunningStage: amountDueCents <= 0 && invoice.dunningStage !== 'none' ? 'recovered' : invoice.dunningStage,
      },
    });

    return loadInvoiceOrThrow(tx, invoiceId);
  });
}

/** open -> uncollectible. A write-off, not a correction: the document stands. */
export async function markInvoiceUncollectible(
  invoiceId: string,
  reason = 'Written off after dunning was exhausted.',
): Promise<InvoiceWithChildren> {
  return db.$transaction(async (tx) => {
    const invoice = await loadInvoiceOrThrow(tx, invoiceId);
    assertTransition(invoice.status as InvoiceStatus, 'uncollectible');

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'uncollectible',
        notes: invoice.notes ? `${invoice.notes}\n${reason}` : reason,
        nextAttemptAt: null,
        dunningStage: 'exhausted',
      },
    });

    return loadInvoiceOrThrow(tx, invoiceId);
  });
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export interface CreditTaxComponent {
  code: string;
  label: string;
  jurisdiction: string;
  rateParts: number;
  amountCents: number;
  registrationNumber: string | null;
}

export interface CreditNoteLineInput {
  /** Pins the credit to an invoice line so partial credits stay traceable. */
  sourceInvoiceLineId?: string | null;
  description: string;
  quantity?: number;
  /** Positive magnitude. The document's sign is implied by its type. */
  amountCents: number;
  /** Overrides the mirrored components; used for an invoice-level goodwill credit. */
  taxComponents?: CreditTaxComponent[];
}

/**
 * Mirror a source line's tax proportionally.
 *
 * A credit note never resolves tax independently — resolving it again would be
 * the only way to get it wrong (rates move, and a 2024 invoice credited in 2026
 * must reverse 2024's tax). Crediting 40% of a line credits 40% of each of its
 * components, rounded away from zero so the parts still sum to the whole when
 * the whole line is credited.
 */
export function mirrorTaxComponents(
  source: { subtotalCents: number },
  components: CreditTaxComponent[],
  creditAmountCents: number,
): CreditTaxComponent[] {
  if (source.subtotalCents === 0) return [];
  const full = Math.abs(creditAmountCents) >= Math.abs(source.subtotalCents);
  return components.map((component) => ({
    ...component,
    amountCents: full
      ? component.amountCents
      : roundHalfAwayFromZero((component.amountCents * creditAmountCents) / source.subtotalCents),
  }));
}

/** How much of an invoice may still be credited. */
export function creditableRemaining(
  invoiceTotalCents: number,
  alreadyCreditedCents: number,
): number {
  return Math.max(0, invoiceTotalCents - alreadyCreditedCents);
}

export interface CreateCreditNoteInput {
  invoiceId: string;
  lines: CreditNoteLineInput[];
  reason?: string;
  memo?: string;
  /** Split of the total; defaults to the whole amount as account credit. */
  refundCents?: number;
  creditCents?: number;
  issuedByStaffId?: string | null;
  issuedByEmail?: string;
  /** Issue immediately: allocates the number and updates the invoice. */
  issue?: boolean;
  issuedAt?: Date;
}

type CreditNoteWithLines = Prisma.CreditNoteGetPayload<{ include: { lines: true } }>;

export async function createCreditNote(
  input: CreateCreditNoteInput,
): Promise<CreditNoteWithLines> {
  if (input.lines.length === 0) throw new Error('A credit note needs at least one line.');

  return db.$transaction(async (tx) => {
    const invoice = await loadInvoiceOrThrow(tx, input.invoiceId);
    const status = invoice.status as InvoiceStatus;

    if (status === 'draft' || status === 'void') {
      throw new InvoiceStateError(
        status,
        'paid',
        status === 'draft'
          ? 'A draft invoice has no number and nothing to credit — edit or discard the draft instead.'
          : 'A voided invoice has already been reversed in full; there is nothing left to credit.',
      );
    }

    const sourceLines = new Map(invoice.lines.map((line) => [line.id, line]));
    const taxByLine = new Map<string, CreditTaxComponent[]>();
    for (const taxLine of invoice.taxLines) {
      if (!taxLine.invoiceLineId) continue;
      const bucket = taxByLine.get(taxLine.invoiceLineId) ?? [];
      bucket.push({
        code: taxLine.code,
        label: taxLine.label,
        jurisdiction: taxLine.jurisdiction,
        rateParts: taxLine.rateParts,
        amountCents: taxLine.amountCents,
        registrationNumber: taxLine.registrationNumber,
      });
      taxByLine.set(taxLine.invoiceLineId, bucket);
    }

    let subtotalCents = 0;
    let taxCents = 0;
    const prepared: {
      data: Prisma.CreditNoteLineCreateWithoutCreditNoteInput;
    }[] = [];

    input.lines.forEach((line, index) => {
      if (!Number.isInteger(line.amountCents) || line.amountCents <= 0) {
        throw new Error(
          `Credit line "${line.description}" must be a positive integer amount in cents (received ${line.amountCents}).`,
        );
      }

      let components = line.taxComponents ?? [];
      if (!line.taxComponents && line.sourceInvoiceLineId) {
        const source = sourceLines.get(line.sourceInvoiceLineId);
        if (!source) {
          throw new Error(
            `Invoice line ${line.sourceInvoiceLineId} is not on invoice ${invoice.number ?? invoice.id}.`,
          );
        }
        if (line.amountCents > Math.abs(source.subtotalCents)) {
          throw new Error(
            `Cannot credit ${formatCents(line.amountCents)} against a line of ${formatCents(source.subtotalCents)}.`,
          );
        }
        components = mirrorTaxComponents(
          source,
          taxByLine.get(source.id) ?? [],
          line.amountCents,
        );
      }

      const lineTax = components.reduce((sum, component) => sum + component.amountCents, 0);
      subtotalCents += line.amountCents;
      taxCents += lineTax;

      const quantity = line.quantity ?? 1;
      prepared.push({
        data: {
          sourceInvoiceLine: line.sourceInvoiceLineId
            ? { connect: { id: line.sourceInvoiceLineId } }
            : undefined,
          description: line.description,
          quantity,
          unitAmountCents: Math.trunc(line.amountCents / quantity),
          amountCents: line.amountCents,
          taxComponents: JSON.stringify(components),
          taxCents: lineTax,
          totalCents: line.amountCents + lineTax,
          sortOrder: index,
        },
      });
    });

    const totalCents = subtotalCents + taxCents;

    const alreadyCredited = await tx.creditNote.aggregate({
      where: { invoiceId: invoice.id, status: 'issued' },
      _sum: { totalCents: true },
    });
    const remaining = creditableRemaining(
      invoice.totalCents,
      alreadyCredited._sum.totalCents ?? 0,
    );
    if (totalCents > remaining) {
      throw new Error(
        `Cannot credit ${formatCents(totalCents)} against invoice ${invoice.number ?? invoice.id}: only ${formatCents(remaining)} remains creditable.`,
      );
    }

    const refundCents = input.refundCents ?? 0;
    const creditCents = input.creditCents ?? totalCents - refundCents;
    if (refundCents < 0 || creditCents < 0) {
      throw new Error('Refund and credit amounts on a credit note must not be negative.');
    }
    if (refundCents + creditCents !== totalCents) {
      throw new Error(
        `Credit note split does not add up: ${formatCents(refundCents)} refunded + ${formatCents(creditCents)} credited != ${formatCents(totalCents)} total.`,
      );
    }

    const creditNote = await tx.creditNote.create({
      data: {
        invoiceId: invoice.id,
        userId: invoice.userId,
        status: 'draft',
        reason: input.reason ?? 'adjustment',
        currency: invoice.currency,
        subtotalCents,
        taxCents,
        totalCents,
        refundCents,
        creditCents,
        memo: input.memo ?? '',
        issuedByStaffId: input.issuedByStaffId ?? null,
        issuedByEmail: input.issuedByEmail ?? '',
        lines: { create: prepared.map((line) => line.data) },
      },
      include: { lines: true },
    });

    if (input.issue) {
      await issueCreditNoteTx(tx, creditNote.id, input.issuedAt ?? new Date());
      const reloaded = await tx.creditNote.findUnique({
        where: { id: creditNote.id },
        include: { lines: true },
      });
      if (reloaded) return reloaded;
    }

    return creditNote;
  });
}

/** draft -> issued. Allocates the number and settles the invoice's caches. */
export async function issueCreditNote(
  creditNoteId: string,
  issuedAt = new Date(),
): Promise<CreditNoteWithLines> {
  return db.$transaction(async (tx) => {
    await issueCreditNoteTx(tx, creditNoteId, issuedAt);
    const creditNote = await tx.creditNote.findUnique({
      where: { id: creditNoteId },
      include: { lines: true },
    });
    if (!creditNote) throw new Error(`Unknown credit note ${creditNoteId}`);
    return creditNote;
  });
}

async function issueCreditNoteTx(
  tx: Prisma.TransactionClient,
  creditNoteId: string,
  issuedAt: Date,
): Promise<void> {
  const creditNote = await tx.creditNote.findUnique({ where: { id: creditNoteId } });
  if (!creditNote) throw new Error(`Unknown credit note ${creditNoteId}`);
  if (creditNote.status !== 'draft') {
    throw new Error(`Credit note ${creditNote.number ?? creditNote.id} is already ${creditNote.status}.`);
  }

  const allocated = await allocateCreditNoteNumber(
    tx,
    issuedAt.getUTCFullYear(),
    creditNote.series,
  );

  await tx.creditNote.update({
    where: { id: creditNoteId },
    data: {
      status: 'issued',
      number: allocated.number,
      series: allocated.series,
      issueYear: allocated.year,
      sequence: allocated.sequence,
      issuedAt,
    },
  });

  // The account-credit half settles on the ledger. The refund half is money
  // leaving through a gateway and belongs to the payments module — it reads
  // `refundCents` and writes the `Refund` row with its own idempotency key.
  if (creditNote.creditCents > 0) {
    await tx.creditLedgerEntry.create({
      data: {
        userId: creditNote.userId,
        amountCents: creditNote.creditCents,
        currency: creditNote.currency,
        source: 'credit_note',
        creditNoteId: creditNote.id,
        invoiceId: creditNote.invoiceId,
        description: `Credit note ${allocated.number}`,
      },
    });
  }

  const invoice = await loadInvoiceOrThrow(tx, creditNote.invoiceId);
  const credited = await tx.creditNote.aggregate({
    where: { invoiceId: invoice.id, status: 'issued' },
    _sum: { totalCents: true },
  });
  const amountCreditedCents = credited._sum.totalCents ?? 0;
  const amountDueCents = computeAmountDue(
    invoice.totalCents,
    invoice.amountPaidCents,
    amountCreditedCents,
  );

  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      amountCreditedCents,
      amountDueCents,
      // A fully credited open invoice has nothing left to collect. It is not
      // "paid" in the cash sense, so the status only moves when money or credit
      // has actually covered it — which is exactly what amountDue reaching zero
      // means here.
      status:
        amountDueCents <= 0 && (invoice.status as InvoiceStatus) === 'open'
          ? 'paid'
          : invoice.status,
      paidAt: amountDueCents <= 0 && !invoice.paidAt ? issuedAt : invoice.paidAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One invoice with everything a document renderer needs. */
export async function loadInvoiceOrThrow(
  client: Prisma.TransactionClient,
  invoiceId: string,
): Promise<InvoiceWithChildren> {
  const invoice = await client.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, taxLines: true },
  });
  if (!invoice) throw new Error(`Unknown invoice ${invoiceId}`);
  return invoice;
}

/** One invoice, scoped to its owner. Returns null rather than throwing so a
 *  route can 404 without leaking whether the id exists. */
export async function getInvoiceForUser(
  invoiceId: string,
  userId: string,
): Promise<InvoiceWithChildren | null> {
  return db.invoice.findFirst({
    where: { id: invoiceId, userId },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, taxLines: true },
  });
}

export interface ListInvoicesOptions {
  status?: InvoiceStatus;
  limit?: number;
  cursor?: string;
  /** Include documents that were never issued. Staff tooling only. */
  includeUnissued?: boolean;
}

/** True once the document has been issued — that is, once it has a number.
 *  Tested on the number rather than the status because a draft that is
 *  discarded becomes `void` while still holding no number, and that is equally
 *  not a document the customer was ever given. */
export function isIssuedDocument(invoice: { number: string | null }): boolean {
  return invoice.number !== null;
}

export async function listInvoicesForUser(userId: string, options: ListInvoicesOptions = {}) {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  return db.invoice.findMany({
    where: {
      userId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.includeUnissued ? {} : { number: { not: null } }),
    },
    orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    include: { lines: { orderBy: { sortOrder: 'asc' } }, taxLines: true },
  });
}

/** The tax rows grouped the way a document prints them. */
export function invoiceTaxSummary(
  taxLines: {
    code: string;
    label: string;
    jurisdiction: string;
    rateParts: number;
    taxableCents: number;
    amountCents: number;
    registrationNumber: string | null;
  }[],
) {
  return summariseTaxLines(taxLines);
}

export function readBillTo(invoice: { billToSnapshot: string }): BillToSnapshot {
  return parseJson<BillToSnapshot>(invoice.billToSnapshot, {
    name: '',
    email: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    taxNumber: '',
    poNumber: '',
  });
}

export function readSeller(invoice: { sellerSnapshot: string }): SellerSnapshot {
  return parseJson<SellerSnapshot>(invoice.sellerSnapshot, sellerSnapshot());
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function formatCents(cents: number, currency = 'CAD'): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100).toLocaleString('en-CA');
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${sign}$${dollars}.${remainder}${currency && currency !== 'CAD' ? ` ${currency}` : ''}`;
}

export function intervalLabel(interval: string): string {
  if (interval === 'annual') return 'annual';
  if (interval === 'quarterly') return 'quarterly';
  return 'monthly';
}

export function formatPeriod(start: Date, end: Date): string {
  const fmt = (date: Date) =>
    date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function defaultFooter(seller: SellerSnapshot): string {
  const parts = [`${seller.legalName}`];
  if (seller.gstNumber) parts.push(`GST/HST ${seller.gstNumber}`);
  if (seller.email) parts.push(seller.email);
  return parts.join('  ·  ');
}

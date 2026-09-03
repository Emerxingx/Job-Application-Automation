import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { describeWait, tooMany } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import {
  EXPORT_RATE_LIMIT,
  exportFormatSchema,
  exportResponse,
  type ExportColumn,
  type ExportDataset,
  type ExportFilter,
} from '@/lib/exports';

/**
 * Every invoice across every customer, as a file.
 *
 * The customer-facing export at /api/exports/invoices is scoped to
 * `requireUser()`'s own id. This is the same idea for the whole book, gated at
 * `billing_ops` — the same rung as the page it is offered from.
 *
 * TOTALS ARE PER CURRENCY. The summary block reports CAD and USD separately
 * rather than adding them: there is no exchange rate in this system, and a
 * combined figure would be wrong in both currencies.
 */

const MAX_ROWS = 5000;

const STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'];
const CURRENCIES = ['CAD', 'USD'];

const COLUMNS: ExportColumn[] = [
  { key: 'number', header: 'Number', width: 2 },
  { key: 'status', header: 'Status', width: 1 },
  { key: 'customerName', header: 'Customer', width: 3 },
  { key: 'customerEmail', header: 'Email', width: 3 },
  { key: 'currency', header: 'Currency', width: 1 },
  { key: 'planName', header: 'Plan', width: 2 },
  { key: 'interval', header: 'Interval', width: 1, csvOnly: true },
  { key: 'subtotalCents', header: 'Subtotal', kind: 'money', width: 2, csvOnly: true },
  { key: 'discountCents', header: 'Discount', kind: 'money', width: 2, csvOnly: true },
  { key: 'taxCents', header: 'Tax', kind: 'money', width: 2 },
  { key: 'totalCents', header: 'Total', kind: 'money', width: 2 },
  { key: 'amountPaidCents', header: 'Paid', kind: 'money', width: 2, csvOnly: true },
  { key: 'amountCreditedCents', header: 'Credited', kind: 'money', width: 2, csvOnly: true },
  { key: 'amountRefundedCents', header: 'Refunded', kind: 'money', width: 2, csvOnly: true },
  { key: 'amountDueCents', header: 'Outstanding', kind: 'money', width: 2 },
  { key: 'issuedAt', header: 'Issued', kind: 'date', width: 2 },
  { key: 'dueAt', header: 'Due', kind: 'date', width: 2 },
  { key: 'paidAt', header: 'Paid on', kind: 'date', width: 2, csvOnly: true },
  { key: 'provider', header: 'Provider', width: 1, csvOnly: true },
  { key: 'dunningStage', header: 'Dunning', width: 1, csvOnly: true },
  { key: 'invoiceId', header: 'Invoice id', width: 2, csvOnly: true },
];

export const GET = consoleRoute(async (request: Request) => {
  const staff = await requireStaff('billing_ops');

  const limit = rateLimit('console-export-invoices', staff.id, EXPORT_RATE_LIMIT);
  if (!limit.ok) {
    return tooMany(
      `Too many exports. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const url = new URL(request.url);
  const format = exportFormatSchema('csv').parse(url.searchParams.get('format') ?? undefined);

  const q = url.searchParams.get('q')?.trim() ?? '';
  const statusParam = url.searchParams.get('status') ?? '';
  const currencyParam = (url.searchParams.get('currency') ?? '').toUpperCase();
  const overdue = url.searchParams.get('overdue') === '1';

  const status = STATUSES.includes(statusParam) ? statusParam : '';
  const currency = CURRENCIES.includes(currencyParam) ? currencyParam : '';
  const now = new Date();

  const and: Prisma.InvoiceWhereInput[] = [];
  if (status) and.push({ status });
  if (currency) and.push({ currency });
  if (overdue) and.push({ status: 'open', dueAt: { lt: now } });
  if (q) {
    and.push({
      OR: [
        { number: { contains: q } },
        { user: { email: { contains: q } } },
        { user: { fullName: { contains: q } } },
      ],
    });
  }
  const where: Prisma.InvoiceWhereInput = and.length > 0 ? { AND: and } : {};

  const [total, invoices] = await Promise.all([
    db.invoice.count({ where }),
    db.invoice.findMany({
      where,
      orderBy: [{ issuedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: MAX_ROWS,
      select: {
        id: true,
        number: true,
        status: true,
        currency: true,
        planName: true,
        interval: true,
        subtotalCents: true,
        discountCents: true,
        taxCents: true,
        totalCents: true,
        amountPaidCents: true,
        amountCreditedCents: true,
        amountRefundedCents: true,
        amountDueCents: true,
        issuedAt: true,
        dueAt: true,
        paidAt: true,
        provider: true,
        dunningStage: true,
        user: { select: { fullName: true, email: true } },
      },
    }),
  ]);

  const filters: ExportFilter[] = [];
  if (q) filters.push({ label: 'Search', value: q });
  if (status) filters.push({ label: 'Status', value: status });
  if (currency) filters.push({ label: 'Currency', value: currency });
  if (overdue) filters.push({ label: 'Collection', value: 'Past due only' });
  if (filters.length === 0) filters.push({ label: 'Filter', value: 'All invoices' });

  // Per-currency, never combined.
  const byCurrency = new Map<string, { total: number; due: number; count: number }>();
  for (const invoice of invoices) {
    const bucket = byCurrency.get(invoice.currency) ?? { total: 0, due: 0, count: 0 };
    bucket.total += invoice.totalCents;
    bucket.due += invoice.amountDueCents;
    bucket.count += 1;
    byCurrency.set(invoice.currency, bucket);
  }

  const dataset: ExportDataset = {
    title: 'JobPilot invoices',
    subtitle: `Exported by ${staff.email}`,
    filenameBase: `jobpilot-invoices-${now.toISOString().slice(0, 10)}`,
    generatedAt: now,
    filters,
    summary: [
      { label: 'Invoices in file', value: String(invoices.length) },
      { label: 'Matching the filter', value: String(total) },
      ...[...byCurrency.entries()].flatMap(([code, bucket]) => [
        { label: `Billed (${code})`, value: (bucket.total / 100).toFixed(2) },
        { label: `Outstanding (${code})`, value: (bucket.due / 100).toFixed(2) },
      ]),
    ],
    columns: COLUMNS,
    rows: invoices.map((invoice) => ({
      invoiceId: invoice.id,
      number: invoice.number ?? `draft-${invoice.id.slice(-6)}`,
      status:
        invoice.status === 'open' && invoice.dueAt !== null && invoice.dueAt < now
          ? 'past_due'
          : invoice.status,
      customerName: invoice.user.fullName || invoice.user.email,
      customerEmail: invoice.user.email,
      currency: invoice.currency,
      planName: invoice.planName || '—',
      interval: invoice.interval,
      subtotalCents: invoice.subtotalCents,
      discountCents: invoice.discountCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      amountPaidCents: invoice.amountPaidCents,
      amountCreditedCents: invoice.amountCreditedCents,
      amountRefundedCents: invoice.amountRefundedCents,
      amountDueCents: invoice.amountDueCents,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      paidAt: invoice.paidAt,
      provider: invoice.provider ?? '',
      dunningStage: invoice.dunningStage,
    })),
    sections: [],
    emptyMessage: 'No invoices matched these filters.',
    note:
      total > invoices.length
        ? `Truncated to ${MAX_ROWS} rows of ${total}. Narrow the filters for a complete file.`
        : undefined,
  };

  return exportResponse(dataset, format);
});

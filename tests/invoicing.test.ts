import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEQUENCE_STYLES,
  allocateDocumentNumber,
  formatDocumentNumber,
  isUniqueViolation,
  parseDocumentNumber,
  type SequenceKey,
  type SequenceRow,
  type SequenceStore,
} from '../src/lib/billing/numbering';
import {
  BUILT_IN_TAX_RATES,
  buildTaxEngine,
  formatRateParts,
  jurisdictionCode,
  resolveTax,
  roundHalfAwayFromZero,
  summariseTaxLines,
  taxAmountFor,
  taxSnapshotFor,
  type TaxRegistrationRow,
} from '../src/lib/billing/tax';
import {
  INVOICE_TRANSITIONS,
  InvoiceStateError,
  assertTransition,
  canTransition,
  computeAmountDue,
  creditableRemaining,
  invoiceBalance,
  isIssuedDocument,
  lineSubtotal,
  mirrorTaxComponents,
  priceInvoice,
  totalsFromLines,
  validateLineInputs,
  type InvoiceLineInput,
  type InvoiceStatus,
} from '../src/lib/billing/invoice';
import { renderInvoicePdf, type InvoicePdfInput } from '../src/lib/billing/invoice-pdf';

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

/** An in-memory `DocumentSequence` table. */
function fakeStore(options: { failFirstCreate?: boolean } = {}) {
  const rows = new Map<string, SequenceRow>();
  let creates = 0;
  const keyOf = (key: SequenceKey) => `${key.scope}|${key.series}|${key.year}`;

  const store: SequenceStore = {
    async find(key) {
      return rows.get(keyOf(key)) ?? null;
    },
    async create(row) {
      creates += 1;
      const key = keyOf(row as SequenceKey);
      if (options.failFirstCreate && creates === 1) {
        // Simulate the racer that created the counter a microsecond earlier.
        rows.set(key, { id: `seq-${key}`, ...row, nextValue: 2 });
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const created: SequenceRow = { id: `seq-${key}`, ...row };
      rows.set(key, created);
      return created;
    },
    async increment(id) {
      for (const [key, row] of rows) {
        if (row.id !== id) continue;
        const next = { ...row, nextValue: row.nextValue + 1 };
        rows.set(key, next);
        return next;
      }
      throw new Error(`no sequence ${id}`);
    },
  };

  return { store, rows, creates: () => creates };
}

const invoiceKey: SequenceKey = { scope: 'invoice', series: 'JP', year: 2026 };

describe('formatDocumentNumber', () => {
  it('renders the documented invoice format', () => {
    assert.equal(
      formatDocumentNumber({ prefix: 'INV-', year: 2026, sequence: 123, padding: 6 }),
      'INV-2026-000123',
    );
  });

  it('pads to the configured width and restarts cleanly at 1', () => {
    assert.equal(formatDocumentNumber({ prefix: 'INV-', year: 2026, sequence: 1 }), 'INV-2026-000001');
    assert.equal(
      formatDocumentNumber({ prefix: 'CN-', year: 2027, sequence: 12, padding: 6 }),
      'CN-2027-000012',
    );
  });

  it('grows rather than truncating once the padding is outgrown', () => {
    // Truncating would silently collide with an earlier number.
    assert.equal(
      formatDocumentNumber({ prefix: 'INV-', year: 2026, sequence: 1_234_567, padding: 6 }),
      'INV-2026-1234567',
    );
  });

  it('refuses a sequence that is not a positive integer', () => {
    assert.throws(() => formatDocumentNumber({ prefix: 'INV-', year: 2026, sequence: 0 }));
    assert.throws(() => formatDocumentNumber({ prefix: 'INV-', year: 2026, sequence: -3 }));
    assert.throws(() => formatDocumentNumber({ prefix: 'INV-', year: 2026, sequence: 1.5 }));
  });
});

describe('parseDocumentNumber', () => {
  it('round-trips an invoice number', () => {
    assert.deepEqual(parseDocumentNumber('INV-2026-000123'), {
      prefix: 'INV-',
      year: 2026,
      sequence: 123,
    });
  });

  it('handles a multi-segment prefix without swallowing the year', () => {
    assert.deepEqual(parseDocumentNumber('JP-CN-2026-000012'), {
      prefix: 'JP-CN-',
      year: 2026,
      sequence: 12,
    });
  });

  it('returns null on anything that is not a document number', () => {
    assert.equal(parseDocumentNumber('not-a-number'), null);
    assert.equal(parseDocumentNumber('2026-000123'), null);
    assert.equal(parseDocumentNumber(''), null);
  });
});

describe('allocateDocumentNumber', () => {
  it('hands out 1 first and records 2 as next', async () => {
    const { store, rows } = fakeStore();
    const first = await allocateDocumentNumber(store, invoiceKey);

    assert.equal(first.number, 'INV-2026-000001');
    assert.equal(first.sequence, 1);
    assert.equal([...rows.values()][0].nextValue, 2);
  });

  it('increments without gaps across consecutive documents', async () => {
    const { store } = fakeStore();
    const numbers: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      numbers.push((await allocateDocumentNumber(store, invoiceKey)).number);
    }

    assert.deepEqual(numbers, [
      'INV-2026-000001',
      'INV-2026-000002',
      'INV-2026-000003',
      'INV-2026-000004',
      'INV-2026-000005',
    ]);
  });

  it('restarts each year and keeps series independent', async () => {
    const { store } = fakeStore();
    await allocateDocumentNumber(store, invoiceKey);
    await allocateDocumentNumber(store, invoiceKey);

    const nextYear = await allocateDocumentNumber(store, { ...invoiceKey, year: 2027 });
    assert.equal(nextYear.number, 'INV-2027-000001');

    const creditNote = await allocateDocumentNumber(store, {
      scope: 'credit_note',
      series: SEQUENCE_STYLES.credit_note.series,
      year: 2026,
    });
    assert.equal(creditNote.number, 'CN-2026-000001');
  });

  it('takes the value the store returns rather than computing it locally', async () => {
    // This is the race: another writer bumped the counter between our read and
    // our write. The number must come from the atomic increment's result.
    const { store } = fakeStore();
    await allocateDocumentNumber(store, invoiceKey); // 1, nextValue -> 2

    const row = await store.find(invoiceKey);
    assert.ok(row);
    row.nextValue = 40; // a concurrent writer advanced the counter behind us

    const next = await allocateDocumentNumber(store, invoiceKey);
    assert.equal(next.number, 'INV-2026-000040');
    assert.equal(next.sequence, 40);
  });

  it('retries against the winner when two writers create the same counter', async () => {
    const { store, creates } = fakeStore({ failFirstCreate: true });
    const allocated = await allocateDocumentNumber(store, invoiceKey);

    // The loser did not invent a second counter row; it used the winner's.
    assert.equal(creates(), 1);
    assert.equal(allocated.number, 'INV-2026-000002');
  });
});

describe('isUniqueViolation', () => {
  it('recognises P2002 and nothing else', () => {
    assert.equal(isUniqueViolation(Object.assign(new Error('x'), { code: 'P2002' })), true);
    assert.equal(isUniqueViolation(Object.assign(new Error('x'), { code: 'P2025' })), false);
    assert.equal(isUniqueViolation(new Error('x')), false);
    assert.equal(isUniqueViolation(null), false);
  });
});

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

const NO_REGISTRATIONS: TaxRegistrationRow[] = [];
const CA_REGISTRATIONS: TaxRegistrationRow[] = [
  { country: 'CA', region: '*', code: 'GST', number: '80912 3456 RT0001' },
  { country: 'CA', region: 'QC', code: 'QST', number: '1234567890TQ0001' },
];

function canadianTax(region: string, amountCents: number, asOf = new Date('2026-08-14')) {
  return resolveTax({
    country: 'CA',
    region,
    amountCents,
    asOf,
    registrations: CA_REGISTRATIONS,
  });
}

describe('taxAmountFor', () => {
  it('is the documented parts-per-million formula', () => {
    assert.deepEqual(taxAmountFor(2900, 130_000), { taxableCents: 2900, amountCents: 377 });
  });

  it('rounds half away from zero so a credit mirrors its charge exactly', () => {
    // 5% of 50c is exactly 2.5c. Math.round would give +3 and -2.
    assert.equal(taxAmountFor(50, 50_000).amountCents, 3);
    assert.equal(taxAmountFor(-50, 50_000).amountCents, -3);
    assert.equal(roundHalfAwayFromZero(-2.5), -3);
    assert.equal(roundHalfAwayFromZero(2.5), 3);
  });

  it('applies a reduced taxable basis before the rate', () => {
    // Texas taxes data processing on 80% of the charge.
    assert.deepEqual(taxAmountFor(10_000, 62_500, 800_000), {
      taxableCents: 8_000,
      amountCents: 500,
    });
  });
});

describe('resolveTax — Canada', () => {
  it('charges Ontario a single harmonised 13%', () => {
    const result = canadianTax('ON', 2900);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].code, 'HST');
    assert.equal(result.lines[0].amountCents, 377);
    assert.equal(result.totalCents, 377);
    assert.equal(result.placeOfSupply, 'CA-ON');
  });

  it('never adds GST on top of HST', () => {
    const result = canadianTax('NB', 10_000);
    assert.deepEqual(
      result.lines.map((line) => line.code),
      ['HST'],
    );
    assert.equal(result.totalCents, 1500);
  });

  it('charges Quebec GST plus QST, uncompounded', () => {
    const result = canadianTax('QC', 2900);
    assert.deepEqual(
      result.lines.map((line) => [line.code, line.amountCents]),
      [
        ['GST', 145],
        ['QST', 289], // 9.975% of 2900 = 289.275
      ],
    );
    assert.equal(result.totalCents, 434);
    // Both components print beside their own registration number.
    assert.equal(result.lines[0].registrationNumber, '80912 3456 RT0001');
    assert.equal(result.lines[1].registrationNumber, '1234567890TQ0001');
  });

  it('charges British Columbia GST plus PST as two separate components', () => {
    const result = canadianTax('BC', 2900);
    assert.deepEqual(
      result.lines.map((line) => [line.code, line.amountCents]),
      [
        ['GST', 145],
        ['PST', 203],
      ],
    );
  });

  it('charges Saskatchewan and Manitoba their own provincial rates', () => {
    assert.deepEqual(
      canadianTax('SK', 2900).lines.map((line) => [line.code, line.amountCents]),
      [
        ['GST', 145],
        ['PST', 174],
      ],
    );
    assert.deepEqual(
      canadianTax('MB', 2900).lines.map((line) => [line.code, line.amountCents]),
      [
        ['GST', 145],
        ['RST', 203],
      ],
    );
  });

  it('charges Alberta and the territories GST only', () => {
    for (const region of ['AB', 'NT', 'NU', 'YT']) {
      const result = canadianTax(region, 2900);
      assert.deepEqual(
        result.lines.map((line) => line.code),
        ['GST'],
        `${region} should be GST only`,
      );
      assert.equal(result.totalCents, 145);
    }
  });

  it("honours Nova Scotia's 2025 rate change through effective dating", () => {
    const before = canadianTax('NS', 10_000, new Date('2025-03-31T12:00:00Z'));
    const after = canadianTax('NS', 10_000, new Date('2025-04-01T12:00:00Z'));

    assert.equal(before.lines[0].rateParts, 150_000);
    assert.equal(before.totalCents, 1500);
    assert.equal(after.lines[0].rateParts, 140_000);
    assert.equal(after.totalCents, 1400);
  });

  it('mirrors exactly on a negative amount, so credits reverse cleanly', () => {
    const charge = canadianTax('ON', 2900);
    const credit = canadianTax('ON', -2900);
    assert.equal(credit.totalCents, -charge.totalCents);
  });

  it('warns rather than guessing when no province is on file', () => {
    const result = canadianTax('', 2900);
    assert.deepEqual(
      result.lines.map((line) => line.code),
      ['GST'],
    );
    assert.ok(result.notes.some((note) => note.includes('No province')));
  });

  it('collects nothing from an exempt customer and says why', () => {
    const result = resolveTax({
      country: 'CA',
      region: 'ON',
      amountCents: 2900,
      exempt: true,
      exemptionReason: 'Status Indian, certificate on file',
      registrations: CA_REGISTRATIONS,
    });
    assert.equal(result.lines.length, 0);
    assert.equal(result.totalCents, 0);
    assert.ok(result.notes[0].includes('tax exempt'));
  });
});

describe('resolveTax — United States', () => {
  const NY_REGISTRATION: TaxRegistrationRow[] = [
    { country: 'US', region: 'NY', code: 'US_STATE', number: 'NY-123456' },
  ];

  it('collects nothing by default, and explains that nexus is not a lookup', () => {
    const result = resolveTax({
      country: 'US',
      region: 'NY',
      amountCents: 2900,
      usMode: 'none',
      registrations: NY_REGISTRATION,
    });
    assert.equal(result.lines.length, 0);
    assert.equal(result.totalCents, 0);
    assert.equal(result.engine, 'none');
    assert.ok(result.notes.some((note) => note.includes('US_TAX_MODE=none')));
  });

  it('collects New York state tax once registered and switched on', () => {
    const result = resolveTax({
      country: 'US',
      region: 'NY',
      amountCents: 2900,
      usMode: 'table',
      registrations: NY_REGISTRATION,
    });
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].amountCents, 116); // 4% of $29
    assert.equal(result.lines[0].jurisdiction, 'US-NY');
    assert.equal(result.lines[0].registrationNumber, 'NY-123456');
    assert.ok(result.notes.some((note) => note.includes('State rate only')));
  });

  it('refuses to collect where there is no registration', () => {
    // Tax collected without a registration cannot be remitted — it is a
    // liability, which is strictly worse than not collecting.
    const result = resolveTax({
      country: 'US',
      region: 'WA',
      amountCents: 2900,
      usMode: 'table',
      registrations: NO_REGISTRATIONS,
    });
    assert.equal(result.totalCents, 0);
    assert.ok(result.notes.some((note) => note.includes('Not registered in US-WA')));
  });

  it('applies the Texas 80% taxable basis', () => {
    const result = resolveTax({
      country: 'US',
      region: 'TX',
      amountCents: 10_000,
      usMode: 'table',
      registrations: [{ country: 'US', region: 'TX', code: 'US_STATE', number: 'TX-1' }],
    });
    assert.equal(result.lines[0].taxableCents, 8000);
    assert.equal(result.lines[0].amountCents, 500);
  });

  it('says so when a state does not tax SaaS at all', () => {
    const result = resolveTax({
      country: 'US',
      region: 'FL',
      amountCents: 2900,
      usMode: 'table',
      registrations: [{ country: 'US', region: 'FL', code: 'US_STATE', number: 'FL-1' }],
    });
    assert.equal(result.totalCents, 0);
    assert.ok(result.notes.some((note) => note.includes('not treated as a taxable supply')));
  });
});

describe('tax helpers', () => {
  it('formats rates without inventing precision', () => {
    assert.equal(formatRateParts(130_000), '13%');
    assert.equal(formatRateParts(99_750), '9.975%');
    assert.equal(formatRateParts(50_000), '5%');
  });

  it('builds jurisdiction codes', () => {
    assert.equal(jurisdictionCode('CA', 'ON'), 'CA-ON');
    assert.equal(jurisdictionCode('us', 'ny'), 'US-NY');
    assert.equal(jurisdictionCode('CA', '*'), 'CA');
  });

  it('groups components for display without losing amounts', () => {
    const engine = buildTaxEngine({
      country: 'CA',
      region: 'BC',
      registrations: CA_REGISTRATIONS,
      rates: BUILT_IN_TAX_RATES,
      asOf: new Date('2026-08-14'),
    });
    const all = [...engine.forAmount(1000).lines, ...engine.forAmount(2000).lines];
    const summary = summariseTaxLines(all);

    assert.equal(summary.length, 2);
    assert.equal(
      summary.reduce((sum, line) => sum + line.amountCents, 0),
      all.reduce((sum, line) => sum + line.amountCents, 0),
    );
  });

  it('snapshots the registration numbers used', () => {
    const snapshot = taxSnapshotFor(canadianTax('QC', 2900), new Date('2026-08-14T00:00:00Z'));
    assert.equal(snapshot.placeOfSupply, 'CA-QC');
    assert.equal(snapshot.registrationNumbers.QST, '1234567890TQ0001');
    assert.equal(snapshot.resolvedAt, '2026-08-14T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Pricing and totals
// ---------------------------------------------------------------------------

const ONTARIO = {
  country: 'CA',
  region: 'ON',
  asOf: new Date('2026-08-14'),
  registrations: CA_REGISTRATIONS,
};

describe('lineSubtotal', () => {
  it('multiplies quantity by unit amount', () => {
    assert.equal(lineSubtotal({ quantity: 3, unitAmountCents: 2900 }), 8700);
    assert.equal(lineSubtotal({ unitAmountCents: 2900 }), 2900);
  });
});

describe('validateLineInputs', () => {
  const base: InvoiceLineInput = { description: 'Starter plan', unitAmountCents: 2900 };

  it('requires at least one line', () => {
    assert.throws(() => validateLineInputs([]), /at least one line/);
  });

  it('requires a description', () => {
    assert.throws(() => validateLineInputs([{ ...base, description: '  ' }]), /description/);
  });

  it('refuses fractional cents', () => {
    assert.throws(() => validateLineInputs([{ ...base, unitAmountCents: 29.5 }]), /integer cents/);
  });

  it('refuses a negative charge line', () => {
    assert.throws(
      () => validateLineInputs([{ ...base, kind: 'subscription', unitAmountCents: -2900 }]),
      /Negative amounts are only valid/,
    );
  });

  it('allows a negative proration credit or discount', () => {
    assert.doesNotThrow(() =>
      validateLineInputs([
        { description: 'Unused Professional time', kind: 'proration_credit', unitAmountCents: -1200 },
        { description: 'Launch promotion', kind: 'discount', unitAmountCents: -500 },
      ]),
    );
  });

  it('refuses a positive discount', () => {
    assert.throws(
      () => validateLineInputs([{ description: 'Oops', kind: 'discount', unitAmountCents: 500 }]),
      /must be negative or zero/,
    );
  });

  it('refuses a zero or negative quantity', () => {
    assert.throws(() => validateLineInputs([{ ...base, quantity: 0 }]), /invalid quantity/);
    assert.throws(() => validateLineInputs([{ ...base, quantity: -1 }]), /invalid quantity/);
  });
});

describe('totalsFromLines', () => {
  it('satisfies total = subtotal - discount + tax', () => {
    const totals = totalsFromLines([
      { kind: 'subscription', subtotalCents: 5900, taxCents: 767 },
      { kind: 'discount', subtotalCents: -900, taxCents: -117 },
    ]);

    assert.deepEqual(totals, {
      subtotalCents: 5900,
      discountCents: 900,
      taxCents: 650,
      totalCents: 5650,
    });
    assert.equal(
      totals.totalCents,
      totals.subtotalCents - totals.discountCents + totals.taxCents,
    );
  });

  it('does not count a discount twice', () => {
    // The trap: summing every line into the subtotal AND reporting the discount
    // beside it deducts it a second time.
    const totals = totalsFromLines([
      { kind: 'subscription', subtotalCents: 1000 },
      { kind: 'discount', subtotalCents: -250 },
    ]);
    assert.equal(totals.subtotalCents, 1000);
    assert.equal(totals.totalCents, 750);
  });

  it('keeps a proration credit inside the subtotal, not the discount', () => {
    const totals = totalsFromLines([
      { kind: 'subscription', subtotalCents: 5900 },
      { kind: 'proration_credit', subtotalCents: -1200 },
    ]);
    assert.equal(totals.subtotalCents, 4700);
    assert.equal(totals.discountCents, 0);
    assert.equal(totals.totalCents, 4700);
  });
});

describe('priceInvoice', () => {
  it('agrees with its own line items', () => {
    const priced = priceInvoice(
      [
        { description: 'Professional plan', unitAmountCents: 5900, planCode: 'professional' },
        { description: 'Extra applications', kind: 'usage', quantity: 2, unitAmountCents: 500 },
      ],
      ONTARIO,
    );

    const lineSum = priced.lines.reduce((sum, line) => sum + line.subtotalCents, 0);
    const taxSum = priced.lines.reduce((sum, line) => sum + line.taxCents, 0);

    assert.equal(priced.subtotalCents, lineSum);
    assert.equal(priced.taxCents, taxSum);
    assert.equal(priced.totalCents, priced.subtotalCents - priced.discountCents + priced.taxCents);
    assert.equal(
      priced.totalCents,
      priced.lines.reduce((sum, line) => sum + line.totalCents, 0),
    );
  });

  it('rounds tax per line, not once over the invoice total', () => {
    // Two lines of $10.04 in Ontario: 130.52c each rounds to 131c, so the
    // invoice carries 262c. Taxing the $20.08 total once gives 261c — a figure
    // that contradicts the line items printed above it.
    const priced = priceInvoice(
      [
        { description: 'Line A', unitAmountCents: 1004 },
        { description: 'Line B', unitAmountCents: 1004 },
      ],
      ONTARIO,
    );

    assert.deepEqual(
      priced.lines.map((line) => line.taxCents),
      [131, 131],
    );
    assert.equal(priced.taxCents, 262);
    assert.notEqual(priced.taxCents, taxAmountFor(2008, 130_000).amountCents);
  });

  it('taxes a discount negatively so the customer is not overtaxed', () => {
    const priced = priceInvoice(
      [
        { description: 'Starter plan', unitAmountCents: 2900 },
        { description: 'Launch promotion', kind: 'discount', unitAmountCents: -500 },
      ],
      ONTARIO,
    );

    assert.equal(priced.subtotalCents, 2900);
    assert.equal(priced.discountCents, 500);
    assert.equal(priced.taxCents, 312); // 377 - 65
    assert.equal(priced.totalCents, 2712);
  });

  it('handles a zero-amount invoice without inventing tax', () => {
    const priced = priceInvoice(
      [{ description: 'Starter plan (fully covered by credit)', unitAmountCents: 0 }],
      ONTARIO,
    );

    assert.equal(priced.subtotalCents, 0);
    assert.equal(priced.taxCents, 0);
    assert.equal(priced.totalCents, 0);
  });

  it('nets a discount down to zero without going negative', () => {
    const priced = priceInvoice(
      [
        { description: 'Starter plan', unitAmountCents: 2900 },
        { description: '100% coupon', kind: 'discount', unitAmountCents: -2900 },
      ],
      ONTARIO,
    );
    assert.equal(priced.totalCents, 0);
    assert.equal(priced.taxCents, 0);
  });

  it('refuses to build an invoice that owes the customer money', () => {
    assert.throws(
      () =>
        priceInvoice(
          [
            { description: 'Starter plan', unitAmountCents: 2900 },
            { description: 'Over-generous credit', kind: 'credit', unitAmountCents: -5000 },
          ],
          ONTARIO,
        ),
      /credit note, not an invoice/,
    );
  });

  it('skips tax on a line marked non-taxable', () => {
    const priced = priceInvoice(
      [{ description: 'Government fee', unitAmountCents: 1000, taxable: false }],
      ONTARIO,
    );
    assert.equal(priced.taxCents, 0);
    assert.equal(priced.totalCents, 1000);
  });
});

describe('computeAmountDue / invoiceBalance', () => {
  it('subtracts payments and credits', () => {
    assert.equal(computeAmountDue(2900, 1000, 500), 1400);
  });

  it('floors at zero — an overpayment is a credit balance, not a negative bill', () => {
    assert.equal(computeAmountDue(2900, 3000, 0), 0);
    assert.equal(computeAmountDue(0, 0, 0), 0);
  });

  it('reports settlement', () => {
    assert.deepEqual(
      invoiceBalance({ totalCents: 2900, amountPaidCents: 2900, amountCreditedCents: 0 }),
      { totalCents: 2900, paidCents: 2900, creditedCents: 0, dueCents: 0, settled: true },
    );
    assert.equal(
      invoiceBalance({ totalCents: 2900, amountPaidCents: 0, amountCreditedCents: 0 }).settled,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

describe('invoice status transitions', () => {
  it('allows the legal moves', () => {
    assert.ok(canTransition('draft', 'open'));
    assert.ok(canTransition('draft', 'void'));
    assert.ok(canTransition('open', 'paid'));
    assert.ok(canTransition('open', 'void'));
    assert.ok(canTransition('open', 'uncollectible'));
    assert.ok(canTransition('uncollectible', 'paid'));
  });

  it('refuses to pay a void invoice', () => {
    assert.equal(canTransition('void', 'paid'), false);
    assert.throws(() => assertTransition('void', 'paid'), InvoiceStateError);
  });

  it('refuses to void a paid invoice', () => {
    assert.equal(canTransition('paid', 'void'), false);
    assert.throws(() => assertTransition('paid', 'void'), InvoiceStateError);
  });

  it('refuses to pay an unissued draft', () => {
    assert.equal(canTransition('draft', 'paid'), false);
  });

  it('treats paid and void as terminal', () => {
    assert.deepEqual(INVOICE_TRANSITIONS.paid, []);
    assert.deepEqual(INVOICE_TRANSITIONS.void, []);
    for (const to of ['draft', 'open', 'paid', 'void', 'uncollectible'] as InvoiceStatus[]) {
      assert.equal(canTransition('void', to), false, `void -> ${to} must be illegal`);
    }
  });

  it('carries the attempted move on the error for the caller to report', () => {
    try {
      assertTransition('paid', 'void', 'Issue a credit note instead.');
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof InvoiceStateError);
      assert.equal(error.from, 'paid');
      assert.equal(error.to, 'void');
      assert.match(error.message, /credit note/);
    }
  });
});

describe('isIssuedDocument', () => {
  it('is the number, not the status — a discarded draft is void and unnumbered', () => {
    assert.equal(isIssuedDocument({ number: 'INV-2026-000001' }), true);
    assert.equal(isIssuedDocument({ number: null }), false);
  });
});

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

describe('mirrorTaxComponents', () => {
  const components = [
    {
      code: 'GST',
      label: 'GST (5%)',
      jurisdiction: 'CA-QC',
      rateParts: 50_000,
      amountCents: 145,
      registrationNumber: '80912 3456 RT0001',
    },
    {
      code: 'QST',
      label: 'QST (9.975%)',
      jurisdiction: 'CA-QC',
      rateParts: 99_750,
      amountCents: 289,
      registrationNumber: '1234567890TQ0001',
    },
  ];

  it('reverses the exact charged amounts on a full credit', () => {
    const mirrored = mirrorTaxComponents({ subtotalCents: 2900 }, components, 2900);
    assert.deepEqual(
      mirrored.map((component) => component.amountCents),
      [145, 289],
    );
  });

  it('splits proportionally on a partial credit', () => {
    const mirrored = mirrorTaxComponents({ subtotalCents: 2900 }, components, 1450);
    assert.deepEqual(
      mirrored.map((component) => component.amountCents),
      [73, 145], // 72.5 -> 73 (away from zero), 144.5 -> 145
    );
  });

  it('never resolves tax again — it keeps the original rate and registration', () => {
    const mirrored = mirrorTaxComponents({ subtotalCents: 2900 }, components, 1000);
    assert.equal(mirrored[1].rateParts, 99_750);
    assert.equal(mirrored[1].registrationNumber, '1234567890TQ0001');
  });

  it('credits nothing against a zero-value line', () => {
    assert.deepEqual(mirrorTaxComponents({ subtotalCents: 0 }, components, 500), []);
  });
});

describe('creditableRemaining', () => {
  it('is what is left of the invoice', () => {
    assert.equal(creditableRemaining(2900, 0), 2900);
    assert.equal(creditableRemaining(2900, 1000), 1900);
  });

  it('never goes negative, so an over-credit is refused rather than inverted', () => {
    assert.equal(creditableRemaining(2900, 4000), 0);
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function pdfInput(overrides: Partial<InvoicePdfInput> = {}): InvoicePdfInput {
  return {
    number: 'INV-2026-000123',
    status: 'open',
    currency: 'CAD',
    issuedAt: new Date('2026-08-14T00:00:00Z'),
    dueAt: new Date('2026-08-28T00:00:00Z'),
    paidAt: null,
    periodStart: new Date('2026-08-14T00:00:00Z'),
    periodEnd: new Date('2026-09-14T00:00:00Z'),
    planName: 'Professional',
    interval: 'monthly',
    seller: {
      legalName: 'JobPilot AI Inc.',
      line1: '250 University Ave',
      line2: '',
      city: 'Toronto',
      region: 'ON',
      postalCode: 'M5H 3E5',
      country: 'CA',
      email: 'billing@jobpilot.ai',
      website: 'https://jobpilot.ai',
      gstNumber: '80912 3456 RT0001',
      qstNumber: '',
    },
    billTo: {
      name: 'Tyagi Consulting Inc.',
      email: 'ap@example.com',
      line1: '410 Adelaide St W',
      line2: 'Suite 200',
      city: 'Toronto',
      region: 'ON',
      postalCode: 'M5V 1S8',
      country: 'CA',
      taxNumber: '',
      poNumber: 'PO-4471',
    },
    lines: [
      {
        description: 'Professional plan — monthly subscription',
        quantity: 1,
        unitAmountCents: 5900,
        subtotalCents: 5900,
        periodStart: new Date('2026-08-14T00:00:00Z'),
        periodEnd: new Date('2026-09-14T00:00:00Z'),
      },
    ],
    taxLines: [
      { label: 'HST (13%)', jurisdiction: 'CA-ON', amountCents: 767, registrationNumber: '80912 3456 RT0001' },
    ],
    subtotalCents: 5900,
    discountCents: 0,
    taxCents: 767,
    totalCents: 6667,
    amountPaidCents: 0,
    amountCreditedCents: 0,
    amountDueCents: 6667,
    notes: '',
    footer: 'JobPilot AI Inc.  ·  GST/HST 80912 3456 RT0001',
    ...overrides,
  };
}

describe('renderInvoicePdf', () => {
  it('produces a valid, complete PDF', async () => {
    const buffer = await renderInvoicePdf(pdfInput());

    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(buffer.subarray(-32).toString('latin1'), /%%EOF/);
    assert.ok(buffer.byteLength > 1000, 'a one-page invoice should not be near-empty');
  });

  it('fits a normal invoice on a single page', async () => {
    const buffer = await renderInvoicePdf(pdfInput());
    assert.match(buffer.toString('latin1'), /\/Count 1\b/);
  });

  it('paginates rather than overflowing when there are many line items', async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      description: `Additional application credit pack #${index + 1} — a deliberately long description that wraps across more than one line so row heights vary`,
      quantity: 1,
      unitAmountCents: 500,
      subtotalCents: 500,
      periodStart: null,
      periodEnd: null,
    }));

    const buffer = await renderInvoicePdf(
      pdfInput({ lines: many, subtotalCents: 22_500, taxCents: 2925, totalCents: 25_425, amountDueCents: 25_425 }),
    );

    const source = buffer.toString('latin1');
    const count = Number(/\/Count (\d+)/.exec(source)?.[1]);
    assert.ok(count > 1, `expected more than one page, got ${count}`);
    assert.match(source, /%%EOF/);
  });

  it('renders every status, including a void invoice with no number', async () => {
    for (const status of ['draft', 'open', 'paid', 'void', 'uncollectible']) {
      const buffer = await renderInvoicePdf(
        pdfInput({
          status,
          number: status === 'draft' ? null : 'INV-2026-000123',
          paidAt: status === 'paid' ? new Date('2026-08-15T00:00:00Z') : null,
          voidedAt: status === 'void' ? new Date('2026-08-16T00:00:00Z') : null,
          voidReason: status === 'void' ? 'Raised against the wrong account.' : null,
          amountPaidCents: status === 'paid' ? 6667 : 0,
          amountDueCents: status === 'paid' || status === 'void' ? 0 : 6667,
        }),
      );
      assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-', `${status} should render`);
    }
  });

  it('renders a zero-total invoice and a discounted one', async () => {
    const zero = await renderInvoicePdf(
      pdfInput({
        lines: [
          {
            description: 'Professional plan — fully covered by account credit',
            quantity: 1,
            unitAmountCents: 0,
            subtotalCents: 0,
            periodStart: null,
            periodEnd: null,
          },
        ],
        taxLines: [],
        subtotalCents: 0,
        taxCents: 0,
        totalCents: 0,
        amountDueCents: 0,
        status: 'paid',
      }),
    );
    assert.ok(zero.byteLength > 500);

    const discounted = await renderInvoicePdf(
      pdfInput({
        discountCents: 900,
        subtotalCents: 5900,
        taxCents: 650,
        totalCents: 5650,
        amountDueCents: 5650,
      }),
    );
    assert.ok(discounted.byteLength > 500);
  });

  it('is deterministic enough to fingerprint — the same input renders the same length', async () => {
    const [a, b] = await Promise.all([
      renderInvoicePdf(pdfInput()),
      renderInvoicePdf(pdfInput()),
    ]);
    assert.equal(a.byteLength, b.byteLength);
  });
});

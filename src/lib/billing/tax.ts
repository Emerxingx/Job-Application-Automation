/**
 * Sales tax resolution for Canada and the United States.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHAT A RATE TABLE STRUCTURALLY CANNOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * This module answers exactly one question: "given a place of supply, a date
 * and a taxable amount, which statutory components apply and what are they
 * worth in cents?" That question is a lookup, and a table answers it well.
 *
 * It does NOT answer, and cannot be extended to answer:
 *
 *  1. NEXUS. Whether JobPilot is *obliged* to register and collect in a given
 *     state at all. US economic nexus is per-state (commonly $100k of sales or
 *     200 transactions in a rolling twelve months, but Kansas has no
 *     threshold, California is $500k, New York is $500k AND 100 transactions,
 *     and several states dropped their transaction count in 2023-2024). Nexus
 *     depends on *your rolling revenue by destination*, not on the customer in
 *     front of you. Nothing in a rate table can compute it. That is why the
 *     default here is `US_TAX_MODE=none` — see COLLECTION POLICY below.
 *
 *  2. PRODUCT TAXABILITY. Whether a SaaS subscription is even a taxable supply.
 *     The same product is "prewritten software" in NY, an "automated digital
 *     service" in WA, a "data processing service" taxed on 80% of value in TX,
 *     a "computer and data processing service" at a special 1% rate in CT, and
 *     not taxable at all in CA, FL, GA and about half the country. That
 *     classification is a legal opinion per state, per product, and it moves.
 *
 *  3. RATE CHANGES OVER TIME. Handled here only to the extent someone
 *     remembers to add a row: every rate is effective-dated (`effectiveFrom` /
 *     `effectiveTo`) so historical invoices re-render at the rate that was in
 *     force — Nova Scotia's HST fell 15% → 14% on 2025-04-01, and a single
 *     mutable rate column would silently re-tax every invoice before that date.
 *     Effective dating makes correction possible; it does not make the table
 *     current. Nobody in this codebase is subscribed to a rate feed.
 *
 *  4. LOCAL AND HOME-RULE JURISDICTIONS. The US rates below are STATE-LEVEL
 *     ONLY. Colorado, Louisiana and Alabama have hundreds of self-administered
 *     local jurisdictions with their own bases, their own filings and their own
 *     definitions; Chicago taxes SaaS through a 9% personal-property lease
 *     transaction tax that is not a sales tax at all. Getting the local layer
 *     right needs address-level geocoding, not a province/state code.
 *
 *  5. EXEMPTION CERTIFICATES. `taxExempt` here is a boolean somebody set. A
 *     real system validates and stores the certificate, tracks its expiry, and
 *     surrenders it on audit. Note that a Canadian customer quoting their own
 *     GST number does NOT become exempt — they claim an input tax credit
 *     instead. `BillingProfile.taxNumber` must never be treated as exemption.
 *
 *  6. FILING AND REMITTANCE. Collecting is the easy half. Registration,
 *     returns, remittance schedules and reconciliation are not modelled here.
 *
 * WHEN TO REPLACE THIS: the moment JobPilot has US customers in more than a
 * couple of states, or a bookkeeper asks for a return. Stripe Tax, Avalara
 * AvaTax, TaxJar or Vertex do nexus tracking, product taxability by SKU, rate
 * feeds, address-level rooftop sourcing, certificate management and filing.
 * `InvoiceTaxLine.source` already carries `stripe_tax | vendor` for exactly
 * that migration: the resolved lines keep the same shape, only the engine that
 * produced them changes.
 *
 * COLLECTION POLICY: tax collected where you are not registered cannot be
 * remitted. It sits on the balance sheet as a liability to a government that
 * will not accept it and to a customer who can demand it back — strictly worse
 * than not collecting. So US collection is off unless `US_TAX_MODE=table` AND
 * an active registration exists for that state. Canada collects by default:
 * JobPilot is a Canadian supplier and GST/HST registration is a prerequisite
 * for operating, not a per-customer decision.
 *
 * ARITHMETIC: rates are integer PARTS PER MILLION (1_000_000 = 100%), because
 * Quebec's QST is 9.975% — 997.5 basis points is not an integer, and a float
 * rate produces off-by-one-cent invoices that never reconcile. Tax is computed
 * and rounded PER COMPONENT PER LINE and then summed upward, which is what the
 * CRA and every state expect; rounding the invoice total once gives a
 * different, wrong answer.
 */

export const PARTS_PER_UNIT = 1_000_000;

/** Round half away from zero, so a credit mirrors its invoice exactly.
 *
 * `Math.round` breaks ties toward +Infinity: Math.round(-2.5) === -2. A credit
 * note built from a -2.5 cent component would then be one cent short of the
 * +3 cent charge it reverses, and the invoice would never zero out. */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** A statutory tax component, effective-dated. */
export interface TaxRateRow {
  /** Set when the row came from the database, for provenance on the tax line. */
  id?: string;
  country: string;
  /** Province/state code, or `*` for a country-wide component (federal GST). */
  region: string;
  /** GST | HST | PST | QST | RST | US_STATE */
  code: string;
  /** Printed on the invoice face: "HST (13%)", "QST (9.975%)". */
  label: string;
  rateParts: number;
  /** Taxed on a reduced base, e.g. Texas at 80% of value = 800_000. */
  taxableBasisParts?: number;
  /** Compounds on another component's amount. Always null in Canada today. */
  compoundsOnCode?: string | null;
  effectiveFrom: string;
  /** Exclusive upper bound; undefined means "still in force". */
  effectiveTo?: string;
  note?: string;
}

/** `CA-ON`, `US-NY`. Snapshotted onto every tax line so reports can group. */
export function jurisdictionCode(country: string, region: string): string {
  const c = country.toUpperCase();
  const r = (region || '').toUpperCase();
  return r && r !== '*' ? `${c}-${r}` : c;
}

/** "13%", "9.975%", "5%" — trailing zeros trimmed. */
export function formatRateParts(rateParts: number): string {
  const percent = (rateParts / PARTS_PER_UNIT) * 100;
  return `${Number(percent.toFixed(4))}%`;
}

// ---------------------------------------------------------------------------
// Canada
// ---------------------------------------------------------------------------
//
// HST is not "GST plus a provincial tax" as two lines — it is one harmonised
// component that already contains the federal 5%. So in an HST province the
// federal GST row must NOT also apply. `selectRates` enforces that below.
//
// Alberta, the Northwest Territories, Nunavut and Yukon levy no provincial
// sales tax, so they fall through to the country-wide GST row alone.

export const CANADA_TAX_RATES: TaxRateRow[] = [
  {
    country: 'CA',
    region: '*',
    code: 'GST',
    label: 'GST (5%)',
    rateParts: 50_000,
    effectiveFrom: '2008-01-01',
    note: 'Excise Tax Act s.165(1). Applies outside the HST provinces.',
  },

  // --- Harmonised provinces -------------------------------------------------
  {
    country: 'CA',
    region: 'ON',
    code: 'HST',
    label: 'HST (13%)',
    rateParts: 130_000,
    effectiveFrom: '2010-07-01',
  },
  {
    country: 'CA',
    region: 'NB',
    code: 'HST',
    label: 'HST (15%)',
    rateParts: 150_000,
    effectiveFrom: '2016-07-01',
  },
  {
    country: 'CA',
    region: 'NL',
    code: 'HST',
    label: 'HST (15%)',
    rateParts: 150_000,
    effectiveFrom: '2016-07-01',
  },
  {
    country: 'CA',
    region: 'PE',
    code: 'HST',
    label: 'HST (15%)',
    rateParts: 150_000,
    effectiveFrom: '2016-10-01',
  },
  // Nova Scotia is the reason effective dating is not optional.
  {
    country: 'CA',
    region: 'NS',
    code: 'HST',
    label: 'HST (15%)',
    rateParts: 150_000,
    effectiveFrom: '2010-07-01',
    effectiveTo: '2025-04-01',
  },
  {
    country: 'CA',
    region: 'NS',
    code: 'HST',
    label: 'HST (14%)',
    rateParts: 140_000,
    effectiveFrom: '2025-04-01',
    note: 'Provincial rate cut 10% -> 9% effective 2025-04-01.',
  },

  // --- Provincial taxes stacked on top of the federal GST -------------------
  {
    country: 'CA',
    region: 'BC',
    code: 'PST',
    label: 'PST (7%)',
    rateParts: 70_000,
    effectiveFrom: '2013-04-01',
  },
  {
    country: 'CA',
    region: 'SK',
    code: 'PST',
    label: 'PST (6%)',
    rateParts: 60_000,
    effectiveFrom: '2017-03-23',
  },
  {
    country: 'CA',
    region: 'MB',
    code: 'RST',
    label: 'RST (7%)',
    rateParts: 70_000,
    effectiveFrom: '2019-07-01',
  },
  {
    country: 'CA',
    region: 'QC',
    code: 'QST',
    label: 'QST (9.975%)',
    // Not 997.5 basis points — this is precisely why rates are parts per
    // million. `compoundsOnCode` is null: QST stopped compounding on GST in
    // 2013, and the column exists so that fact is written down rather than
    // silently assumed.
    rateParts: 99_750,
    compoundsOnCode: null,
    effectiveFrom: '2013-01-01',
  },
];

// ---------------------------------------------------------------------------
// United States
// ---------------------------------------------------------------------------
//
// STATE RATES ONLY. No county, city or special-district rate is represented,
// and the set of states below is the well-documented "SaaS is taxable" group —
// it is illustrative, not exhaustive, and each entry encodes a taxability
// opinion that a tax adviser, not this file, should own. Read the module
// header before adding a row.

export const US_TAX_RATES: TaxRateRow[] = [
  { country: 'US', region: 'NY', code: 'US_STATE', label: 'NY State Sales Tax (4%)', rateParts: 40_000, effectiveFrom: '2005-06-01', note: 'SaaS taxed as prewritten software. Local rates NOT included.' },
  { country: 'US', region: 'WA', code: 'US_STATE', label: 'WA State Sales Tax (6.5%)', rateParts: 65_000, effectiveFrom: '2009-07-01', note: 'Digital automated services. Destination sourced; local rates NOT included.' },
  { country: 'US', region: 'PA', code: 'US_STATE', label: 'PA State Sales Tax (6%)', rateParts: 60_000, effectiveFrom: '2016-08-01' },
  { country: 'US', region: 'MA', code: 'US_STATE', label: 'MA State Sales Tax (6.25%)', rateParts: 62_500, effectiveFrom: '2009-08-01' },
  { country: 'US', region: 'OH', code: 'US_STATE', label: 'OH State Sales Tax (5.75%)', rateParts: 57_500, effectiveFrom: '2013-09-01', note: 'Electronic information services; business use is taxable.' },
  { country: 'US', region: 'UT', code: 'US_STATE', label: 'UT State Sales Tax (4.85%)', rateParts: 48_500, effectiveFrom: '2019-04-01' },
  { country: 'US', region: 'TN', code: 'US_STATE', label: 'TN State Sales Tax (7%)', rateParts: 70_000, effectiveFrom: '2015-07-01' },
  { country: 'US', region: 'AZ', code: 'US_STATE', label: 'AZ TPT (5.6%)', rateParts: 56_000, effectiveFrom: '2013-06-01' },
  {
    country: 'US',
    region: 'CT',
    code: 'US_STATE',
    label: 'CT Computer Services Tax (1%)',
    rateParts: 10_000,
    effectiveFrom: '2019-10-01',
    note: 'Computer and data processing services carry a reduced 1% rate, not the 6.35% general rate.',
  },
  {
    country: 'US',
    region: 'TX',
    code: 'US_STATE',
    label: 'TX State Sales Tax (6.25%)',
    rateParts: 62_500,
    // Data processing services are taxable on 80% of the charge; the first 20%
    // is statutorily exempt. This is what `taxableBasisParts` is for, and it is
    // also a good illustration of why a flat rate table is not enough.
    taxableBasisParts: 800_000,
    effectiveFrom: '1999-10-01',
    note: 'Data processing services: 20% of the charge is exempt (Tex. Tax Code 151.351).',
  },
];

export const BUILT_IN_TAX_RATES: TaxRateRow[] = [...CANADA_TAX_RATES, ...US_TAX_RATES];

/** States where SaaS is generally NOT taxable, or where our position is that we
 *  do not collect. Surfaced as an explanatory note rather than silence. */
export const US_NON_COLLECTING_NOTE =
  'US sales tax is not collected without an active state registration. SaaS is not taxable in many states (CA, FL, GA, VA and others), and where it is, nexus is a function of rolling sales by destination — not of any single order.';

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export interface TaxRegistrationRow {
  country: string;
  /** `*` for the Canadian federal GST/HST registration. */
  region: string;
  /** GST | QST | US_STATE */
  code: string;
  number: string;
  label?: string;
  active?: boolean;
}

/**
 * Our own registrations, from the environment. Numbers are printed on the
 * invoice face; a Canadian invoice is legally deficient without the GST/HST
 * business number, so a missing value produces a note rather than silence.
 */
export function sellerRegistrations(): TaxRegistrationRow[] {
  const rows: TaxRegistrationRow[] = [];
  const gst = process.env.GST_HST_NUMBER?.trim();
  const qst = process.env.QST_NUMBER?.trim();
  if (gst) rows.push({ country: 'CA', region: '*', code: 'GST', number: gst, label: 'GST/HST' });
  if (qst) rows.push({ country: 'CA', region: 'QC', code: 'QST', number: qst, label: 'QST' });
  return rows;
}

function findRegistration(
  registrations: TaxRegistrationRow[],
  country: string,
  region: string,
  code: string,
): TaxRegistrationRow | null {
  const c = country.toUpperCase();
  const r = region.toUpperCase();
  const match = registrations.find((reg) => {
    if (reg.active === false) return false;
    if (reg.country.toUpperCase() !== c) return false;
    // GST and HST are the same registration; a Nova Scotia HST line is printed
    // beside the federal business number.
    const codeMatches =
      reg.code === code || (reg.code === 'GST' && (code === 'HST' || code === 'GST'));
    if (!codeMatches) return false;
    const regRegion = reg.region.toUpperCase();
    return regRegion === '*' || regRegion === r;
  });
  return match ?? null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type UsTaxMode = 'none' | 'table';

/** `US_TAX_MODE`, defaulting to `none`. Anything unrecognised is `none`. */
export function usTaxMode(): UsTaxMode {
  return process.env.US_TAX_MODE?.trim().toLowerCase() === 'table' ? 'table' : 'none';
}

export interface ResolvedTaxLine {
  taxRateId: string | null;
  code: string;
  label: string;
  jurisdiction: string;
  rateParts: number;
  taxableCents: number;
  amountCents: number;
  registrationNumber: string | null;
  source: 'table';
}

export interface TaxResolution {
  lines: ResolvedTaxLine[];
  totalCents: number;
  /** `CA-ON`, `US-NY`, or `CA` when no region was supplied. */
  placeOfSupply: string;
  engine: 'table' | 'none';
  /** Human-readable reasons, surfaced to staff and stored in `taxSnapshot`. */
  notes: string[];
}

export interface TaxContext {
  country: string;
  region?: string | null;
  /** Defaults to now. Use the invoice's issue date, never "today", on reissue. */
  asOf?: Date;
  exempt?: boolean;
  exemptionReason?: string | null;
  /** Defaults to `BUILT_IN_TAX_RATES`. */
  rates?: TaxRateRow[];
  /** Defaults to `sellerRegistrations()`. */
  registrations?: TaxRegistrationRow[];
  /** Defaults to `usTaxMode()`. */
  usMode?: UsTaxMode;
}

/**
 * Which components apply to a place of supply on a date.
 *
 * The HST rule lives here: when a harmonised component applies, the federal
 * country-wide GST row is dropped, because HST already contains it.
 */
export function selectRates(
  country: string,
  region: string | null | undefined,
  asOf: Date,
  table: TaxRateRow[] = BUILT_IN_TAX_RATES,
): TaxRateRow[] {
  const c = country.toUpperCase();
  const r = (region ?? '').toUpperCase();
  const at = asOf.getTime();

  const inForce = (row: TaxRateRow) => {
    const from = Date.parse(row.effectiveFrom);
    if (Number.isNaN(from) || at < from) return false;
    if (!row.effectiveTo) return true;
    const to = Date.parse(row.effectiveTo);
    return Number.isNaN(to) ? true : at < to;
  };

  const forCountry = table.filter((row) => row.country.toUpperCase() === c && inForce(row));
  const regional = r ? forCountry.filter((row) => row.region.toUpperCase() === r) : [];
  const harmonised = regional.some((row) => row.code === 'HST');
  const federal = harmonised ? [] : forCountry.filter((row) => row.region === '*');

  // Federal first so the invoice reads GST, then PST/QST — the order a
  // Canadian customer expects and the order the CRA's examples use.
  return [...federal, ...regional];
}

/** One component's tax on one taxable amount. Exported because it is the whole
 *  arithmetic contract, and a test that pins it is worth more than a comment. */
export function taxAmountFor(
  amountCents: number,
  rateParts: number,
  taxableBasisParts = PARTS_PER_UNIT,
): { taxableCents: number; amountCents: number } {
  const taxableCents = roundHalfAwayFromZero((amountCents * taxableBasisParts) / PARTS_PER_UNIT);
  return {
    taxableCents,
    amountCents: roundHalfAwayFromZero((taxableCents * rateParts) / PARTS_PER_UNIT),
  };
}

export interface TaxEngine {
  /** Resolve components for one taxable amount, rounding per component. */
  forAmount(amountCents: number): TaxResolution;
  readonly placeOfSupply: string;
  readonly notes: string[];
  readonly engine: 'table' | 'none';
}

/**
 * Build a resolver once and reuse it for every line on an invoice — selection
 * and registration lookup are constant across the document, only the amount
 * changes.
 */
export function buildTaxEngine(context: TaxContext): TaxEngine {
  const country = (context.country || 'CA').toUpperCase();
  const region = (context.region ?? '').toUpperCase();
  const asOf = context.asOf ?? new Date();
  const registrations = context.registrations ?? sellerRegistrations();
  const mode = context.usMode ?? usTaxMode();
  const placeOfSupply = jurisdictionCode(country, region);
  const notes: string[] = [];

  let applicable: TaxRateRow[] = [];

  if (context.exempt) {
    notes.push(
      `No tax applied: customer is marked tax exempt${
        context.exemptionReason ? ` (${context.exemptionReason})` : ''
      }. A certificate must be on file and valid at the issue date.`,
    );
  } else if (country === 'CA') {
    if (!region) {
      notes.push(
        'No province on the billing profile, so only the federal GST was applied. Place of supply for a Canadian customer is their province — collect it before issuing.',
      );
    }
    applicable = selectRates(country, region, asOf, context.rates);
    if (applicable.length === 0) {
      notes.push(`No Canadian tax rate is in force for ${placeOfSupply} at ${asOf.toISOString()}.`);
    }
  } else if (country === 'US') {
    if (mode !== 'table') {
      notes.push(`US_TAX_MODE=none. ${US_NON_COLLECTING_NOTE}`);
    } else if (!region) {
      notes.push('No state on the billing profile, so no US sales tax could be resolved.');
    } else {
      const candidates = selectRates(country, region, asOf, context.rates);
      if (candidates.length === 0) {
        notes.push(
          `SaaS is not treated as a taxable supply in ${placeOfSupply} by this rate table. ${US_NON_COLLECTING_NOTE}`,
        );
      } else {
        applicable = candidates.filter((row) => {
          const registered = findRegistration(registrations, country, row.region, row.code);
          if (!registered) {
            notes.push(
              `Not registered in ${jurisdictionCode(country, row.region)}; ${row.label} was not collected. Tax collected without a registration cannot be remitted.`,
            );
            return false;
          }
          return true;
        });
        if (applicable.length > 0) {
          notes.push(
            'State rate only — no county, city or special-district tax is included. Confirm with a tax service before filing.',
          );
        }
      }
    }
  } else {
    notes.push(`No tax table for country ${country}; no tax was applied.`);
  }

  const engine: 'table' | 'none' = applicable.length > 0 ? 'table' : 'none';

  return {
    placeOfSupply,
    notes,
    engine,
    forAmount(amountCents: number): TaxResolution {
      if (!Number.isInteger(amountCents)) {
        throw new Error(`Taxable amount must be integer cents, received ${amountCents}`);
      }

      const lines: ResolvedTaxLine[] = [];
      const byCode = new Map<string, number>();

      for (const row of applicable) {
        // Compounding: the base is the amount plus another component's tax.
        // Null everywhere in Canada today; the branch exists so the assumption
        // is explicit rather than invisible.
        const compoundOn = row.compoundsOnCode ? (byCode.get(row.compoundsOnCode) ?? 0) : 0;
        const base = amountCents + compoundOn;
        const { taxableCents, amountCents: tax } = taxAmountFor(
          base,
          row.rateParts,
          row.taxableBasisParts ?? PARTS_PER_UNIT,
        );
        byCode.set(row.code, tax);

        lines.push({
          taxRateId: row.id ?? null,
          code: row.code,
          label: row.label,
          jurisdiction: jurisdictionCode(row.country, row.region === '*' ? region : row.region),
          rateParts: row.rateParts,
          taxableCents,
          amountCents: tax,
          registrationNumber:
            findRegistration(registrations, row.country, row.region === '*' ? region : row.region, row.code)
              ?.number ?? null,
          source: 'table',
        });
      }

      return {
        lines,
        totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
        placeOfSupply,
        engine,
        notes,
      };
    },
  };
}

/** Resolve tax on a single amount. Thin wrapper over `buildTaxEngine`. */
export function resolveTax(input: TaxContext & { amountCents: number }): TaxResolution {
  return buildTaxEngine(input).forAmount(input.amountCents);
}

/** What gets frozen into `Invoice.taxSnapshot`. Frozen, not recomputed: a
 *  reissued PDF must state the tax that was charged, not today's rates. */
export interface TaxSnapshot {
  engine: 'table' | 'none';
  placeOfSupply: string;
  resolvedAt: string;
  registrationNumbers: Record<string, string>;
  notes: string[];
}

export function taxSnapshotFor(
  resolution: Pick<TaxResolution, 'engine' | 'placeOfSupply' | 'notes' | 'lines'>,
  resolvedAt = new Date(),
): TaxSnapshot {
  const registrationNumbers: Record<string, string> = {};
  for (const line of resolution.lines) {
    if (line.registrationNumber) registrationNumbers[line.code] = line.registrationNumber;
  }
  return {
    engine: resolution.engine,
    placeOfSupply: resolution.placeOfSupply,
    resolvedAt: resolvedAt.toISOString(),
    registrationNumbers,
    notes: resolution.notes,
  };
}

/** Sum tax lines by component for display (an invoice prints one "HST (13%)"
 *  row, not one per line item). */
export function summariseTaxLines(
  lines: Pick<ResolvedTaxLine, 'code' | 'label' | 'jurisdiction' | 'rateParts' | 'taxableCents' | 'amountCents' | 'registrationNumber'>[],
): {
  code: string;
  label: string;
  jurisdiction: string;
  rateParts: number;
  taxableCents: number;
  amountCents: number;
  registrationNumber: string | null;
}[] {
  const grouped = new Map<string, {
    code: string;
    label: string;
    jurisdiction: string;
    rateParts: number;
    taxableCents: number;
    amountCents: number;
    registrationNumber: string | null;
  }>();

  for (const line of lines) {
    const key = `${line.jurisdiction}|${line.code}|${line.rateParts}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.taxableCents += line.taxableCents;
      existing.amountCents += line.amountCents;
      existing.registrationNumber = existing.registrationNumber ?? line.registrationNumber ?? null;
    } else {
      grouped.set(key, {
        code: line.code,
        label: line.label,
        jurisdiction: line.jurisdiction,
        rateParts: line.rateParts,
        taxableCents: line.taxableCents,
        amountCents: line.amountCents,
        registrationNumber: line.registrationNumber ?? null,
      });
    }
  }

  return [...grouped.values()];
}

// ---------------------------------------------------------------------------
// Database-backed rates
// ---------------------------------------------------------------------------

/** The `TaxRate` columns this module reads. */
export interface TaxRateRecord {
  id: string;
  country: string;
  region: string;
  code: string;
  label: string;
  rateParts: number;
  taxableBasisParts: number;
  compoundsOnCode: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  active: boolean;
}

/** Map seeded `TaxRate` rows into the in-memory shape. */
export function taxRatesFromRecords(records: TaxRateRecord[]): TaxRateRow[] {
  return records
    .filter((row) => row.active)
    .map((row) => ({
      id: row.id,
      country: row.country,
      region: row.region,
      code: row.code,
      label: row.label,
      rateParts: row.rateParts,
      taxableBasisParts: row.taxableBasisParts,
      compoundsOnCode: row.compoundsOnCode,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : undefined,
    }));
}

/** `TaxRegistration` columns this module reads. */
export interface TaxRegistrationRecord {
  country: string;
  region: string;
  code: string;
  number: string;
  label: string;
  active: boolean;
}

export function taxRegistrationsFromRecords(
  records: TaxRegistrationRecord[],
): TaxRegistrationRow[] {
  return records.map((row) => ({
    country: row.country,
    region: row.region,
    code: row.code,
    number: row.number,
    label: row.label,
    active: row.active,
  }));
}

/** Minimal client surface, so this stays testable without Prisma. */
export interface TaxTableClient {
  taxRate: { findMany(args?: unknown): Promise<TaxRateRecord[]> };
  taxRegistration: { findMany(args?: unknown): Promise<TaxRegistrationRecord[]> };
}

/**
 * Load the effective-dated table from the database, falling back to the
 * built-in table when nothing has been seeded. Registrations have no fallback:
 * an unseeded registration table means "not registered", which is the safe
 * answer, topped up with whatever the environment declares.
 */
export async function loadTaxTable(
  client: TaxTableClient,
): Promise<{ rates: TaxRateRow[]; registrations: TaxRegistrationRow[] }> {
  const [rateRows, registrationRows] = await Promise.all([
    client.taxRate.findMany({ where: { active: true } }),
    client.taxRegistration.findMany({ where: { active: true } }),
  ]);

  const rates = rateRows.length > 0 ? taxRatesFromRecords(rateRows) : BUILT_IN_TAX_RATES;
  const registrations = [
    ...taxRegistrationsFromRecords(registrationRows),
    ...sellerRegistrations(),
  ];

  return { rates, registrations };
}

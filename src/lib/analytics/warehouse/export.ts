import { db } from '@/lib/db';
import { getStorageProvider } from '@/lib/storage';
import { eachDayKey, normalizeRange } from '../time';
import type { DateRange } from '../types';
import { MART_REGISTRY, type MartName } from '../platform/dictionary';

/**
 * Stage 21 (ADR-0036) - the WAREHOUSE EXTRACTION BOUNDARY.
 *
 * ADR-0012 stage 3 says a warehouse is adopted "only when volume justifies
 * it", and that the mart boundary is designed now so extraction is a change
 * of destination, not a rewrite. This is that boundary: every mart is a
 * table with a documented, stable column set and `day` as its partition key;
 * this module writes each mart's rows for a day range as one CSV per mart per
 * day under `warehouse/<mart>/<day>.csv` in the platform's object storage
 * (the Stage 09 provider - local by default, S3 when configured). A warehouse
 * loader (BigQuery, Snowflake, Redshift, DuckDB) reads those files; nothing
 * in the marts, the rollups or the dashboards changes when one is adopted.
 * `docs/architecture/WAREHOUSE_EXTRACTION.md` is the recipe.
 *
 * What is NOT exported: transactional tables (the boundary exists so they
 * never are), and the user-scoped candidate marts by default - a per-person
 * mart leaves the platform only with the residency decision that governs it
 * (ADR-0015), so it is opt-in and named in the audit of the export.
 */
export const WAREHOUSE_PREFIX = 'warehouse';

/** The columns each mart is extracted with: the stable contract a loader can rely on. */
export const MART_COLUMNS: Record<MartName, readonly string[]> = {
  DailyMetric: ['day', 'metric', 'dimension', 'valueInt', 'valueCents', 'valueParts'],
  DailyRevenueRollup: ['day', 'currency', 'invoicedCents', 'discountCents', 'taxCents', 'paidCents', 'refundedCents', 'creditedCents', 'feeCents', 'netCents', 'mrrCents', 'arrCents', 'newMrrCents', 'expansionMrrCents', 'contractionMrrCents', 'churnedMrrCents', 'reactivationMrrCents', 'arpuCents', 'activeSubscriptions', 'trialingSubscriptions', 'pastDueSubscriptions', 'canceledSubscriptions', 'payingCustomers', 'newCustomers', 'churnedCustomers', 'logoChurnParts', 'grossMrrChurnParts', 'netRevenueRetentionParts', 'dunningRecoveryParts', 'invoicesBilled', 'paymentsSucceeded', 'paymentsFailed', 'paymentsPending', 'failedPaymentCents', 'reactivatedCustomers'],
  SubscriptionCohortMart: ['day', 'currency', 'cohortMonth', 'monthOffset', 'subscribers', 'retained'],
  OrganizationDailyMart: ['day', 'organizationId', 'product', 'metric', 'dimension', 'key', 'valueInt', 'valueCents', 'people'],
  CandidateOutcomeMart: ['day', 'userId', 'dimension', 'key', 'applications', 'sent', 'responded', 'screens', 'interviews', 'offers', 'hires', 'rejected', 'withdrawn', 'ghosted', 'expired', 'failed', 'sumMatchScore', 'responseSamples', 'sumResponseHrs'],
  CandidateMatchMart: ['day', 'userId', 'matches', 'sumMatchScore', 'band0to49', 'band50to69', 'band70to84', 'band85to100', 'matchedKeywords', 'missingKeywords'],
  CandidateBenchmarkMart: ['day', 'dimension', 'key', 'users', 'applications', 'sent', 'responded', 'interviews', 'offers', 'hires'],
};

// A number is never neutralised (review M3: `-1500` must stay a number for a
// typed loader); only a STRING cell that starts like a formula gets the quote.
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function martCsv(mart: MartName, rows: Record<string, unknown>[]): string {
  const cols = MART_COLUMNS[mart];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

async function loadMartDay(mart: MartName, day: string): Promise<Record<string, unknown>[]> {
  switch (mart) {
    case 'DailyMetric':
      return db.dailyMetric.findMany({ where: { day }, orderBy: [{ metric: 'asc' }, { dimension: 'asc' }] });
    case 'DailyRevenueRollup':
      return db.dailyRevenueRollup.findMany({ where: { day }, orderBy: { currency: 'asc' } });
    case 'SubscriptionCohortMart':
      return db.subscriptionCohortMart.findMany({ where: { day }, orderBy: [{ currency: 'asc' }, { cohortMonth: 'asc' }, { monthOffset: 'asc' }] });
    case 'OrganizationDailyMart':
      return db.organizationDailyMart.findMany({ where: { day }, orderBy: [{ organizationId: 'asc' }, { product: 'asc' }, { metric: 'asc' }, { dimension: 'asc' }, { key: 'asc' }] });
    case 'CandidateBenchmarkMart':
      return db.candidateBenchmarkMart.findMany({ where: { day }, orderBy: [{ dimension: 'asc' }, { key: 'asc' }] });
    case 'CandidateOutcomeMart':
      return db.candidateOutcomeMart.findMany({ where: { day }, orderBy: [{ userId: 'asc' }, { dimension: 'asc' }, { key: 'asc' }] });
    case 'CandidateMatchMart':
      return db.candidateMatchMart.findMany({ where: { day }, orderBy: { userId: 'asc' } });
  }
}

/** The marts extracted by default: system- and organisation-scoped. The user-scoped candidate marts are opt-in. */
export const DEFAULT_EXPORT_MARTS: readonly MartName[] = ['DailyMetric', 'DailyRevenueRollup', 'SubscriptionCohortMart', 'OrganizationDailyMart', 'CandidateBenchmarkMart'];

export interface ExportResult {
  files: { key: string; rows: number }[];
  marts: MartName[];
  days: number;
}

export async function exportMarts(range: DateRange, options: { marts?: readonly MartName[]; put?: (key: string, body: string) => Promise<void>; exists?: (key: string) => Promise<boolean> } = {}): Promise<ExportResult> {
  const days = eachDayKey(normalizeRange(range));
  const marts = options.marts ?? DEFAULT_EXPORT_MARTS;
  for (const m of marts) if (!Object.hasOwn(MART_REGISTRY, m)) throw new Error(`Unknown mart: ${m}`);
  const put = options.put ?? (async (key: string, body: string) => (await getStorageProvider()).put(key, body));
  const exists = options.exists ?? (async (key: string) => (await (await getStorageProvider()).get(key)) !== null);
  const files: ExportResult['files'] = [];
  for (const mart of marts) {
    for (const day of days) {
      const rows = await loadMartDay(mart, day);
      const key = `${WAREHOUSE_PREFIX}/${mart}/${day}.csv`;
      if (rows.length === 0) {
        // A day that never had rows writes no file; a day whose rows a corrected
        // re-rollup removed must not leave the old partition behind (review L15):
        // it is overwritten with a header-only file, which a loader reads as empty.
        if (await exists(key)) {
          await put(key, martCsv(mart, []));
          files.push({ key, rows: 0 });
        }
        continue;
      }
      await put(key, martCsv(mart, rows));
      files.push({ key, rows: rows.length });
    }
  }
  return { files, marts: [...marts], days: days.length };
}

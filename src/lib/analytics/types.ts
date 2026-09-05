// Shared vocabulary for the analytics engine.
//
// Two rules run through every type in this file:
//
//   1. Money is always an integer number of cents. Never a float, never a
//      Decimal, never a formatted string in the data layer. Formatting is an
//      edge concern — see `formatCents` at the bottom.
//   2. Rates are integer PARTS PER MILLION, matching the `*Parts` convention
//      used throughout the Prisma schema. 1_000_000 = 100%. A `Rate` also
//      carries its numerator and denominator so a dashboard can render
//      "12 of 84" instead of a bare percentage, and so a zero denominator is
//      visible rather than hidden behind a 0%.
//
// Everything here is a plain, JSON-serialisable shape: instants are ISO-8601
// UTC strings, not Date objects, so a result can cross the server/client
// boundary or an API route without a custom serialiser.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** 1_000_000 parts = 100%. */
export const PARTS_PER_UNIT = 1_000_000;

/** The currency all normalised MRR is expressed in. */
export const BASE_CURRENCY = 'CAD';

export type Granularity = 'day' | 'week' | 'month';

/**
 * A half-open interval `[start, end)`.
 *
 * Half-open on purpose: consecutive ranges tile without double counting the
 * boundary instant, which is what makes daily rollups re-runnable.
 */
export interface DateRange {
  start: Date;
  end: Date;
}

/** One column of a time series. `end` is exclusive. */
export interface TimeBucket {
  /** Sortable key: `YYYY-MM-DD` for day and week, `YYYY-MM` for month. */
  key: string;
  /** Short human label, e.g. "Aug 3" or "Aug 2026". */
  label: string;
  start: Date;
  end: Date;
}

/** Fields every series point carries, so charts can share an axis component. */
export interface SeriesPointBase {
  bucket: string;
  label: string;
  /** ISO-8601 UTC, inclusive. */
  start: string;
  /** ISO-8601 UTC, exclusive. */
  end: string;
}

/**
 * A ratio that refuses to hide its denominator.
 *
 * `parts` is 0 whenever `denominator` is 0 — the single division-by-zero guard
 * every rate in this engine goes through.
 */
export interface Rate {
  numerator: number;
  denominator: number;
  /** Parts per million. May be negative (e.g. net MRR churn). */
  parts: number;
}

/** A counted group — top companies, top failure codes, top keywords. */
export interface GroupCount {
  key: string;
  count: number;
  /** Share of the total, parts per million. */
  parts: number;
}

// ---------------------------------------------------------------------------
// Customer metrics — inputs
// ---------------------------------------------------------------------------

/**
 * The subset of `Application` (joined to its `Job`) the metrics need.
 *
 * Deliberately structural rather than a Prisma type: every computation in
 * `metrics.ts` takes plain arrays so it can be unit-tested without a database.
 */
export interface ApplicationRow {
  id: string;
  /** queued | applying | ready_to_submit | submitted | failed | interviewing | offer | rejected | withdrawn */
  status: string;
  matchScore: number;
  createdAt: Date;
  appliedAt: Date | null;
  respondedAt: Date | null;
  /** Denormalised from the joined Job. */
  company: string;
  location: string;
}

/** Anything carrying a match score and a birth date — `JobMatch` or `Application`. */
export interface ScoredRow {
  matchScore: number;
  createdAt: Date;
}

/** A `JobMatch` with its keyword JSON columns already parsed. */
export interface KeywordRow {
  matchedKeywords: string[];
  missingKeywords: string[];
}

/** The subset of `Agent` used for per-agent performance. */
export interface AgentRow {
  id: string;
  name: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Customer metrics — results
// ---------------------------------------------------------------------------

/**
 * Where an application got to, as an ordered ladder.
 *
 * `Application.status` is a single column, not a history: an application that
 * interviewed and then received an offer only says "offer". So a stage is
 * inferred by ordering — an offer implies an interview happened, an interview
 * implies the employer responded, a response implies it was sent.
 */
export type FunnelStage = 'not_sent' | 'sent' | 'responded' | 'interview' | 'offer';

/** Rank of each stage on the ladder. Higher means further along. */
export const FUNNEL_ORDER: Record<FunnelStage, number> = {
  not_sent: 0,
  sent: 1,
  responded: 2,
  interview: 3,
  offer: 4,
};

/**
 * Counts for a set of applications.
 *
 * `sent`, `responded`, `interviews` and `offers` are CUMULATIVE — they count
 * applications that reached *at least* that stage, so they decrease
 * monotonically and can be drawn as a funnel without further arithmetic.
 * `rejected`, `withdrawn` and `failed` are snapshots of the current status.
 */
export interface ApplicationTotals {
  applications: number;
  notSent: number;
  sent: number;
  responded: number;
  interviews: number;
  offers: number;
  rejected: number;
  withdrawn: number;
  failed: number;
  /** Mean match score of the applications counted, one decimal. 0 when empty. */
  averageMatchScore: number;
}

export interface FunnelRates {
  /** responded-or-beyond / sent-or-beyond. */
  responseRate: Rate;
  /** interviewed-or-beyond / sent-or-beyond. */
  interviewRate: Rate;
  /** offers / sent-or-beyond. */
  offerRate: Rate;
  /** interviewed-or-beyond / responded-or-beyond — how many replies become interviews. */
  interviewFromResponse: Rate;
  /** offers / interviewed-or-beyond — how many interviews become offers. */
  offerFromInterview: Rate;
}

export interface ApplicationSeriesPoint extends SeriesPointBase {
  applications: number;
  sent: number;
  responded: number;
  interviews: number;
  offers: number;
}

export interface ApplicationGroup {
  key: string;
  applications: number;
  sent: number;
  responded: number;
  interviews: number;
  offers: number;
  /** Share of all applications in the range, parts per million. */
  parts: number;
}

/**
 * Elapsed time from submission to the employer's first reply.
 *
 * Only applications with BOTH `appliedAt` and `respondedAt` are sampled — an
 * application still waiting has no response time, and counting it as zero
 * would make a silent employer look fast.
 */
export interface ResponseTimeStats {
  samples: number;
  averageHours: number;
  medianHours: number;
  p90Hours: number;
  fastestHours: number;
  slowestHours: number;
}

export interface ScoreBucket {
  key: string;
  label: string;
  /** Inclusive lower bound. */
  min: number;
  /** Inclusive upper bound. */
  max: number;
  count: number;
  /** Share of all scored rows, parts per million. */
  parts: number;
}

export interface ScoreSeriesPoint extends SeriesPointBase {
  count: number;
  /**
   * Mean score in the bucket, one decimal.
   *
   * 0 when `count` is 0. Treat `count === 0` as "no data" and draw a gap —
   * plotting the zero as a real value invents a crash to a score of nothing.
   */
  averageScore: number;
}

export interface KeywordCount {
  keyword: string;
  /** Number of matches this keyword appeared in. */
  count: number;
  /** Share of matches containing it, parts per million. */
  parts: number;
}

export interface AgentPerformance {
  agentId: string;
  name: string;
  status: string;
  matches: number;
  averageMatchScore: number;
  applications: number;
  sent: number;
  responded: number;
  interviews: number;
  offers: number;
}

export interface ApplicationMetrics {
  range: { start: string; end: string };
  granularity: Granularity;
  totals: ApplicationTotals;
  funnel: FunnelRates;
  overTime: ApplicationSeriesPoint[];
  byCompany: ApplicationGroup[];
  byLocation: ApplicationGroup[];
  timeToFirstResponse: ResponseTimeStats;
}

export interface MatchMetrics {
  range: { start: string; end: string };
  granularity: Granularity;
  totalMatches: number;
  averageMatchScore: number;
  distribution: ScoreBucket[];
  trend: ScoreSeriesPoint[];
  topMatchedKeywords: KeywordCount[];
  /** The actionable half: what the resume keeps failing to mention. */
  topMissingKeywords: KeywordCount[];
}

export interface CustomerAnalytics {
  applications: ApplicationMetrics;
  matches: MatchMetrics;
  agents: AgentPerformance[];
}

// ---------------------------------------------------------------------------
// Revenue metrics — inputs
// ---------------------------------------------------------------------------

export interface SubscriptionRow {
  id: string;
  userId: string;
  /** trialing | active | past_due | grace | suspended | canceled */
  status: string;
  planCode: string;
  planName: string;
  /** monthly | quarterly | annual */
  interval: string;
  currency: string;
  /** CACHE column. Zero means "never written" — see `subscriptionMrrCents`. */
  mrrCents: number;
  /** Amount actually billed per interval, used as the fallback for `mrrCents`. */
  planPriceCents: number;
  startedAt: Date;
  canceledAt: Date | null;
}

export interface SubscriptionEventRow {
  userId: string;
  subscriptionId: string;
  type: string;
  movement: string | null;
  mrrBeforeCents: number;
  mrrAfterCents: number;
  /** Signed: negative for contraction and churn. */
  deltaMrrCents: number;
  occurredAt: Date;
}

export interface InvoiceRow {
  id: string;
  userId: string;
  /** draft | open | paid | void | uncollectible */
  status: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountRefundedCents: number;
  amountCreditedCents: number;
  issuedAt: Date | null;
  createdAt: Date;
}

export interface PaymentRow {
  id: string;
  userId: string;
  /** pending | requires_action | succeeded | failed | canceled | refunded | partially_refunded | disputed */
  status: string;
  currency: string;
  amountCents: number;
  amountRefundedCents: number;
  feeCents: number;
  failureCode: string | null;
  createdAt: Date;
  succeededAt: Date | null;
  failedAt: Date | null;
}

/** One retry a dunning cron actually made. Drives the recovery rate. */
export interface DunningAttemptRow {
  /** pending | succeeded | soft_decline | hard_decline | error | skipped_gateway_owned */
  outcome: string;
  scheduledFor: Date;
}

// ---------------------------------------------------------------------------
// Revenue metrics — results
// ---------------------------------------------------------------------------

export interface PlanBreakdown {
  planCode: string;
  planName: string;
  subscribers: number;
  mrrCents: number;
  /** Share of total MRR, parts per million. */
  parts: number;
}

export interface MrrSnapshot {
  currency: string;
  /** Sum of normalised monthly revenue across MRR-eligible subscriptions. */
  mrrCents: number;
  /** `mrrCents * 12`. Stored so dashboards stay arithmetic-free. */
  arrCents: number;
  /** `mrrCents / payingSubscribers`, rounded. 0 when there are none. */
  arpuCents: number;
  activeSubscribers: number;
  trialingSubscribers: number;
  pastDueSubscribers: number;
  suspendedSubscribers: number;
  canceledSubscribers: number;
  /** Subscriptions counted toward MRR — see `MRR_STATUSES`. */
  payingSubscribers: number;
  byPlan: PlanBreakdown[];
}

/**
 * The five movements that decompose a change in MRR.
 *
 * All five are reported as POSITIVE magnitudes — the direction is in the name,
 * which is how every SaaS board deck reads. `netNewMrrCents` re-applies the
 * signs: new + expansion + reactivation - contraction - churned.
 */
export interface MrrMovement {
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnedMrrCents: number;
  reactivationMrrCents: number;
  netNewMrrCents: number;
  newSubscribers: number;
  churnedSubscribers: number;
  reactivatedSubscribers: number;
}

export interface ChurnMetrics {
  /** Customers lost / customers at the start of the period. */
  logoChurn: Rate;
  /** (churned + contraction) MRR / MRR at the start. */
  grossMrrChurn: Rate;
  /** Gross churn less expansion and reactivation. Negative = net growth. */
  netMrrChurn: Rate;
  /** (start + expansion + reactivation - contraction - churned) / start. Excludes new business. */
  netRevenueRetention: Rate;
}

export interface LtvEstimate {
  arpuCents: number;
  monthlyChurn: Rate;
  /** Capped — see `computeLtv`. One decimal. */
  expectedLifetimeMonths: number;
  ltvCents: number;
  /** True when the cap bound the answer rather than the churn rate. */
  capped: boolean;
}

export interface CustomerLifetimeValue {
  userId: string;
  grossCents: number;
  refundedCents: number;
  feeCents: number;
  netCents: number;
  payments: number;
}

export interface RevenueSeriesPoint extends SeriesPointBase {
  invoices: number;
  invoicedCents: number;
  discountCents: number;
  taxCents: number;
  payments: number;
  paidCents: number;
  refundedCents: number;
  feeCents: number;
  /** paid - refunded - fees. */
  netCents: number;
}

export interface SubscriberSeriesPoint extends SeriesPointBase {
  newSubscribers: number;
  churnedSubscribers: number;
  reactivatedSubscribers: number;
  /** new + reactivated - churned. */
  netSubscribers: number;
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnedMrrCents: number;
  reactivationMrrCents: number;
  netNewMrrCents: number;
}

export interface PaymentSeriesPoint extends SeriesPointBase {
  succeeded: number;
  failed: number;
  pending: number;
  failedCents: number;
}

export interface PaymentHealth {
  currency: string;
  succeeded: number;
  failed: number;
  pending: number;
  /** failed / (failed + succeeded). */
  failureRate: Rate;
  failedCents: number;
  topFailureCodes: GroupCount[];
  overTime: PaymentSeriesPoint[];
}

export interface RevenueTotals {
  invoicedCents: number;
  discountCents: number;
  taxCents: number;
  paidCents: number;
  refundedCents: number;
  feeCents: number;
  netCents: number;
  invoices: number;
  payments: number;
}

export interface RevenueSummary {
  currency: string;
  range: { start: string; end: string };
  granularity: Granularity;
  mrr: MrrSnapshot;
  /** MRR at `range.start`, reconstructed from subscription events. */
  openingMrrCents: number;
  openingSubscribers: number;
  movement: MrrMovement;
  churn: ChurnMetrics;
  ltv: LtvEstimate;
  totals: RevenueTotals;
  revenueOverTime: RevenueSeriesPoint[];
  subscribersOverTime: SubscriberSeriesPoint[];
  paymentHealth: PaymentHealth;
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

export interface UsageEventRow {
  userId: string | null;
  name: string;
  quantity: number;
  valueCents: number;
  occurredAt: Date;
}

/** One row of `DailyUsageRollup`. `day` is a UTC `YYYY-MM-DD` key, not a Date. */
export interface UsageRollupRow {
  day: string;
  userId: string;
  metric: string;
  count: number;
  valueCents: number;
}

/** One row of `DailyMetric`. */
export interface DailyMetricRow {
  day: string;
  metric: string;
  dimension: string;
  valueInt: number;
  valueCents: number;
  valueParts: number;
}

/** One row of `DailyRevenueRollup`. */
export interface DailyRevenueRow {
  day: string;
  currency: string;
  invoicedCents: number;
  discountCents: number;
  taxCents: number;
  paidCents: number;
  refundedCents: number;
  creditedCents: number;
  feeCents: number;
  netCents: number;
  mrrCents: number;
  arrCents: number;
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnedMrrCents: number;
  reactivationMrrCents: number;
  arpuCents: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  canceledSubscriptions: number;
  payingCustomers: number;
  newCustomers: number;
  churnedCustomers: number;
  logoChurnParts: number;
  grossMrrChurnParts: number;
  netRevenueRetentionParts: number;
  dunningRecoveryParts: number;
  /** Stage 21 (ADR-0036): payment counts on the currency row, so payment health reads the mart. */
  invoicesBilled: number;
  paymentsSucceeded: number;
  paymentsFailed: number;
  paymentsPending: number;
  failedPaymentCents: number;
  reactivatedCustomers: number;
}

/** What a rollup job reports back. Mirrors the `RollupRun` model. */
export interface RollupResult {
  job: string;
  windowStart: string;
  windowEnd: string;
  days: number;
  rowsRead: number;
  rowsWritten: number;
  status: 'succeeded' | 'failed';
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers — the only arithmetic allowed to be shared
// ---------------------------------------------------------------------------

/**
 * Build a `Rate`, guarding division by zero.
 *
 * A zero (or negative, or non-finite) denominator yields 0 parts rather than
 * NaN or Infinity. Callers that need to distinguish "0%" from "no data" read
 * `denominator`.
 */
export function rate(numerator: number, denominator: number): Rate {
  const safeNumerator = Number.isFinite(numerator) ? numerator : 0;
  const safeDenominator = Number.isFinite(denominator) ? denominator : 0;
  if (safeDenominator <= 0) {
    return { numerator: safeNumerator, denominator: 0, parts: 0 };
  }
  return {
    numerator: safeNumerator,
    denominator: safeDenominator,
    parts: Math.round((safeNumerator * PARTS_PER_UNIT) / safeDenominator),
  };
}

/** A rate of exactly zero with a known denominator. Keeps empty results honest. */
export function zeroRate(denominator = 0): Rate {
  return { numerator: 0, denominator: Math.max(0, denominator), parts: 0 };
}

/** Mean of a list of numbers, rounded to one decimal. 0 for an empty list. */
export function average(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
}

/** Mean of a list of cents, rounded to a whole cent. 0 for an empty list. */
export function averageCents(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Nearest-rank percentile over a list that does NOT need to be pre-sorted.
 *
 * `p` is a fraction in [0, 1]. Returns 0 for an empty list.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clamped * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** Median, averaging the two middle values on an even count. 0 when empty. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/**
 * Stable descending sort by count, ties broken by key.
 *
 * Byte-wise rather than `localeCompare`, so the order is identical on every
 * machine and a snapshot test does not depend on the host's locale data.
 */
export function sortByCountDesc<T extends { key: string; count: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Edge formatting — presentation only, never used inside a computation
// ---------------------------------------------------------------------------

/**
 * Render integer cents as currency.
 *
 * Hand-rolled rather than `Intl.NumberFormat` so the output is byte-identical
 * on every machine regardless of the host's ICU data.
 */
export function formatCents(cents: number, currency: string = BASE_CURRENCY): string {
  const rounded = Math.round(Number.isFinite(cents) ? cents : 0);
  const negative = rounded < 0;
  const absolute = Math.abs(rounded);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'USD' ? 'US$' : '$';
  return `${negative ? '-' : ''}${symbol}${grouped}.${fraction}`;
}

/** Parts per million as a float percentage. Presentation only. */
export function partsToPercent(parts: number): number {
  return (Number.isFinite(parts) ? parts : 0) / 10_000;
}

/** Parts per million as a display string, e.g. `132000` -> "13.2%". */
export function formatParts(parts: number, digits = 1): string {
  return `${partsToPercent(parts).toFixed(digits)}%`;
}

/** A `Rate` as a display string, showing an em dash when there is no data. */
export function formatRate(value: Rate, digits = 1): string {
  if (value.denominator <= 0) return '—';
  return formatParts(value.parts, digits);
}

/** Whole hours as "3d 4h" / "6h" / "—" when there is nothing to show. */
export function formatDurationHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  const whole = Math.round(hours);
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  if (days === 0) return `${rest}h`;
  if (rest === 0) return `${days}d`;
  return `${days}d ${rest}h`;
}

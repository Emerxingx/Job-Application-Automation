// Customer-facing analytics: what an applicant sees on their dashboard.
//
// The file is in two halves.
//
//   1. Pure computation. Every function takes plain arrays and a date range
//      and returns a plain result. No database, no clock, no I/O — so the
//      whole funnel is unit-testable, and so the same code can run over rows
//      that came from a rollup table instead of the live tables.
//   2. Loaders. Thin Prisma queries that fetch the minimum set of columns and
//      hand them to the pure half.
//
// Empty input is a first-class case throughout: a brand-new user with zero
// applications gets a fully zeroed series and zeroed rates, never NaN and
// never a crash.

import { db } from '@/lib/db';
import { parseJson } from '@/lib/types';
import {
  average,
  FUNNEL_ORDER,
  median,
  percentile,
  rate,
  sortByCountDesc,
  zeroRate,
} from './types';
import type {
  AgentPerformance,
  AgentRow,
  ApplicationGroup,
  ApplicationMetrics,
  ApplicationRow,
  ApplicationSeriesPoint,
  ApplicationTotals,
  CustomerAnalytics,
  DateRange,
  FunnelRates,
  FunnelStage,
  Granularity,
  KeywordCount,
  KeywordRow,
  MatchMetrics,
  ResponseTimeStats,
  ScoreBucket,
  ScoredRow,
  ScoreSeriesPoint,
} from './types';
import {
  foldIntoBuckets,
  hoursBetween,
  isWithin,
  normalizeRange,
  rangeOfDays,
  seriesBase,
} from './time';

const UNKNOWN_GROUP = 'Unknown';

/** How a row is attributed to a point in time. */
export type Attribution =
  /** By `createdAt` — every application appears exactly once. */
  | 'created'
  /** By `appliedAt` — only applications that actually went out appear. */
  | 'sent';

export interface MetricsOptions {
  range: DateRange;
  granularity?: Granularity;
  /** Defaults to `'created'`. */
  by?: Attribution;
  /** How many entries `byCompany` / `byLocation` / keyword lists return. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// The funnel ladder
// ---------------------------------------------------------------------------

/**
 * How far an application got.
 *
 * `Application.status` holds only the CURRENT state, so the ladder is inferred:
 * an offer implies an interview, an interview implies a response, a response
 * implies the application was sent. `failed` is checked first — a submission
 * that errored never reached a human, whatever else the row says.
 */
export function stageOf(application: ApplicationRow): FunnelStage {
  if (application.status === 'failed') return 'not_sent';
  if (application.status === 'offer') return 'offer';
  if (application.status === 'interviewing') return 'interview';
  if (application.respondedAt !== null || application.status === 'rejected') return 'responded';
  if (application.appliedAt !== null || application.status === 'submitted') return 'sent';
  return 'not_sent';
}

/** Whether an application reached at least `stage`. */
export function reached(application: ApplicationRow, stage: FunnelStage): boolean {
  return FUNNEL_ORDER[stageOf(application)] >= FUNNEL_ORDER[stage];
}

/** The instant an application is attributed to, or null when it has none. */
export function attributionDate(
  application: ApplicationRow,
  by: Attribution = 'created',
): Date | null {
  return by === 'sent' ? application.appliedAt : application.createdAt;
}

// ---------------------------------------------------------------------------
// Totals and rates
// ---------------------------------------------------------------------------

/** Zeroed totals — the shape a user with no applications gets. */
export function emptyTotals(): ApplicationTotals {
  return {
    applications: 0,
    notSent: 0,
    sent: 0,
    responded: 0,
    interviews: 0,
    offers: 0,
    rejected: 0,
    withdrawn: 0,
    failed: 0,
    averageMatchScore: 0,
  };
}

export function computeTotals(rows: ApplicationRow[]): ApplicationTotals {
  const totals = emptyTotals();
  totals.applications = rows.length;

  for (const row of rows) {
    const stage = FUNNEL_ORDER[stageOf(row)];
    if (stage >= FUNNEL_ORDER.sent) totals.sent += 1;
    else totals.notSent += 1;
    if (stage >= FUNNEL_ORDER.responded) totals.responded += 1;
    if (stage >= FUNNEL_ORDER.interview) totals.interviews += 1;
    if (stage >= FUNNEL_ORDER.offer) totals.offers += 1;

    if (row.status === 'rejected') totals.rejected += 1;
    if (row.status === 'withdrawn') totals.withdrawn += 1;
    if (row.status === 'failed') totals.failed += 1;
  }

  totals.averageMatchScore = average(rows.map((row) => row.matchScore));
  return totals;
}

/**
 * The conversion rates, every one guarded against a zero denominator.
 *
 * Definitions, stated once so two dashboards cannot disagree:
 *   responseRate         responded-or-beyond / sent-or-beyond
 *   interviewRate        interviewed-or-beyond / sent-or-beyond
 *   offerRate            offers / sent-or-beyond
 *   interviewFromResponse interviewed-or-beyond / responded-or-beyond
 *   offerFromInterview   offers / interviewed-or-beyond
 *
 * Applications that never went out are excluded from every denominator: an
 * employer cannot fail to answer a message that was never sent.
 */
export function computeFunnel(totals: ApplicationTotals): FunnelRates {
  return {
    responseRate: rate(totals.responded, totals.sent),
    interviewRate: rate(totals.interviews, totals.sent),
    offerRate: rate(totals.offers, totals.sent),
    interviewFromResponse: rate(totals.interviews, totals.responded),
    offerFromInterview: rate(totals.offers, totals.interviews),
  };
}

/** Zeroed rates for the empty case — all five with denominator 0. */
export function emptyFunnel(): FunnelRates {
  return {
    responseRate: zeroRate(),
    interviewRate: zeroRate(),
    offerRate: zeroRate(),
    interviewFromResponse: zeroRate(),
    offerFromInterview: zeroRate(),
  };
}

// ---------------------------------------------------------------------------
// Applications over time
// ---------------------------------------------------------------------------

/**
 * Applications per bucket, with the funnel carried along so one query powers
 * both the volume chart and a stacked outcome chart.
 *
 * The series is seeded from the range, so every bucket exists even when it has
 * no rows — a quiet week is a visible zero, not a missing column.
 */
export function applicationsOverTime(
  rows: ApplicationRow[],
  range: DateRange,
  granularity: Granularity = 'day',
  by: Attribution = 'created',
): ApplicationSeriesPoint[] {
  return foldIntoBuckets<ApplicationRow, ApplicationSeriesPoint>(
    rows,
    range,
    granularity,
    (row) => attributionDate(row, by),
    (bucket) => ({
      ...seriesBase(bucket),
      applications: 0,
      sent: 0,
      responded: 0,
      interviews: 0,
      offers: 0,
    }),
    (point, row) => {
      const stage = FUNNEL_ORDER[stageOf(row)];
      point.applications += 1;
      if (stage >= FUNNEL_ORDER.sent) point.sent += 1;
      if (stage >= FUNNEL_ORDER.responded) point.responded += 1;
      if (stage >= FUNNEL_ORDER.interview) point.interviews += 1;
      if (stage >= FUNNEL_ORDER.offer) point.offers += 1;
    },
  );
}

// ---------------------------------------------------------------------------
// Grouping — by company, by location
// ---------------------------------------------------------------------------

/**
 * Group applications by an arbitrary key, keeping the funnel per group.
 *
 * Blank keys collapse into "Unknown" rather than an empty label. Ordering is
 * count-descending, ties broken byte-wise on the key, so the result is stable
 * across machines and across runs.
 */
export function groupApplications(
  rows: ApplicationRow[],
  keyOf: (row: ApplicationRow) => string,
  limit = 10,
): ApplicationGroup[] {
  const groups = new Map<string, ApplicationGroup>();

  for (const row of rows) {
    const key = keyOf(row).trim() || UNKNOWN_GROUP;
    let group = groups.get(key);
    if (!group) {
      group = { key, applications: 0, sent: 0, responded: 0, interviews: 0, offers: 0, parts: 0 };
      groups.set(key, group);
    }
    const stage = FUNNEL_ORDER[stageOf(row)];
    group.applications += 1;
    if (stage >= FUNNEL_ORDER.sent) group.sent += 1;
    if (stage >= FUNNEL_ORDER.responded) group.responded += 1;
    if (stage >= FUNNEL_ORDER.interview) group.interviews += 1;
    if (stage >= FUNNEL_ORDER.offer) group.offers += 1;
  }

  const total = rows.length;
  const ranked = sortByCountDesc(
    [...groups.values()].map((group) => ({ key: group.key, count: group.applications, group })),
  );

  return ranked.slice(0, Math.max(0, limit)).map((entry) => ({
    ...entry.group,
    parts: rate(entry.group.applications, total).parts,
  }));
}

export function applicationsByCompany(rows: ApplicationRow[], limit = 10): ApplicationGroup[] {
  return groupApplications(rows, (row) => row.company, limit);
}

export function applicationsByLocation(rows: ApplicationRow[], limit = 10): ApplicationGroup[] {
  return groupApplications(rows, (row) => row.location, limit);
}

// ---------------------------------------------------------------------------
// Time to first response
// ---------------------------------------------------------------------------

/**
 * Distribution of the wait between sending an application and hearing back.
 *
 * Only applications with both timestamps are sampled. An application still
 * waiting is not a zero-hour response — it has no response time at all, and
 * counting it would drag the average toward "instant" exactly when employers
 * are being slowest.
 */
export function timeToFirstResponse(rows: ApplicationRow[]): ResponseTimeStats {
  const samples: number[] = [];
  for (const row of rows) {
    if (!row.appliedAt || !row.respondedAt) continue;
    if (row.respondedAt < row.appliedAt) continue;
    samples.push(hoursBetween(row.appliedAt, row.respondedAt));
  }

  if (samples.length === 0) {
    return {
      samples: 0,
      averageHours: 0,
      medianHours: 0,
      p90Hours: 0,
      fastestHours: 0,
      slowestHours: 0,
    };
  }

  return {
    samples: samples.length,
    averageHours: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    medianHours: median(samples),
    p90Hours: percentile(samples, 0.9),
    fastestHours: Math.min(...samples),
    slowestHours: Math.max(...samples),
  };
}

// ---------------------------------------------------------------------------
// Match scores
// ---------------------------------------------------------------------------

const SCORE_BUCKET_SIZE = 10;

/**
 * Ten fixed 0-100 bands, always all ten present.
 *
 * Fixed bands rather than data-derived ones: the shape of this histogram is
 * only readable if it does not change axis every time a row is added. The top
 * band is inclusive of 100.
 */
export function matchScoreDistribution(rows: ScoredRow[]): ScoreBucket[] {
  const buckets: ScoreBucket[] = [];
  for (let lower = 0; lower < 100; lower += SCORE_BUCKET_SIZE) {
    const upper = lower + SCORE_BUCKET_SIZE - 1;
    const max = upper === 99 ? 100 : upper;
    buckets.push({
      key: `${lower}-${max}`,
      label: `${lower}-${max}`,
      min: lower,
      max,
      count: 0,
      parts: 0,
    });
  }

  for (const row of rows) {
    const score = Number.isFinite(row.matchScore) ? row.matchScore : 0;
    const clamped = Math.min(100, Math.max(0, Math.round(score)));
    const position = Math.min(buckets.length - 1, Math.floor(clamped / SCORE_BUCKET_SIZE));
    const bucket = buckets[position];
    if (bucket) bucket.count += 1;
  }

  const total = rows.length;
  for (const bucket of buckets) {
    bucket.parts = rate(bucket.count, total).parts;
  }
  return buckets;
}

/**
 * Average match score per bucket.
 *
 * `averageScore` is 0 where `count` is 0. Read the two together: a bucket with
 * no matches is a gap in the line, not a collapse to zero.
 */
export function matchScoreTrend(
  rows: ScoredRow[],
  range: DateRange,
  granularity: Granularity = 'day',
): ScoreSeriesPoint[] {
  // The running total lives on the point while folding and is dropped on the
  // way out: summing then dividing once keeps the average exact, where adding
  // a rolling average per row would accumulate rounding error.
  const points = foldIntoBuckets<ScoredRow, ScoreSeriesPoint & { total: number }>(
    rows,
    range,
    granularity,
    (row) => row.createdAt,
    (bucket) => ({ ...seriesBase(bucket), count: 0, averageScore: 0, total: 0 }),
    (point, row) => {
      point.count += 1;
      point.total += Number.isFinite(row.matchScore) ? row.matchScore : 0;
    },
  );

  return points.map((point) => ({
    bucket: point.bucket,
    label: point.label,
    start: point.start,
    end: point.end,
    count: point.count,
    averageScore: point.count === 0 ? 0 : Math.round((point.total / point.count) * 10) / 10,
  }));
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * Rank keywords by how many matches mention them.
 *
 * Counting is per ROW, not per occurrence: a keyword repeated three times in
 * one job description still counts once, so "React" cannot win on verbosity.
 * Grouping is case-insensitive; the surface form displayed is the one that
 * appeared most often, ties broken byte-wise for determinism.
 */
export function rankKeywords(lists: string[][], limit = 10): KeywordCount[] {
  const documents = lists.length;
  const counts = new Map<string, number>();
  const surfaces = new Map<string, Map<string, number>>();

  for (const list of lists) {
    const seen = new Set<string>();
    for (const raw of list) {
      const surface = typeof raw === 'string' ? raw.trim() : '';
      if (!surface) continue;
      const key = surface.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const forms = surfaces.get(key) ?? new Map<string, number>();
      forms.set(surface, (forms.get(surface) ?? 0) + 1);
      surfaces.set(key, forms);
    }
  }

  const ranked = sortByCountDesc([...counts.entries()].map(([key, count]) => ({ key, count })));

  return ranked.slice(0, Math.max(0, limit)).map(({ key, count }) => ({
    keyword: displayForm(key, surfaces.get(key)),
    count,
    parts: rate(count, documents).parts,
  }));
}

function displayForm(key: string, forms: Map<string, number> | undefined): string {
  if (!forms || forms.size === 0) return key;
  let best = key;
  let bestCount = -1;
  for (const [surface, count] of forms) {
    if (count > bestCount || (count === bestCount && surface < best)) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}

export function topMatchedKeywords(rows: KeywordRow[], limit = 10): KeywordCount[] {
  return rankKeywords(
    rows.map((row) => row.matchedKeywords),
    limit,
  );
}

/**
 * The actionable half of the keyword analysis.
 *
 * A keyword that keeps appearing here is a gap the applicant can close today
 * by editing one line of their resume, which is why it is surfaced with the
 * same prominence as the matched list rather than buried.
 */
export function topMissingKeywords(rows: KeywordRow[], limit = 10): KeywordCount[] {
  return rankKeywords(
    rows.map((row) => row.missingKeywords),
    limit,
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Per-agent throughput and outcomes, so a user can retire a dud agent. */
export function agentPerformance(
  agents: AgentRow[],
  matches: (ScoredRow & { agentId: string })[],
  applications: (ApplicationRow & { agentId: string | null })[],
): AgentPerformance[] {
  return agents.map((agent) => {
    const agentMatches = matches.filter((match) => match.agentId === agent.id);
    const agentApplications = applications.filter((app) => app.agentId === agent.id);
    const totals = computeTotals(agentApplications);
    return {
      agentId: agent.id,
      name: agent.name,
      status: agent.status,
      matches: agentMatches.length,
      averageMatchScore: average(agentMatches.map((match) => match.matchScore)),
      applications: totals.applications,
      sent: totals.sent,
      responded: totals.responded,
      interviews: totals.interviews,
      offers: totals.offers,
    };
  });
}

// ---------------------------------------------------------------------------
// Assembled results
// ---------------------------------------------------------------------------

/** Everything the applications dashboard needs, from one array of rows. */
export function computeApplicationMetrics(
  rows: ApplicationRow[],
  options: MetricsOptions,
): ApplicationMetrics {
  const range = normalizeRange(options.range);
  const granularity = options.granularity ?? 'day';
  const by = options.by ?? 'created';
  const limit = options.limit ?? 10;

  // Defensive: a loader may hand over rows outside the range (a cached page, a
  // wider query). Attribution decides membership, so filter with the same rule
  // the series uses.
  const inRange = rows.filter((row) => {
    const at = attributionDate(row, by);
    return at !== null && isWithin(range, at);
  });

  const totals = computeTotals(inRange);

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    granularity,
    totals,
    funnel: inRange.length === 0 ? emptyFunnel() : computeFunnel(totals),
    overTime: applicationsOverTime(inRange, range, granularity, by),
    byCompany: applicationsByCompany(inRange, limit),
    byLocation: applicationsByLocation(inRange, limit),
    timeToFirstResponse: timeToFirstResponse(inRange),
  };
}

/** Everything the match-quality dashboard needs. */
export function computeMatchMetrics(
  rows: (ScoredRow & KeywordRow)[],
  options: MetricsOptions,
): MatchMetrics {
  const range = normalizeRange(options.range);
  const granularity = options.granularity ?? 'day';
  const limit = options.limit ?? 10;
  const inRange = rows.filter((row) => isWithin(range, row.createdAt));

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    granularity,
    totalMatches: inRange.length,
    averageMatchScore: average(inRange.map((row) => row.matchScore)),
    distribution: matchScoreDistribution(inRange),
    trend: matchScoreTrend(inRange, range, granularity),
    topMatchedKeywords: topMatchedKeywords(inRange, limit),
    topMissingKeywords: topMissingKeywords(inRange, limit),
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Map a Prisma `Application` joined to its `Job` onto the flat metrics row. */
export function toApplicationRow(row: {
  id: string;
  status: string;
  matchScore: number;
  createdAt: Date;
  appliedAt: Date | null;
  respondedAt: Date | null;
  agentId?: string | null;
  job: { company: string; location: string };
}): ApplicationRow & { agentId: string | null } {
  return {
    id: row.id,
    status: row.status,
    matchScore: row.matchScore,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
    respondedAt: row.respondedAt,
    company: row.job.company,
    location: row.job.location,
    agentId: row.agentId ?? null,
  };
}

/** Load one user's applications for a range, already flattened. */
export async function loadApplicationRows(
  userId: string,
  options: { range: DateRange; by?: Attribution },
): Promise<(ApplicationRow & { agentId: string | null })[]> {
  const range = normalizeRange(options.range);
  const by = options.by ?? 'created';
  const window = { gte: range.start, lt: range.end };

  const rows = await db.application.findMany({
    where: {
      userId,
      ...(by === 'sent' ? { appliedAt: window } : { createdAt: window }),
    },
    select: {
      id: true,
      status: true,
      matchScore: true,
      createdAt: true,
      appliedAt: true,
      respondedAt: true,
      agentId: true,
      job: { select: { company: true, location: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map(toApplicationRow);
}

/**
 * Load one user's job matches for a range, with the keyword JSON parsed.
 *
 * `JobMatch` has no `userId` — ownership runs through its agent, so the filter
 * is on the relation. The keyword columns are JSON stored as text (a
 * baseline-schema decision ADR-0002 defers converting; see the migration
 * notes), parsed here via the codebase's `parseJson` fallback so a malformed
 * column yields an empty list instead of throwing mid-dashboard.
 */
export async function loadMatchRows(
  userId: string,
  options: { range: DateRange },
): Promise<(ScoredRow & KeywordRow & { agentId: string })[]> {
  const range = normalizeRange(options.range);

  const rows = await db.jobMatch.findMany({
    where: { agent: { userId }, createdAt: { gte: range.start, lt: range.end } },
    select: {
      agentId: true,
      matchScore: true,
      createdAt: true,
      matchedKeywords: true,
      missingKeywords: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => ({
    agentId: row.agentId,
    matchScore: row.matchScore,
    createdAt: row.createdAt,
    matchedKeywords: parseJson<string[]>(row.matchedKeywords, []),
    missingKeywords: parseJson<string[]>(row.missingKeywords, []),
  }));
}

export async function loadApplicationMetrics(
  userId: string,
  options: MetricsOptions,
): Promise<ApplicationMetrics> {
  const rows = await loadApplicationRows(userId, { range: options.range, by: options.by });
  return computeApplicationMetrics(rows, options);
}

export async function loadMatchMetrics(
  userId: string,
  options: MetricsOptions,
): Promise<MatchMetrics> {
  const rows = await loadMatchRows(userId, { range: options.range });
  return computeMatchMetrics(rows, options);
}

/**
 * One call for the whole customer dashboard.
 *
 * Three queries rather than one join: applications, matches and agents have
 * different cardinalities, and joining them would multiply rows before they
 * were counted.
 */
export async function loadCustomerAnalytics(
  userId: string,
  options?: Partial<MetricsOptions>,
): Promise<CustomerAnalytics> {
  const resolved: MetricsOptions = {
    range: options?.range ?? rangeOfDays(30),
    granularity: options?.granularity ?? 'day',
    by: options?.by ?? 'created',
    limit: options?.limit ?? 10,
  };

  const [applications, matches, agents] = await Promise.all([
    loadApplicationRows(userId, { range: resolved.range, by: resolved.by }),
    loadMatchRows(userId, { range: resolved.range }),
    db.agent.findMany({
      where: { userId },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return {
    applications: computeApplicationMetrics(applications, resolved),
    matches: computeMatchMetrics(matches, resolved),
    agents: agentPerformance(agents, matches, applications),
  };
}

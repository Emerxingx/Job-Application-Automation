/**
 * Stage 13 - what the candidate dashboards READ: the marts, on the tenant
 * path, through the dictionary. No function here touches a transactional
 * table (a static test enforces it), and no function computes a rate any
 * way but `rateOf`.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { parseJson } from '@/lib/types';
import { bucketKeyOf, buildBuckets, eachDayKey, normalizeRange, parseDayKey } from '../time';
import { rate, type DateRange, type Granularity, type Rate } from '../types';
import { addCounts, DIMENSIONS, emptyCounts, rateOf, suppressSmallCohort, valueOf, type Dimension, type OutcomeCounts, type Suppressed } from './dictionary';
import type { KeywordTally } from './marts';

type Tx = Prisma.TransactionClient;

export interface OutcomeSeriesPoint {
  key: string;
  label: string;
  start: string;
  applications: number;
  sent: number;
  responded: number;
  interviews: number;
  offers: number;
}

export interface OutcomeCut extends OutcomeCounts {
  key: string;
  responseRate: Rate;
  interviewRate: Rate;
  offerRate: Rate;
  /** Share of the range's applications, parts per million. */
  parts: number;
}

export interface CandidateOutcomes {
  range: { start: string; end: string };
  granularity: Granularity;
  totals: OutcomeCounts;
  rates: {
    responseRate: Rate;
    screenRate: Rate;
    interviewRate: Rate;
    offerRate: Rate;
    hireRate: Rate;
    interviewFromResponse: Rate;
    offerFromInterview: Rate;
  };
  averageMatchScore: number;
  averageResponseHours: number;
  overTime: OutcomeSeriesPoint[];
  cuts: Record<Exclude<Dimension, 'all'>, OutcomeCut[]>;
}

const MART_SELECT = { day: true, dimension: true, key: true, applications: true, sent: true, responded: true, screens: true, interviews: true, offers: true, hires: true, rejected: true, withdrawn: true, ghosted: true, expired: true, failed: true, sumMatchScore: true, responseSamples: true, sumResponseHrs: true } as const;

type MartRead = { day: string; dimension: string; key: string } & OutcomeCounts;

function countsFrom(r: MartRead): OutcomeCounts {
  return { applications: r.applications, sent: r.sent, responded: r.responded, screens: r.screens, interviews: r.interviews, offers: r.offers, hires: r.hires, rejected: r.rejected, withdrawn: r.withdrawn, ghosted: r.ghosted, expired: r.expired, failed: r.failed, sumMatchScore: r.sumMatchScore, responseSamples: r.responseSamples, sumResponseHrs: r.sumResponseHrs };
}

export function ratesOf(counts: OutcomeCounts): CandidateOutcomes['rates'] {
  return {
    responseRate: rateOf('response_rate', counts),
    screenRate: rateOf('screen_rate', counts),
    interviewRate: rateOf('interview_rate', counts),
    offerRate: rateOf('offer_rate', counts),
    hireRate: rateOf('hire_rate', counts),
    interviewFromResponse: rateOf('interview_from_response', counts),
    offerFromInterview: rateOf('offer_from_interview', counts),
  };
}

/** Assemble the dashboard shape from mart rows - pure, so the parity test can run it over rows it built itself. */
export function assembleOutcomes(rows: MartRead[], range: DateRange, granularity: Granularity = 'day', limit = 10): CandidateOutcomes {
  const window = normalizeRange(range);
  const totals = emptyCounts();
  const buckets = buildBuckets(window, granularity);
  const series = new Map(buckets.map((b) => [b.key, { key: b.key, label: b.label, start: b.start.toISOString(), applications: 0, sent: 0, responded: 0, interviews: 0, offers: 0 }]));
  const cuts: Record<string, Map<string, OutcomeCounts>> = {};
  for (const d of DIMENSIONS) if (d !== 'all') cuts[d] = new Map();

  for (const r of rows) {
    const counts = countsFrom(r);
    if (r.dimension === 'all') {
      addCounts(totals, counts);
      const point = series.get(bucketKeyOf(parseDayKey(r.day), granularity));
      if (point) {
        point.applications += counts.applications;
        point.sent += counts.sent;
        point.responded += counts.responded;
        point.interviews += counts.interviews;
        point.offers += counts.offers;
      }
    } else if (cuts[r.dimension]) {
      const existing = cuts[r.dimension].get(r.key) ?? emptyCounts();
      cuts[r.dimension].set(r.key, addCounts(existing, counts));
    }
  }

  const cutViews = {} as CandidateOutcomes['cuts'];
  for (const d of Object.keys(cuts) as Exclude<Dimension, 'all'>[]) {
    cutViews[d] = [...cuts[d].entries()]
      .map(([key, c]) => ({ key, ...c, responseRate: rateOf('response_rate', c), interviewRate: rateOf('interview_rate', c), offerRate: rateOf('offer_rate', c), parts: rate(c.applications, totals.applications).parts }))
      .sort((a, b) => b.applications - a.applications || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  return {
    range: { start: window.start.toISOString(), end: window.end.toISOString() },
    granularity,
    totals,
    rates: ratesOf(totals),
    averageMatchScore: valueOf('average_match_score', totals),
    averageResponseHours: valueOf('average_response_hours', totals),
    overTime: [...series.values()],
    cuts: cutViews,
  };
}

/** One candidate's outcomes for a range, from the mart, on the tenant path. */
export async function readCandidateOutcomes(tx: Tx, userId: string, range: DateRange, granularity: Granularity = 'day', limit = 10): Promise<CandidateOutcomes> {
  const window = normalizeRange(range);
  const days = eachDayKey(window);
  const rows = days.length === 0 ? [] : await tx.candidateOutcomeMart.findMany({ where: { userId, day: { in: days } }, select: MART_SELECT, orderBy: [{ day: 'asc' }, { dimension: 'asc' }, { key: 'asc' }] });
  return assembleOutcomes(rows, window, granularity, limit);
}

/** Lifetime totals for the overview widgets - every mart row the candidate has. */
export async function readCandidateTotals(tx: Tx, userId: string): Promise<OutcomeCounts> {
  const rows = await tx.candidateOutcomeMart.findMany({ where: { userId, dimension: 'all' }, select: MART_SELECT });
  const totals = emptyCounts();
  for (const r of rows) addCounts(totals, countsFrom(r));
  return totals;
}

export interface CandidateMatches {
  totalMatches: number;
  averageMatchScore: number;
  bands: { band: string; count: number; parts: number }[];
  topMatchedKeywords: (KeywordTally & { parts: number })[];
  topMissingKeywords: (KeywordTally & { parts: number })[];
}

function mergeKeywords(lists: KeywordTally[][], total: number, limit: number): (KeywordTally & { parts: number })[] {
  const counter = new Map<string, number>();
  for (const list of lists) for (const k of list) counter.set(k.keyword, (counter.get(k.keyword) ?? 0) + k.count);
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count, parts: rate(count, total).parts }));
}

/** Match quality for a range, from the match mart. */
export async function readCandidateMatches(tx: Tx, userId: string, range: DateRange, limit = 10): Promise<CandidateMatches> {
  const window = normalizeRange(range);
  const days = eachDayKey(window);
  const rows = days.length === 0 ? [] : await tx.candidateMatchMart.findMany({ where: { userId, day: { in: days } } });
  const total = rows.reduce((n, r) => n + r.matches, 0);
  const sum = rows.reduce((n, r) => n + r.sumMatchScore, 0);
  const bandCounts = { '0-49': 0, '50-69': 0, '70-84': 0, '85-100': 0 };
  for (const r of rows) {
    bandCounts['0-49'] += r.band0to49;
    bandCounts['50-69'] += r.band50to69;
    bandCounts['70-84'] += r.band70to84;
    bandCounts['85-100'] += r.band85to100;
  }
  return {
    totalMatches: total,
    averageMatchScore: total === 0 ? 0 : Math.round((sum / total) * 10) / 10,
    bands: Object.entries(bandCounts).map(([band, count]) => ({ band, count, parts: rate(count, total).parts })),
    topMatchedKeywords: mergeKeywords(rows.map((r) => parseJson<KeywordTally[]>(r.matchedKeywords, [])), total, limit),
    topMissingKeywords: mergeKeywords(rows.map((r) => parseJson<KeywordTally[]>(r.missingKeywords, [])), total, limit),
  };
}

export interface Benchmark {
  dimension: Dimension;
  key: string;
  users: number;
  sent: number;
  responseRate: Rate;
  interviewRate: Rate;
  offerRate: Rate;
}

/**
 * The platform benchmark for one cut over a range, with small-cohort
 * suppression applied. Read on the SYSTEM client: the benchmark is
 * system-only and carries no user id, and the suppression rule is applied
 * before anything leaves this function.
 */
export async function readBenchmark(dimension: Dimension, key: string, range: DateRange): Promise<Suppressed<Benchmark>> {
  const window = normalizeRange(range);
  const days = eachDayKey(window);
  if (days.length === 0) return suppressSmallCohort<Benchmark>(null);
  const rows = await db.candidateBenchmarkMart.findMany({ where: { dimension, key, day: { in: days } } });
  if (rows.length === 0) return suppressSmallCohort<Benchmark>(null);
  // Distinct people over a range cannot be summed from per-day rows without
  // double counting, so the cohort is the LARGEST single-day cohort - the
  // conservative reading: it can only understate the cohort, never overstate it.
  const users = Math.max(...rows.map((r) => r.users));
  const counts = emptyCounts();
  for (const r of rows) addCounts(counts, { ...emptyCounts(), applications: r.applications, sent: r.sent, responded: r.responded, interviews: r.interviews, offers: r.offers, hires: r.hires });
  return suppressSmallCohort<Benchmark>({ dimension, key, users, sent: counts.sent, responseRate: rateOf('response_rate', counts), interviewRate: rateOf('interview_rate', counts), offerRate: rateOf('offer_rate', counts) });
}

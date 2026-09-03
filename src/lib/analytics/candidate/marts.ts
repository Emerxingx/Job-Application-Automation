/**
 * Stage 13 - building the candidate outcome marts, purely.
 *
 * Input: one flat fact per application (what the transactional tables say,
 * loaded once by the rollup). Output: mart rows for every (day, dimension,
 * key) the facts touch, deterministic in order and content, so two runs over
 * the same facts are byte-identical and a diff means the data changed.
 *
 * Reach is inferred from the status HISTORY plus the current status, never
 * from the current status alone: an application that interviewed and was
 * then rejected still counts as an interview.
 */
import { dayKey, hoursBetween } from '../time';
import { addCounts, emptyCounts, scoreBand, seniorityOf, type Dimension, type OutcomeCounts } from './dictionary';

export interface ApplicationFact {
  id: string;
  userId: string;
  createdAt: Date;
  status: string;
  appliedAt: Date | null;
  respondedAt: Date | null;
  outcome: string;
  matchScore: number;
  /** Every status the record has ever been in, including the current one. */
  reached: string[];
  /** Interview kinds recorded in the folder. */
  interviewKinds: string[];
  title: string;
  normalizedTitle: string;
  company: string;
  location: string;
  country: string;
  source: string;
  /** The tailored resume's DocumentVersion.version for this application, or null. */
  resumeVersion: number | null;
}

export interface MartRow extends OutcomeCounts {
  userId: string;
  day: string;
  dimension: Dimension;
  key: string;
}

const SENT_EVER = new Set(['submitted', 'interviewing', 'offer']);
const RESPONDED_EVER = new Set(['interviewing', 'offer', 'rejected']);

/** Whether the record ever reached a status in `set` - its history or its current status. */
function ever(fact: ApplicationFact, set: Set<string>): boolean {
  return set.has(fact.status) || fact.reached.some((s) => set.has(s));
}

export function countsOf(fact: ApplicationFact): OutcomeCounts {
  const c = emptyCounts();
  c.applications = 1;
  // Sent: it went out (appliedAt), or it ever stood at submitted or beyond. A
  // rejection or a withdrawal on its own is not evidence of sending.
  const wasSent = fact.appliedAt !== null || ever(fact, SENT_EVER);
  if (wasSent) c.sent = 1;
  if (wasSent && (fact.respondedAt !== null || ever(fact, RESPONDED_EVER))) c.responded = 1;
  if (fact.interviewKinds.includes('phone')) c.screens = 1;
  if (ever(fact, new Set(['interviewing', 'offer']))) c.interviews = 1;
  if (ever(fact, new Set(['offer']))) c.offers = 1;
  if (fact.outcome === 'hired') c.hires = 1;
  if (fact.status === 'rejected') c.rejected = 1;
  if (fact.status === 'withdrawn') c.withdrawn = 1;
  if (fact.status === 'failed') c.failed = 1;
  if (fact.outcome === 'ghosted') c.ghosted = 1;
  if (fact.outcome === 'expired') c.expired = 1;
  c.sumMatchScore = Math.round(fact.matchScore);
  if (fact.appliedAt && fact.respondedAt && fact.respondedAt >= fact.appliedAt) {
    c.responseSamples = 1;
    c.sumResponseHrs = Math.round(hoursBetween(fact.appliedAt, fact.respondedAt));
  }
  return c;
}

function normaliseKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120) || 'unknown';
}

/** Where a fact lands on every dimension. `all` is the undimensioned total. */
export function keysOf(fact: ApplicationFact): Record<Dimension, string> {
  const region = fact.location.split(',')[0]?.trim() || fact.location.trim();
  return {
    all: 'all',
    title: normaliseKey(fact.normalizedTitle || fact.title),
    company: normaliseKey(fact.company),
    seniority: seniorityOf(fact.title),
    geography: normaliseKey(`${fact.country}:${region}`),
    source: normaliseKey(fact.source),
    resume_version: fact.resumeVersion === null ? 'none' : `v${fact.resumeVersion}`,
    score_band: scoreBand(fact.matchScore),
  };
}

export const DIMENSION_ORDER: Dimension[] = ['all', 'title', 'company', 'seniority', 'geography', 'source', 'resume_version', 'score_band'];

/** Fold facts into mart rows: (user, day, dimension, key) -> summed counts, sorted deterministically. */
export function buildOutcomeMart(facts: ApplicationFact[]): MartRow[] {
  const rows = new Map<string, MartRow>();
  for (const fact of facts) {
    const day = dayKey(fact.createdAt);
    const counts = countsOf(fact);
    const keys = keysOf(fact);
    for (const dimension of DIMENSION_ORDER) {
      const key = keys[dimension];
      const id = `${fact.userId} ${day} ${dimension} ${key}`;
      const row = rows.get(id) ?? { userId: fact.userId, day, dimension, key, ...emptyCounts() };
      addCounts(row, counts);
      rows.set(id, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.userId.localeCompare(b.userId) || a.day.localeCompare(b.day) || DIMENSION_ORDER.indexOf(a.dimension) - DIMENSION_ORDER.indexOf(b.dimension) || a.key.localeCompare(b.key));
}

// --- match marts ------------------------------------------------------------------

export interface MatchFact {
  userId: string;
  createdAt: Date;
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
}

export interface KeywordTally {
  keyword: string;
  count: number;
}

export interface MatchMartRow {
  userId: string;
  day: string;
  matches: number;
  sumMatchScore: number;
  band0to49: number;
  band50to69: number;
  band70to84: number;
  band85to100: number;
  matchedKeywords: KeywordTally[];
  missingKeywords: KeywordTally[];
}

const TOP_KEYWORDS = 20;

function topOf(counter: Map<string, number>): KeywordTally[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_KEYWORDS)
    .map(([keyword, count]) => ({ keyword, count }));
}

export function buildMatchMart(facts: MatchFact[]): MatchMartRow[] {
  const rows = new Map<string, { row: MatchMartRow; matched: Map<string, number>; missing: Map<string, number> }>();
  for (const fact of facts) {
    const day = dayKey(fact.createdAt);
    const id = `${fact.userId} ${day}`;
    const entry = rows.get(id) ?? { row: { userId: fact.userId, day, matches: 0, sumMatchScore: 0, band0to49: 0, band50to69: 0, band70to84: 0, band85to100: 0, matchedKeywords: [], missingKeywords: [] }, matched: new Map<string, number>(), missing: new Map<string, number>() };
    entry.row.matches += 1;
    entry.row.sumMatchScore += Math.round(fact.matchScore);
    const band = scoreBand(fact.matchScore);
    if (band === '85-100') entry.row.band85to100 += 1;
    else if (band === '70-84') entry.row.band70to84 += 1;
    else if (band === '50-69') entry.row.band50to69 += 1;
    else entry.row.band0to49 += 1;
    for (const k of new Set(fact.matchedKeywords.map((s) => s.toLowerCase().trim()).filter(Boolean))) entry.matched.set(k, (entry.matched.get(k) ?? 0) + 1);
    for (const k of new Set(fact.missingKeywords.map((s) => s.toLowerCase().trim()).filter(Boolean))) entry.missing.set(k, (entry.missing.get(k) ?? 0) + 1);
    rows.set(id, entry);
  }
  return [...rows.values()]
    .map((e) => ({ ...e.row, matchedKeywords: topOf(e.matched), missingKeywords: topOf(e.missing) }))
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.day.localeCompare(b.day));
}

// --- benchmarks ------------------------------------------------------------------

export interface BenchmarkRow {
  day: string;
  dimension: Dimension;
  key: string;
  users: number;
  applications: number;
  sent: number;
  responded: number;
  interviews: number;
  offers: number;
  hires: number;
}

/** Cross-user aggregates per (day, dimension, key) with the DISTINCT user count the suppression rule needs. */
export function buildBenchmarkMart(martRows: MartRow[]): BenchmarkRow[] {
  const rows = new Map<string, BenchmarkRow & { userSet: Set<string> }>();
  for (const r of martRows) {
    const id = `${r.day} ${r.dimension} ${r.key}`;
    const b = rows.get(id) ?? { day: r.day, dimension: r.dimension, key: r.key, users: 0, applications: 0, sent: 0, responded: 0, interviews: 0, offers: 0, hires: 0, userSet: new Set<string>() };
    b.userSet.add(r.userId);
    b.applications += r.applications;
    b.sent += r.sent;
    b.responded += r.responded;
    b.interviews += r.interviews;
    b.offers += r.offers;
    b.hires += r.hires;
    rows.set(id, b);
  }
  return [...rows.values()]
    .map(({ userSet, ...b }) => ({ ...b, users: userSet.size }))
    .sort((a, b) => a.day.localeCompare(b.day) || DIMENSION_ORDER.indexOf(a.dimension) - DIMENSION_ORDER.indexOf(b.dimension) || a.key.localeCompare(b.key));
}

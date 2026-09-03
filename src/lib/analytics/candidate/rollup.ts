/**
 * Stage 13 - the candidate mart rollup job (ADR-0012, ADR-0027).
 *
 * The ONLY code that reads the transactional tables for candidate analytics.
 * It loads one flat fact per application (with its status history, its
 * interviews, its job and its tailored resume version) and per match, folds
 * them with the pure builders, and REPLACES the mart rows for the (days x
 * user) scope - never increments - so any number of runs over any range
 * converge on the same rows. The platform benchmark is rebuilt from the
 * outcome mart for the same days.
 *
 * There is no scheduler (ADR-0011 is not built). The job runs from the
 * operator's sweep (`npm run analytics:rollup`), from the candidate's own
 * "refresh" on their analytics page (their rows only), and inline the first
 * time a candidate with applications opens the page with no rows yet. A
 * `RollupRun` row records every run so a silently skipped night is visible.
 */
import { db } from '@/lib/db';
import { parseJson } from '@/lib/types';
import { dayKey, eachDayKey, snapToUtcDays } from '../time';
import type { DateRange } from '../types';
import { buildBenchmarkMart, buildMatchMart, buildOutcomeMart, type ApplicationFact, type MatchFact } from './marts';

export const CANDIDATE_ROLLUP_JOB = 'candidate_outcomes';
const INSERT_CHUNK = 100;

export interface CandidateRollupResult {
  job: string;
  windowStart: string;
  windowEnd: string;
  days: number;
  applicationsRead: number;
  matchesRead: number;
  outcomeRows: number;
  matchRows: number;
  benchmarkRows: number;
  status: 'succeeded';
}

/** Load the facts for every application CREATED in the window (one user, or everyone). */
export async function loadApplicationFacts(range: DateRange, userId?: string): Promise<ApplicationFact[]> {
  const rows = await db.application.findMany({
    where: { createdAt: { gte: range.start, lt: range.end }, ...(userId ? { userId } : {}) },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      status: true,
      appliedAt: true,
      respondedAt: true,
      outcome: true,
      matchScore: true,
      job: { select: { title: true, normalizedTitle: true, company: true, location: true, country: true, source: true } },
      statusHistory: { select: { toStatus: true } },
      interviews: { select: { kind: true } },
      documents: { where: { kind: 'resume' }, select: { version: true }, orderBy: { version: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    createdAt: r.createdAt,
    status: r.status,
    appliedAt: r.appliedAt,
    respondedAt: r.respondedAt,
    outcome: r.outcome,
    matchScore: r.matchScore,
    reached: r.statusHistory.map((h) => h.toStatus),
    interviewKinds: r.interviews.map((i) => i.kind),
    title: r.job.title,
    normalizedTitle: r.job.normalizedTitle,
    company: r.job.company,
    location: r.job.location,
    country: r.job.country,
    source: r.job.source,
    resumeVersion: r.documents[0]?.version ?? null,
  }));
}

/** Load every match CREATED in the window; ownership runs through the agent. */
export async function loadMatchFacts(range: DateRange, userId?: string): Promise<MatchFact[]> {
  const rows = await db.jobMatch.findMany({
    where: { createdAt: { gte: range.start, lt: range.end }, ...(userId ? { agent: { userId } } : {}) },
    select: { createdAt: true, matchScore: true, matchedKeywords: true, missingKeywords: true, agent: { select: { userId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    userId: r.agent.userId,
    createdAt: r.createdAt,
    matchScore: r.matchScore,
    matchedKeywords: parseJson<string[]>(r.matchedKeywords, []),
    missingKeywords: parseJson<string[]>(r.missingKeywords, []),
  }));
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Recompute the candidate marts for a range. The whole (days x user) scope is
 * deleted and rewritten from the facts inside one transaction per table, so a
 * reader never sees a half-replaced day.
 */
export async function rollupCandidateOutcomes(range: DateRange, options: { userId?: string } = {}): Promise<CandidateRollupResult> {
  const window = snapToUtcDays(range);
  const days = eachDayKey(window);
  const run = await db.rollupRun.create({ data: { job: CANDIDATE_ROLLUP_JOB, windowStart: window.start, windowEnd: window.end, status: 'running' } });
  try {
    const [facts, matchFacts] = await Promise.all([loadApplicationFacts(window, options.userId), loadMatchFacts(window, options.userId)]);
    const outcomeRows = buildOutcomeMart(facts);
    const matchRows = buildMatchMart(matchFacts);
    const scope = { day: { in: days }, ...(options.userId ? { userId: options.userId } : {}) };

    await db.$transaction(async (tx) => {
      await tx.candidateOutcomeMart.deleteMany({ where: scope });
      for (const chunk of chunks(outcomeRows, INSERT_CHUNK)) await tx.candidateOutcomeMart.createMany({ data: chunk });
    });
    await db.$transaction(async (tx) => {
      await tx.candidateMatchMart.deleteMany({ where: scope });
      for (const chunk of chunks(matchRows, INSERT_CHUNK)) {
        await tx.candidateMatchMart.createMany({ data: chunk.map((r) => ({ ...r, matchedKeywords: JSON.stringify(r.matchedKeywords), missingKeywords: JSON.stringify(r.missingKeywords) })) });
      }
    });

    // The benchmark spans every user, so it is rebuilt from the WHOLE outcome
    // mart for these days - a single-user refresh must not shrink it.
    const allRows = options.userId ? await db.candidateOutcomeMart.findMany({ where: { day: { in: days } } }) : outcomeRows;
    const benchmarkRows = buildBenchmarkMart(allRows.map((r) => ({ ...r, dimension: r.dimension as ApplicationFactDimension })));
    await db.$transaction(async (tx) => {
      await tx.candidateBenchmarkMart.deleteMany({ where: { day: { in: days } } });
      for (const chunk of chunks(benchmarkRows, INSERT_CHUNK)) await tx.candidateBenchmarkMart.createMany({ data: chunk });
    });

    await db.rollupRun.update({ where: { id: run.id }, data: { status: 'succeeded', rowsRead: facts.length + matchFacts.length, rowsWritten: outcomeRows.length + matchRows.length + benchmarkRows.length, finishedAt: new Date() } });
    return {
      job: CANDIDATE_ROLLUP_JOB,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      days: days.length,
      applicationsRead: facts.length,
      matchesRead: matchFacts.length,
      outcomeRows: outcomeRows.length,
      matchRows: matchRows.length,
      benchmarkRows: benchmarkRows.length,
      status: 'succeeded',
    };
  } catch (error) {
    await db.rollupRun.update({ where: { id: run.id }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date() } }).catch(() => undefined);
    throw error;
  }
}

type ApplicationFactDimension = ReturnType<typeof buildOutcomeMart>[number]['dimension'];

/** One candidate's whole history, from their first day on the platform to today. Bounded by their own rows. */
export async function refreshCandidateMarts(userId: string, now = new Date()): Promise<CandidateRollupResult> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
  const first = await db.application.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  const start = first && first.createdAt < user.createdAt ? first.createdAt : user.createdAt;
  return rollupCandidateOutcomes({ start, end: new Date(now.getTime() + 86400_000) }, { userId });
}

/** When the marts were last rebuilt (any scope) - what a dashboard shows beside its numbers. */
export async function candidateMartFreshness(now = new Date()): Promise<{ lastSucceededAt: Date | null; lastStatus: string | null; stale: boolean }> {
  const last = await db.rollupRun.findFirst({ where: { job: CANDIDATE_ROLLUP_JOB }, orderBy: { startedAt: 'desc' }, select: { status: true, finishedAt: true, startedAt: true } });
  const succeeded = await db.rollupRun.findFirst({ where: { job: CANDIDATE_ROLLUP_JOB, status: 'succeeded' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } });
  const lastSucceededAt = succeeded?.finishedAt ?? null;
  // More than a day old, or never built: the dashboard says so (ADR-0012 rule 4).
  const stale = !lastSucceededAt || now.getTime() - lastSucceededAt.getTime() > 26 * 3600_000;
  return { lastSucceededAt, lastStatus: last?.status ?? null, stale };
}

export { dayKey };

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
 * Since Stage 24 the worker runs this nightly (ADR-0011's queue is still not built). The job also runs from the
 * operator's sweep (`npm run analytics:rollup`), from the candidate's own
 * "refresh" on their analytics page (their rows only), and inline the first
 * time a candidate with applications opens the page with no rows yet. A
 * `RollupRun` row records every run so a silently skipped night is visible.
 */
import { db } from '@/lib/db';
import { parseJson } from '@/lib/types';
import { eachDayKey, snapToUtcDays } from '../time';
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

    // One transaction, under an advisory lock on the scope, for all three
    // marts: two refreshes for the same candidate (a double click, the sweep
    // running beside a refresh) serialise instead of racing each other into a
    // unique-constraint failure, and a reader never sees a half-replaced day.
    const benchmarkRows = await db.$transaction(
      async (tx) => {
        // Stage 24 review (M7): the sweep (every candidate) holds the lock
        // EXCLUSIVELY; a single candidate's refresh holds it SHARED, so two
        // refreshes run side by side but never beside the sweep that
        // rewrites the same (day × user) rows - the nightly worker made that
        // collision daily rather than rare.
        // A single candidate's two refreshes (a double click) still exclude
        // each other on the per-user lock, taken AFTER the shared one so no
        // cycle with the sweep is possible.
        if (options.userId) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('analytics:candidate:all'::text))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`analytics:candidate:${options.userId}`}::text))`;
        } else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('analytics:candidate:all'::text))`;
        // The days this scope touched before the rewrite: a day the candidate
        // used to have rows on must be rebuilt too, or the benchmark keeps them.
        const before = await tx.candidateOutcomeMart.findMany({ where: scope, select: { day: true }, distinct: ['day'] });
        await tx.candidateOutcomeMart.deleteMany({ where: scope });
        for (const chunk of chunks(outcomeRows, INSERT_CHUNK)) await tx.candidateOutcomeMart.createMany({ data: chunk });
        await tx.candidateMatchMart.deleteMany({ where: scope });
        for (const chunk of chunks(matchRows, INSERT_CHUNK)) {
          await tx.candidateMatchMart.createMany({ data: chunk.map((r) => ({ ...r, matchedKeywords: JSON.stringify(r.matchedKeywords), missingKeywords: JSON.stringify(r.missingKeywords) })) });
        }
        // The benchmark spans every user, so it is rebuilt from the WHOLE
        // outcome mart - but only for the days THIS scope touched, so a
        // single candidate's refresh is bounded by their own activity, never
        // by their tenure, and never shrinks anyone else's days.
        const touched = options.userId ? [...new Set([...before.map((r) => r.day), ...outcomeRows.map((r) => r.day)])] : days;
        if (touched.length === 0) return [];
        const allRows = await tx.candidateOutcomeMart.findMany({ where: { day: { in: touched } } });
        const rows = buildBenchmarkMart(allRows.map((r) => ({ ...r, dimension: r.dimension as ApplicationFactDimension })));
        await tx.candidateBenchmarkMart.deleteMany({ where: { day: { in: touched } } });
        for (const chunk of chunks(rows, INSERT_CHUNK)) await tx.candidateBenchmarkMart.createMany({ data: chunk });
        if (options.userId) await tx.user.update({ where: { id: options.userId }, data: { analyticsBuiltAt: new Date() } });
        return rows;
      },
      { timeout: 60_000 },
    );

    await db.rollupRun.update({ where: { id: run.id }, data: { status: 'succeeded', rowsRead: facts.length + matchFacts.length, rowsWritten: outcomeRows.length + matchRows.length + benchmarkRows.length, finishedAt: new Date() } });
    if (!options.userId) await stampRebuiltCandidates([...new Set(facts.map((f) => f.userId))]);
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

/** After a full sweep, every candidate whose rows were rebuilt is stamped, so their page never rebuilds inline. */
export async function stampRebuiltCandidates(userIds: string[], at = new Date()): Promise<number> {
  if (userIds.length === 0) return 0;
  const r = await db.user.updateMany({ where: { id: { in: userIds } }, data: { analyticsBuiltAt: at } });
  return r.count;
}

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


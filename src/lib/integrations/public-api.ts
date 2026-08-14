/**
 * The resources `/api/v1/*` serves: queries and their public representations.
 *
 * SERIALISATION IS EXPLICIT, NEVER A SPREAD
 * -----------------------------------------
 * Every function below names each field it emits. It would be shorter to
 * `return { ...application }` — and that is precisely the bug this avoids: the
 * next person to add a column to `Application` would publish it to every API
 * consumer without noticing, and the column after that might be an internal
 * cost figure or a provider identifier. An explicit list means new columns are
 * private until someone decides otherwise, and a removed column breaks the
 * build here rather than breaking clients in production.
 *
 * A corollary: the shapes below are a contract. Removing or renaming a field is
 * a breaking change; adding one is not.
 *
 * SCOPING
 * -------
 * Every query is filtered by `userId` taken from the authenticated key. There
 * is deliberately no "all jobs" endpoint: the `Job` table is shared across
 * customers, so exposing it unscoped would let one customer's key enumerate
 * postings discovered by another customer's agents. `/api/v1/jobs` returns the
 * jobs THIS user's agents matched.
 *
 * RATES ARE PARTS PER MILLION
 * ---------------------------
 * `…Parts` fields are integers where 1,000,000 = 100%, matching the house
 * convention used throughout the schema. Divide by 10,000 for a percentage.
 * Floats are avoided for the same reason they are avoided in the database: a
 * rate that renders as 9.975% must not become 9.974999999999999%.
 */

import { db } from '../db';
import { parseJson } from '../types';
import type { Pagination } from './http';

/** 1,000,000 parts = 100%. */
export const ONE_MILLION = 1_000_000;

/**
 * A ratio as integer parts per million. Zero denominator gives zero, not NaN —
 * "no applications submitted" reports a 0% interview rate rather than poisoning
 * every downstream calculation with a NaN that survives JSON.
 */
export function rateParts(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * ONE_MILLION);
}

// --- Applications -----------------------------------------------------------

/**
 * The statuses an application can be filtered by. Mirrors `ApplicationStatus`
 * in src/lib/types.ts; listed again here because this one is a public contract
 * and must not silently follow an internal refactor.
 */
export const PUBLIC_APPLICATION_STATUSES = [
  'queued',
  'applying',
  'ready_to_submit',
  'submitted',
  'failed',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
] as const;

export type PublicApplicationStatus = (typeof PUBLIC_APPLICATION_STATUSES)[number];

/** Applications that actually reached an employer. Denominator for the rates. */
const SUBMITTED_STATUSES: readonly string[] = ['submitted', 'interviewing', 'offer', 'rejected'];
/** Applications that got as far as a conversation. `offer` implies interviewing. */
const INTERVIEW_STATUSES: readonly string[] = ['interviewing', 'offer'];

export interface PublicJobSummary {
  id: string;
  title: string;
  company: string;
  location: string;
  country: string;
  workMode: string;
  jobType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  source: string;
  applyUrl: string;
  postedAt: string;
}

export interface PublicApplication {
  object: 'application';
  id: string;
  status: string;
  matchScore: number;
  atsScore: number;
  applyChannel: string;
  atsVendor: string | null;
  confirmation: string | null;
  failureReason: string | null;
  keywordsInjected: string[];
  agentId: string | null;
  appliedAt: string | null;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
  job: PublicJobSummary;
}

/** The Prisma row shape this serialiser needs. */
type ApplicationRow = {
  id: string;
  status: string;
  matchScore: number;
  atsScore: number;
  applyChannel: string;
  atsVendor: string | null;
  confirmation: string | null;
  failureReason: string | null;
  keywordsInjected: string;
  agentId: string | null;
  appliedAt: Date | null;
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  job: {
    id: string;
    title: string;
    company: string;
    location: string;
    country: string;
    workMode: string;
    jobType: string;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string;
    source: string;
    applyUrl: string;
    postedAt: Date;
  };
};

/**
 * Note what is NOT here: `tailoredResume`, `coverLetter`, `tailoringNotes` and
 * `folderPath`. The first two are multi-kilobyte documents that would make a
 * 100-row page enormous for the 99% of callers building a dashboard, and
 * `folderPath` is a server filesystem path — an internal detail that leaks the
 * storage layout and is useless to a client. The documents remain available to
 * the signed-in owner through the app's own file routes.
 */
export function serialiseApplication(row: ApplicationRow): PublicApplication {
  return {
    object: 'application',
    id: row.id,
    status: row.status,
    matchScore: row.matchScore,
    atsScore: row.atsScore,
    applyChannel: row.applyChannel,
    atsVendor: row.atsVendor,
    confirmation: row.confirmation,
    failureReason: row.failureReason,
    keywordsInjected: parseJson<string[]>(row.keywordsInjected, []),
    agentId: row.agentId,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    job: {
      id: row.job.id,
      title: row.job.title,
      company: row.job.company,
      location: row.job.location,
      country: row.job.country,
      workMode: row.job.workMode,
      jobType: row.job.jobType,
      salaryMin: row.job.salaryMin,
      salaryMax: row.job.salaryMax,
      salaryCurrency: row.job.salaryCurrency,
      source: row.job.source,
      applyUrl: row.job.applyUrl,
      postedAt: row.job.postedAt.toISOString(),
    },
  };
}

export interface ApplicationFilters {
  status?: PublicApplicationStatus;
  agentId?: string;
  since?: Date;
  until?: Date;
}

const APPLICATION_JOB_SELECT = {
  id: true,
  title: true,
  company: true,
  location: true,
  country: true,
  workMode: true,
  jobType: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  source: true,
  applyUrl: true,
  postedAt: true,
} as const;

/**
 * A page of the caller's applications, newest first, with the total so a client
 * can show "showing 25 of 340" without walking the whole collection.
 *
 * `count` and `findMany` run as one `$transaction` so the total and the page
 * describe the same snapshot. Without it, a row inserted between the two
 * queries yields a total that does not match the page — a small inconsistency
 * that reliably produces a bug report about a phantom extra row.
 */
export async function listApplicationsForApi(
  userId: string,
  filters: ApplicationFilters,
  pagination: Pagination,
): Promise<{ data: PublicApplication[]; total: number }> {
  const where = {
    userId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.agentId ? { agentId: filters.agentId } : {}),
    ...(filters.since || filters.until
      ? {
          createdAt: {
            ...(filters.since ? { gte: filters.since } : {}),
            ...(filters.until ? { lte: filters.until } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await db.$transaction([
    db.application.count({ where }),
    db.application.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: pagination.offset,
      take: pagination.limit,
      include: { job: { select: APPLICATION_JOB_SELECT } },
    }),
  ]);

  return { data: rows.map(serialiseApplication), total };
}

// --- Jobs -------------------------------------------------------------------

export const PUBLIC_MATCH_STATUSES = ['new', 'reviewed', 'queued', 'applied', 'dismissed'] as const;
export type PublicMatchStatus = (typeof PUBLIC_MATCH_STATUSES)[number];

export interface PublicJob {
  object: 'job';
  id: string;
  title: string;
  company: string;
  companyLogo: string | null;
  location: string;
  country: string;
  workMode: string;
  jobType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  source: string;
  applyUrl: string;
  applyMethod: string;
  skills: string[];
  requirements: string[];
  nocCode: string | null;
  postedAt: string;
  match: {
    id: string;
    agentId: string;
    agentName: string;
    score: number;
    status: string;
    matchedKeywords: string[];
    missingKeywords: string[];
    rationale: string;
    matchedAt: string;
  };
}

type JobMatchRow = {
  id: string;
  agentId: string;
  matchScore: number;
  status: string;
  matchedKeywords: string;
  missingKeywords: string;
  rationale: string;
  createdAt: Date;
  agent: { name: string };
  job: {
    id: string;
    title: string;
    company: string;
    companyLogo: string | null;
    location: string;
    country: string;
    workMode: string;
    jobType: string;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string;
    source: string;
    applyUrl: string;
    applyMethod: string;
    skills: string;
    requirements: string;
    nocCode: string | null;
    postedAt: Date;
  };
};

/**
 * The unit here is the MATCH, not the job: the same posting matched by two of
 * a user's agents appears twice, each with its own score and rationale. That is
 * the honest shape — the score is a property of (agent, job), not of the job —
 * and collapsing it would force an arbitrary choice of which agent's verdict to
 * publish. `id` is the job id; `match.id` disambiguates.
 *
 * `description` is omitted: full postings run to several kilobytes and would
 * dominate every page. `applyUrl` is where the full text lives.
 */
export function serialiseJobMatch(row: JobMatchRow): PublicJob {
  return {
    object: 'job',
    id: row.job.id,
    title: row.job.title,
    company: row.job.company,
    companyLogo: row.job.companyLogo,
    location: row.job.location,
    country: row.job.country,
    workMode: row.job.workMode,
    jobType: row.job.jobType,
    salaryMin: row.job.salaryMin,
    salaryMax: row.job.salaryMax,
    salaryCurrency: row.job.salaryCurrency,
    source: row.job.source,
    applyUrl: row.job.applyUrl,
    applyMethod: row.job.applyMethod,
    skills: parseJson<string[]>(row.job.skills, []),
    requirements: parseJson<string[]>(row.job.requirements, []),
    nocCode: row.job.nocCode,
    postedAt: row.job.postedAt.toISOString(),
    match: {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agent.name,
      score: row.matchScore,
      status: row.status,
      matchedKeywords: parseJson<string[]>(row.matchedKeywords, []),
      missingKeywords: parseJson<string[]>(row.missingKeywords, []),
      rationale: row.rationale,
      matchedAt: row.createdAt.toISOString(),
    },
  };
}

export interface JobFilters {
  agentId?: string;
  status?: PublicMatchStatus;
  minScore?: number;
  country?: string;
  workMode?: string;
  since?: Date;
}

const PUBLIC_JOB_SELECT = {
  id: true,
  title: true,
  company: true,
  companyLogo: true,
  location: true,
  country: true,
  workMode: true,
  jobType: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  source: true,
  applyUrl: true,
  applyMethod: true,
  skills: true,
  requirements: true,
  nocCode: true,
  postedAt: true,
} as const;

/**
 * Jobs this user's agents matched.
 *
 * The `agent: { userId }` filter is the tenancy boundary — `JobMatch` has no
 * `userId` of its own, so ownership is only ever established through the agent.
 * Any future query here must go through the agent for the same reason.
 */
export async function listJobsForApi(
  userId: string,
  filters: JobFilters,
  pagination: Pagination,
): Promise<{ data: PublicJob[]; total: number }> {
  const where = {
    agent: { userId, ...(filters.agentId ? { id: filters.agentId } : {}) },
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.minScore !== undefined ? { matchScore: { gte: filters.minScore } } : {}),
    ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
    ...(filters.country || filters.workMode
      ? {
          job: {
            ...(filters.country ? { country: filters.country } : {}),
            ...(filters.workMode ? { workMode: filters.workMode } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await db.$transaction([
    db.jobMatch.count({ where }),
    db.jobMatch.findMany({
      where,
      // Score first: the point of a match feed is the best opportunities, and a
      // client that wants chronological order can sort a page of 25 itself.
      orderBy: [{ matchScore: 'desc' }, { createdAt: 'desc' }],
      skip: pagination.offset,
      take: pagination.limit,
      include: { agent: { select: { name: true } }, job: { select: PUBLIC_JOB_SELECT } },
    }),
  ]);

  return { data: rows.map(serialiseJobMatch), total };
}

// --- Analytics summary ------------------------------------------------------

export interface PublicAnalyticsSummary {
  object: 'analytics_summary';
  generatedAt: string;
  window: { since: string; until: string; days: number };
  lifetime: {
    applications: number;
    submitted: number;
    interviews: number;
    offers: number;
    responded: number;
  };
  windowed: {
    applications: number;
    submitted: number;
    interviews: number;
    offers: number;
  };
  byStatus: Record<string, number>;
  /**
   * All three denominators are LIFETIME SUBMITTED applications, not total
   * applications. A queued application has not had the chance to be rejected,
   * so counting it would make the interview rate fall every time the user
   * queues more work — a metric that punishes activity is worse than none.
   */
  rates: {
    responseRateParts: number;
    interviewRateParts: number;
    offerRateParts: number;
  };
  scores: { averageMatchScore: number; averageAtsScore: number };
  agents: { total: number; active: number };
  matches: { total: number; new: number };
  quota: {
    planCode: string;
    planName: string;
    interval: string;
    status: string;
    limit: number;
    used: number;
    remaining: number;
    periodEnd: string;
  } | null;
}

export const DEFAULT_SUMMARY_WINDOW_DAYS = 30;

/**
 * The dashboard numbers, in one request.
 *
 * Reads the subscription directly rather than calling `getQuota()` from
 * src/lib/subscription.ts: `getQuota` WRITES — it rolls the period forward when
 * the month has elapsed. A read-only analytics endpoint that silently resets a
 * customer's usage counter as a side effect of being polled would be a genuinely
 * nasty bug, and polling is exactly what an API client does. The numbers here
 * are therefore a faithful report of the stored row, including a period that
 * has ended; the app rolls it forward the next time the user actually applies.
 */
export async function buildAnalyticsSummary(
  userId: string,
  options: { since?: Date; until?: Date; now?: Date } = {},
): Promise<PublicAnalyticsSummary> {
  const now = options.now ?? new Date();
  const until = options.until ?? now;
  const since =
    options.since ?? new Date(until.getTime() - DEFAULT_SUMMARY_WINDOW_DAYS * 86_400_000);
  const windowRange = { gte: since, lte: until };

  const [statusGroups, windowGroups, scoreAggregate, respondedCount, agentTotal, agentActive, matchTotal, matchNew, subscription] =
    await Promise.all([
      db.application.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
      db.application.groupBy({
        by: ['status'],
        where: { userId, createdAt: windowRange },
        _count: { _all: true },
      }),
      db.application.aggregate({
        where: { userId },
        _avg: { matchScore: true, atsScore: true },
      }),
      db.application.count({ where: { userId, respondedAt: { not: null } } }),
      db.agent.count({ where: { userId } }),
      db.agent.count({ where: { userId, status: 'active' } }),
      db.jobMatch.count({ where: { agent: { userId } } }),
      db.jobMatch.count({ where: { agent: { userId }, status: 'new' } }),
      db.subscription.findUnique({ where: { userId }, include: { plan: true } }),
    ]);

  const byStatus: Record<string, number> = {};
  for (const status of PUBLIC_APPLICATION_STATUSES) byStatus[status] = 0;
  for (const group of statusGroups) byStatus[group.status] = group._count._all;

  const tally = (
    groups: { status: string; _count: { _all: number } }[],
    statuses?: readonly string[],
  ): number =>
    groups.reduce(
      (sum, group) => (!statuses || statuses.includes(group.status) ? sum + group._count._all : sum),
      0,
    );

  const lifetimeTotal = tally(statusGroups);
  const lifetimeSubmitted = tally(statusGroups, SUBMITTED_STATUSES);
  const lifetimeInterviews = tally(statusGroups, INTERVIEW_STATUSES);
  const lifetimeOffers = tally(statusGroups, ['offer']);

  // A rejection is a response even when `respondedAt` was never stamped — the
  // status change is itself the employer answering. Counting only the timestamp
  // would under-report the response rate for every application whose outcome
  // arrived through a status update.
  //
  // Clamped to `lifetimeSubmitted` because `respondedCount` spans every status,
  // including applications that failed to submit but still recorded a reply.
  // Without the clamp the numerator could exceed the denominator and publish a
  // response rate above 100%, which reads as a bug in our maths rather than as
  // the data oddity it actually is.
  const respondedByStatus = tally(statusGroups, ['interviewing', 'offer', 'rejected']);
  const responded = Math.min(lifetimeSubmitted, Math.max(respondedCount, respondedByStatus));

  return {
    object: 'analytics_summary',
    generatedAt: now.toISOString(),
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      days: Math.max(1, Math.round((until.getTime() - since.getTime()) / 86_400_000)),
    },
    lifetime: {
      applications: lifetimeTotal,
      submitted: lifetimeSubmitted,
      interviews: lifetimeInterviews,
      offers: lifetimeOffers,
      responded,
    },
    windowed: {
      applications: tally(windowGroups),
      submitted: tally(windowGroups, SUBMITTED_STATUSES),
      interviews: tally(windowGroups, INTERVIEW_STATUSES),
      offers: tally(windowGroups, ['offer']),
    },
    byStatus,
    rates: {
      responseRateParts: rateParts(responded, lifetimeSubmitted),
      interviewRateParts: rateParts(lifetimeInterviews, lifetimeSubmitted),
      offerRateParts: rateParts(lifetimeOffers, lifetimeSubmitted),
    },
    scores: {
      averageMatchScore: Math.round(scoreAggregate._avg.matchScore ?? 0),
      averageAtsScore: Math.round(scoreAggregate._avg.atsScore ?? 0),
    },
    agents: { total: agentTotal, active: agentActive },
    matches: { total: matchTotal, new: matchNew },
    quota: subscription
      ? {
          planCode: subscription.plan.code,
          planName: subscription.plan.name,
          interval: subscription.interval,
          status: subscription.status,
          limit: subscription.plan.applicationsPerMonth,
          used: subscription.applicationsUsed,
          remaining: Math.max(
            0,
            subscription.plan.applicationsPerMonth - subscription.applicationsUsed,
          ),
          periodEnd: subscription.periodEnd.toISOString(),
        }
      : null,
  };
}

import { db } from '@/lib/db';
import { getAIProvider, getJobProvider } from '@/lib/providers';
import type { JobContext } from '@/lib/providers';
import { parseJson } from '@/lib/types';
import type { Country, JobType, WorkMode } from '@/lib/types';
import { loadResumeContent } from '@/lib/candidate/profile';
import { withTenant } from '@/lib/tenancy/context';

export interface ScanResult {
  agentId: string;
  agentName: string;
  scanned: number;
  newMatches: number;
  aboveThreshold: number;
}

/** Convert a stored Job row into the shape the AI layer expects. */
export function toJobContext(job: {
  title: string;
  company: string;
  location: string;
  description: string;
  requirements: string;
  skills: string;
  workMode: string;
}): JobContext {
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
    requirements: parseJson<string[]>(job.requirements, []),
    skills: parseJson<string[]>(job.skills, []),
    workMode: job.workMode,
  };
}

/**
 * Run one agent: pull live postings, persist them, and score each against the
 * user's master resume.
 *
 * Scoring is the expensive step, so it only runs for postings this agent has
 * not already matched — re-scanning an unchanged feed is nearly free.
 */
export async function runAgentScan(userId: string, agentId: string): Promise<ScanResult> {
  const agent = await db.agent.findFirstOrThrow({ where: { id: agentId, userId } });

  // Stage 02: the structured profile, projected — loaded on the TENANT path so
  // this read runs as app_tenant, which holds no privilege on the sensitive
  // schema (ADR-0007: inclusion would be a permission error, not a leak). The
  // rest of the scan stays on the system client until the scanner is reworked
  // in Stage 05/06 (R-35).
  const resumeContent = await withTenant({ userId }, (tx) => loadResumeContent(tx, userId));
  if (!resumeContent) throw new Error('Add your resume before running a scan.');

  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  const jobs = getJobProvider();
  const ai = getAIProvider();

  const postings = await jobs.search({
    titles: parseJson<string[]>(agent.titles, []),
    keywords: parseJson<string[]>(agent.keywords, []),
    excludeKeywords: parseJson<string[]>(agent.excludeKeywords, []),
    locations: parseJson<string[]>(agent.locations, []),
    country: user.country as Country,
    workMode: agent.workMode as WorkMode,
    jobType: agent.jobType as JobType,
    minSalary: agent.minSalary ?? undefined,
    limit: 30,
  });

  let newMatches = 0;
  let aboveThreshold = 0;

  for (const posting of postings) {
    // Upsert the posting itself — jobs are shared across all users.
    const job = await db.job.upsert({
      where: { source_externalId: { source: posting.source, externalId: posting.externalId } },
      create: {
        source: posting.source,
        externalId: posting.externalId,
        title: posting.title,
        company: posting.company,
        location: posting.location,
        country: posting.country,
        workMode: posting.workMode,
        jobType: posting.jobType,
        salaryMin: posting.salaryMin,
        salaryMax: posting.salaryMax,
        salaryCurrency: posting.salaryCurrency,
        description: posting.description,
        requirements: JSON.stringify(posting.requirements),
        skills: JSON.stringify(posting.skills),
        nocCode: posting.nocCode,
        applyUrl: posting.applyUrl,
        applyMethod: posting.applyMethod,
        postedAt: posting.postedAt,
      },
      update: { scrapedAt: new Date(), description: posting.description },
    });

    const existing = await db.jobMatch.findUnique({
      where: { agentId_jobId: { agentId: agent.id, jobId: job.id } },
    });
    if (existing) continue;

    const analysis = await ai.analyzeMatch(resumeContent, toJobContext(job));

    // Respect the agent's floor so the feed stays signal, not noise.
    if (analysis.matchScore < agent.minMatchScore) continue;

    await db.jobMatch.create({
      data: {
        agentId: agent.id,
        jobId: job.id,
        matchScore: analysis.matchScore,
        scoreBreakdown: JSON.stringify(analysis.breakdown),
        matchedKeywords: JSON.stringify(analysis.matchedKeywords),
        missingKeywords: JSON.stringify(analysis.missingKeywords),
        rationale: analysis.rationale,
        status: 'new',
      },
    });

    newMatches += 1;
    if (analysis.matchScore >= agent.autoApplyThreshold) aboveThreshold += 1;
  }

  await db.agent.update({ where: { id: agent.id }, data: { lastScanAt: new Date() } });

  await db.activityEvent.create({
    data: {
      userId,
      type: 'scan',
      message: `${agent.name} scanned ${postings.length} live postings and found ${newMatches} new match${newMatches === 1 ? '' : 'es'}.`,
      meta: JSON.stringify({ agentId: agent.id, scanned: postings.length, newMatches }),
    },
  });

  return {
    agentId: agent.id,
    agentName: agent.name,
    scanned: postings.length,
    newMatches,
    aboveThreshold,
  };
}

export interface ScanRun {
  results: ScanResult[];
  /** Agents that failed, so the caller can tell the user instead of showing "0 found". */
  errors: { agentName: string; message: string }[];
}

/** Run every active agent for a user. */
export async function runAllScans(userId: string): Promise<ScanRun> {
  const agents = await db.agent.findMany({ where: { userId, status: 'active' } });
  const results: ScanResult[] = [];
  const errors: { agentName: string; message: string }[] = [];

  for (const agent of agents) {
    try {
      results.push(await runAgentScan(userId, agent.id));
    } catch (error) {
      console.error(`[scanner] agent ${agent.id} failed:`, error);
      errors.push({
        agentName: agent.name,
        message: error instanceof Error ? error.message : 'The scan could not be completed.',
      });
    }
  }

  return { results, errors };
}

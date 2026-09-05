import { db } from '@/lib/db';
import { runDiscovery } from '@/lib/connectors/pipeline';
import type { JobContext } from '@/lib/providers';
import { loadEvidenceForGeneration } from '@/lib/evidence/vault';
import { classifyStoredJob } from '@/lib/taxonomy/classify';
import { ensureEligibility, loadCandidateEligibility } from '@/lib/eligibility/service';
import { matchRows, scoreCompatibility } from '@/lib/matching/pipeline';
import { getActiveWeights } from '@/lib/matching/weights';
import { parseJson } from '@/lib/types';
import type { Country, JobType, WorkMode } from '@/lib/types';
import { loadResumeContent } from '@/lib/candidate/profile';
import { withTenant } from '@/lib/tenancy/context';
import { redactError } from '@/lib/log';

export interface ScanResult {
  agentId: string;
  agentName: string;
  scanned: number;
  newMatches: number;
  aboveThreshold: number;
  /** Stage 07: postings excluded by a hard eligibility rule before scoring. */
  excluded: number;
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
  //
  // Stage 03: approved evidence travels with the résumé as ids + one-line
  // claims; the gateway records the ids on every AiRun and grounds against
  // the claims.
  const { resumeContent, evidence } = await withTenant({ userId }, async (tx) => ({
    resumeContent: await loadResumeContent(tx, userId),
    evidence: await loadEvidenceForGeneration(tx, userId),
  }));
  if (!resumeContent) throw new Error('Add your resume before running a scan.');

  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  // Stage 05: discovery goes through the connector pipeline (ADR-0008): the
  // configured source must be registered, enabled, policy-recorded and
  // credentialed, or the run is refused and recorded. Postings are
  // normalised, validated, upserted with first/last-seen and snapshotted
  // before anything is scored. The query carries search criteria only.
  const sourceKey = (process.env.JOB_PROVIDER || 'mock').toLowerCase();
  const discovery = await runDiscovery(sourceKey, {
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
  let excluded = 0;

  // Stage 07: the candidate's eligibility facts, read ONCE per scan on the
  // tenant path and audited (work authorisation is access-controlled). Every
  // posting is gated by the deterministic rules BEFORE it is scored: an
  // ineligible posting never becomes a match, and the verdict with its
  // reasons is stored so the candidate can see why. `unknown` never excludes.
  const eligibilityProfile = discovery.jobIds.length > 0 ? await loadCandidateEligibility(userId, { reason: 'agent_scan', jobs: discovery.jobIds.length, agentId: agent.id }) : null;
  // Stage 08: one weight version per scan, so every match in a run is scored the same way.
  const weights = await getActiveWeights();

  for (const jobId of discovery.jobIds) {
    const job = await db.job.findUnique({ where: { id: jobId } });
    if (!job) continue;

    // Stage 04: classify the posting against the occupational spine once,
    // recording the METHOD alongside the id so a regex fallback is never
    // mistaken for a real match (ADR-0009). A no-op until a dataset is loaded.
    await classifyStoredJob(job);

    const { verdict } = await ensureEligibility(db, userId, job, eligibilityProfile!);
    if (verdict.outcome === 'ineligible') {
      excluded += 1;
      continue;
    }

    const existing = await db.jobMatch.findUnique({
      where: { agentId_jobId: { agentId: agent.id, jobId: job.id } },
    });
    if (existing) continue;

    // Stage 08: the compatibility pipeline — requirement extraction, evidence
    // retrieval, the deterministic stage through the gateway (Stage 03: policy
    // resolved before dispatch, run recorded), the semantic stage, governed
    // weights — with the score decomposed into cited dimensions.
    const compatibility = await scoreCompatibility({ userId, resume: resumeContent, evidence, job, inputRefs: [`job:${job.id}`, `agent:${agent.id}`], weights });
    const { analysis } = compatibility;

    // Respect the agent's floor so the feed stays signal, not noise.
    if (analysis.matchScore < agent.minMatchScore) continue;

    const rows = matchRows(userId, compatibility);
    await db.jobMatch.create({
      data: {
        agentId: agent.id,
        jobId: job.id,
        status: 'new',
        ...rows.match,
        dimensions: { create: rows.dimensions },
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
      message: `${agent.name} scanned ${discovery.run.discovered} live postings and found ${newMatches} new match${newMatches === 1 ? '' : 'es'}${excluded ? ` (${excluded} excluded as ineligible)` : ''}.`,
      meta: JSON.stringify({ agentId: agent.id, scanned: discovery.run.discovered, newMatches, excluded, sourceRunId: discovery.run.id }),
    },
  });

  return {
    agentId: agent.id,
    agentName: agent.name,
    scanned: discovery.run.discovered,
    newMatches,
    aboveThreshold,
    excluded,
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
      console.error(`[scanner] agent ${agent.id} failed:`, redactError(error));
      errors.push({
        agentName: agent.name,
        message: error instanceof Error ? error.message : 'The scan could not be completed.',
      });
    }
  }

  return { results, errors };
}

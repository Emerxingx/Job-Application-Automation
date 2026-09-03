import type { Job, Prisma } from '@prisma/client';
import { RULES_VERSION } from './engine';
import { ensureEligibility, loadCandidateEligibility, profileVersionOf, toVerdict, type ReadPurpose, type StoredVerdict } from './service';

type Run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

/**
 * The verdict for a page or the API: the stored one when it is current for
 * both the rule set and the profile, otherwise a fresh evaluation. Staleness
 * is checked from timestamps and counts only (`profileVersionOf`, no value
 * read, no audit row), so viewing a page leaves an audit row only when the
 * candidate's facts are actually read for an evaluation.
 */
export async function eligibilityForPage(userId: string, job: Job, run: Run, reason: ReadPurpose['reason'] = 'job_page'): Promise<StoredVerdict> {
  const { stored, version } = await run(async (tx) => ({
    stored: await tx.eligibilityResult.findUnique({ where: { userId_jobId: { userId, jobId: job.id } } }),
    version: await profileVersionOf(userId, tx),
  }));
  if (stored && stored.rulesVersion === RULES_VERSION && stored.profileVersion === version) {
    return { result: stored, verdict: toVerdict(stored), fresh: false };
  }
  const profile = await loadCandidateEligibility(userId, { reason, jobs: 1 });
  return run((tx) => ensureEligibility(tx, userId, job, profile));
}

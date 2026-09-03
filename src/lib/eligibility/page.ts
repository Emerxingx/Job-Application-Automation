import type { Job, Prisma } from '@prisma/client';
import { RULES_VERSION } from './engine';
import { ensureEligibility, loadCandidateEligibility, type StoredVerdict } from './service';

type Run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

/**
 * The verdict for a page: the stored one when it is current for the rule
 * set, otherwise a fresh evaluation. The candidate's facts are read (and the
 * read audited) only when an evaluation is actually needed, so viewing a
 * page does not leave an audit row per view. Staleness against the profile
 * is checked by `ensureEligibility` once the facts are loaded.
 */
export async function eligibilityForPage(userId: string, job: Job, run: Run): Promise<StoredVerdict> {
  const stored = await run((tx) => tx.eligibilityResult.findUnique({ where: { userId_jobId: { userId, jobId: job.id } } }));
  if (stored && stored.rulesVersion === RULES_VERSION) {
    const profile = await loadCandidateEligibility(userId, { reason: 'job page (staleness check)', jobs: 1 });
    if (stored.profileVersion === profile.version) {
      return { result: stored, verdict: { outcome: stored.outcome as StoredVerdict['verdict']['outcome'], rules: JSON.parse(stored.rules), rulesVersion: stored.rulesVersion }, fresh: false };
    }
    return run((tx) => ensureEligibility(tx, userId, job, profile));
  }
  const profile = await loadCandidateEligibility(userId, { reason: 'job page', jobs: 1 });
  return run((tx) => ensureEligibility(tx, userId, job, profile));
}

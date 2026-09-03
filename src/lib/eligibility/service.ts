import type { EligibilityResult, Job, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { parseJson } from '@/lib/types';
import { recordSecurityEvent } from '@/lib/security-audit';
import { withTenant } from '@/lib/tenancy/context';
import { RULES_VERSION, evaluateEligibility, type CandidateEligibility, type EligibilityVerdict, type JobEligibilityFacts, type RuleResult } from './engine';

/**
 * Stage 07 — eligibility, persisted.
 *
 * The candidate's eligibility facts are read ONCE per evaluation batch on the
 * tenant path (as `app_tenant`, which holds no privilege on the sensitive
 * schema — ADR-0007) and the read is audited: work authorisation is
 * operationally relevant but access-controlled, so every batch that reads it
 * leaves an `eligibility.profile.read` row naming the purpose and the count
 * of jobs, never a value. Verdicts are stored per (user, job) on the system
 * client with the user filter, and re-computed when the profile the verdict
 * was computed from changes (`profileVersion`) or the rules do
 * (`rulesVersion`).
 */

type Client = Prisma.TransactionClient | typeof db;

export interface CandidateEligibilityProfile {
  facts: CandidateEligibility;
  /** Max updatedAt of the rows the facts came from, as ISO; the verdict's staleness key. */
  version: string;
}

/**
 * Read the candidate's eligibility facts on the tenant path, audit-first.
 * The audit row is written STRICTLY on the system client before the read
 * (the tenant role cannot write `AuditLog`, by design): a read whose record
 * cannot be written does not happen, the same discipline the sensitive path
 * uses (ADR-0007). The row names the purpose and the batch size, never a value.
 */
export async function loadCandidateEligibility(userId: string, purpose: { reason: string; jobs?: number }): Promise<CandidateEligibilityProfile> {
  await recordSecurityEvent(
    {
      event: 'eligibility.profile.read',
      user: { id: userId, email: '' },
      entityType: 'WorkAuthorization',
      entityId: userId,
      summary: `Eligibility facts read for ${purpose.reason}.`,
      detail: { reason: purpose.reason, jobs: purpose.jobs ?? 1 },
    },
    db,
    { strict: true },
  );
  return withTenant({ userId }, async (tx) => {
    const [workAuth, preferences, certifications, languages] = await Promise.all([
      tx.workAuthorization.findFirst({ where: { userId } }),
      tx.careerPreferences.findFirst({ where: { userId } }),
      tx.certification.findMany({ where: { userId }, select: { name: true } }),
      tx.candidateLanguage.findMany({ where: { userId }, select: { language: true, proficiency: true } }),
    ]);
    const stamps = [workAuth?.updatedAt, preferences?.updatedAt].filter((d): d is Date => Boolean(d)).map((d) => d.getTime());
    return {
      facts: {
        workAuth: workAuth ? { country: workAuth.country, status: workAuth.status, permitExpiresAt: workAuth.permitExpiresAt, sponsorshipNeeded: workAuth.sponsorshipNeeded } : null,
        preferences: preferences
          ? {
              countries: parseJson<string[]>(preferences.countries, []),
              locations: parseJson<string[]>(preferences.locations, []),
              workModes: parseJson<string[]>(preferences.workModes, []),
              relocation: preferences.relocation,
            }
          : null,
        certifications: certifications.map((c) => c.name),
        languages,
      },
      version: stamps.length ? new Date(Math.max(...stamps)).toISOString() : '',
    };
  });
}

/** The job facts the engine reads, from a canonical Job row. */
export function jobFacts(job: Pick<Job, 'title' | 'country' | 'location' | 'postalRegion' | 'workMode' | 'workAuthorization' | 'sponsorship' | 'certificationRequirements' | 'languageRequirements'>): JobEligibilityFacts {
  return {
    title: job.title,
    country: job.country,
    location: job.location,
    postalRegion: job.postalRegion,
    workMode: job.workMode,
    workAuthorization: job.workAuthorization,
    sponsorship: job.sponsorship,
    certificationRequirements: parseJson<string[]>(job.certificationRequirements, []),
    languageRequirements: parseJson<string[]>(job.languageRequirements, []),
  };
}

export interface StoredVerdict {
  result: EligibilityResult;
  verdict: EligibilityVerdict;
  /** True when this call computed it (new or re-evaluated). */
  fresh: boolean;
}

function toVerdict(r: EligibilityResult): EligibilityVerdict {
  return { outcome: r.outcome as EligibilityVerdict['outcome'], rules: parseJson<RuleResult[]>(r.rules, []), rulesVersion: r.rulesVersion };
}

/**
 * The stored verdict for (user, job), computed or re-computed when missing,
 * older than the profile it was computed from, or from an older rule set.
 * `client` may be a tenant transaction (the job page) or the system client
 * (the scanner); the user filter is on every query either way.
 */
export async function ensureEligibility(client: Client, userId: string, job: Parameters<typeof jobFacts>[0] & { id: string }, profile: CandidateEligibilityProfile, today = new Date()): Promise<StoredVerdict> {
  const existing = await client.eligibilityResult.findUnique({ where: { userId_jobId: { userId, jobId: job.id } } });
  if (existing && existing.rulesVersion === RULES_VERSION && existing.profileVersion === profile.version) {
    return { result: existing, verdict: toVerdict(existing), fresh: false };
  }
  const verdict = evaluateEligibility(profile.facts, jobFacts(job), today);
  const data = { outcome: verdict.outcome, rules: JSON.stringify(verdict.rules), rulesVersion: verdict.rulesVersion, profileVersion: profile.version, evaluatedAt: today };
  const result = await client.eligibilityResult.upsert({
    where: { userId_jobId: { userId, jobId: job.id } },
    create: { userId, jobId: job.id, ...data },
    update: data,
  });
  return { result, verdict, fresh: true };
}

/** Every job the candidate is currently excluded from, with the reasons (tenant path). */
export async function listExclusions(tx: Prisma.TransactionClient, userId: string, limit = 100) {
  const rows = await tx.eligibilityResult.findMany({
    where: { userId, outcome: 'ineligible' },
    orderBy: { evaluatedAt: 'desc' },
    take: limit,
    include: { job: { select: { id: true, title: true, company: true, location: true, workMode: true, postedAt: true, activeState: true } } },
  });
  return rows.map((r) => ({ ...r, verdict: toVerdict(r) }));
}

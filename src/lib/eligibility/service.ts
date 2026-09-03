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
/** The purpose of a read, as it is audited: a fixed reason code and ids, never user-typed text. */
export interface ReadPurpose {
  reason: 'agent_scan' | 'job_page' | 'api' | 'test';
  jobs?: number;
  agentId?: string;
}

/**
 * The profile state a verdict is computed from: the latest change to work
 * authorisation, preferences, certifications or languages, plus the row
 * counts (a deletion changes no timestamp). Read from timestamps only —
 * no value — so a page can check staleness without an audited read.
 */
export async function profileVersionOf(userId: string, client?: Prisma.TransactionClient): Promise<string> {
  const read = async (tx: Prisma.TransactionClient | typeof db) => {
    const [workAuth, preferences, certs, langs] = await Promise.all([
      tx.workAuthorization.findFirst({ where: { userId }, select: { updatedAt: true } }),
      tx.careerPreferences.findFirst({ where: { userId }, select: { updatedAt: true } }),
      tx.certification.aggregate({ where: { userId }, _max: { updatedAt: true }, _count: { _all: true } }),
      tx.candidateLanguage.aggregate({ where: { userId }, _max: { updatedAt: true }, _count: { _all: true } }),
    ]);
    const stamps = [workAuth?.updatedAt, preferences?.updatedAt, certs._max.updatedAt, langs._max.updatedAt].filter((d): d is Date => Boolean(d)).map((d) => d.getTime());
    const latest = stamps.length ? new Date(Math.max(...stamps)).toISOString() : '';
    return `${latest}|c${certs._count._all}|l${langs._count._all}`;
  };
  return client ? read(client) : withTenant({ userId }, read);
}

export async function loadCandidateEligibility(userId: string, purpose: ReadPurpose): Promise<CandidateEligibilityProfile> {
  await recordSecurityEvent(
    {
      event: 'eligibility.profile.read',
      user: { id: userId, email: '' },
      entityType: 'WorkAuthorization',
      entityId: userId,
      summary: `Eligibility facts read (${purpose.reason}).`,
      detail: { reason: purpose.reason, jobs: purpose.jobs ?? 1, ...(purpose.agentId ? { agentId: purpose.agentId } : {}) },
    },
    db,
    { strict: true },
  );
  return withTenant({ userId }, async (tx) => {
    const [workAuth, preferences, certifications, languages, version] = await Promise.all([
      tx.workAuthorization.findFirst({ where: { userId } }),
      tx.careerPreferences.findFirst({ where: { userId } }),
      tx.certification.findMany({ where: { userId }, select: { name: true } }),
      tx.candidateLanguage.findMany({ where: { userId }, select: { language: true, proficiency: true } }),
      profileVersionOf(userId, tx),
    ]);
    return {
      facts: {
        workAuth: workAuth ? { country: workAuth.country, status: workAuth.status, permitExpiresAt: workAuth.permitExpiresAt, sponsorshipNeeded: workAuth.sponsorshipNeeded } : null,
        preferences: preferences
          ? {
              countries: parseJson<string[]>(preferences.countries, []),
              locations: parseJson<string[]>(preferences.locations, []),
              relocation: preferences.relocation,
            }
          : null,
        certifications: certifications.map((c) => c.name),
        languages,
      },
      version,
    };
  });
}

/** The job facts the engine reads, from a canonical Job row. */
export function jobFacts(job: Pick<Job, 'title' | 'normalizedTitle' | 'canonicalHash' | 'country' | 'location' | 'postalRegion' | 'workMode' | 'workAuthorization' | 'sponsorship' | 'certificationRequirements' | 'languageRequirements'>): JobEligibilityFacts {
  return {
    title: job.title,
    normalizedTitle: job.normalizedTitle,
    // A row the canonical pipeline has not read yet carries no statements;
    // the engine answers unknown rather than "the posting states nothing".
    read: job.canonicalHash !== '',
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

export function toVerdict(r: EligibilityResult): EligibilityVerdict {
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
  // A match created while the candidate was eligible does not outlive an
  // ineligible verdict: it is demoted to `ineligible` (never deleted — the
  // score history stays), and restored to `new` when the verdict lifts.
  // The feeds also filter on the verdict itself, so this is belt and braces.
  if (verdict.outcome === 'ineligible') {
    await client.jobMatch.updateMany({ where: { jobId: job.id, agent: { userId }, status: { in: ['new', 'reviewed', 'queued'] } }, data: { status: 'ineligible' } });
  } else {
    await client.jobMatch.updateMany({ where: { jobId: job.id, agent: { userId }, status: 'ineligible' }, data: { status: 'new' } });
  }
  return { result, verdict, fresh: true };
}

/** Every job the candidate is currently excluded from, with the reasons (tenant path). */
/** The filter every recommendation query applies: no posting with an ineligible verdict for this user. */
export function notIneligibleFor(userId: string) {
  return { eligibility: { none: { userId, outcome: 'ineligible' } } } as const;
}

export async function listExclusions(tx: Prisma.TransactionClient, userId: string, limit = 200) {
  const rows = await tx.eligibilityResult.findMany({
    where: { userId, outcome: 'ineligible', job: { activeState: { not: 'closed' } } },
    orderBy: { evaluatedAt: 'desc' },
    take: limit,
    include: { job: { select: { id: true, title: true, company: true, location: true, workMode: true, postedAt: true, activeState: true } } },
  });
  return rows.map((r) => ({ ...r, verdict: toVerdict(r) }));
}

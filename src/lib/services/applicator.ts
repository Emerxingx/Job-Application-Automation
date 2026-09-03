import { db } from '@/lib/db';
import { getAIProvider } from '@/lib/providers';
import { getApplyProvider } from '@/lib/providers/apply';
import type { ApplyChannel } from '@/lib/providers/apply';
import { createApplicationFolder } from '@/lib/storage';
import { consumeQuota, refundQuota } from '@/lib/subscription';
import { parseJson } from '@/lib/types';
import type { MatchAnalysis } from '@/lib/types';
import { loadResumeContent } from '@/lib/candidate/profile';
import { withTenant } from '@/lib/tenancy/context';
import { toJobContext } from './scanner';

export interface ApplyOutcome {
  jobId: string;
  jobTitle: string;
  company: string;
  ok: boolean;
  applicationId?: string;
  matchScore?: number;
  atsScore?: number;
  folderPath?: string;
  reason?: string;
  /** How this application reached the employer. */
  channel?: ApplyChannel;
  /** True when the applicant still has to confirm on the employer's form. */
  needsConfirmation?: boolean;
}

export interface BulkApplyResult {
  requested: number;
  /** Submitted end-to-end by JobPilot. */
  submitted: number;
  /** Prepared in full, awaiting the applicant's click on the employer form. */
  prepared: number;
  failed: number;
  skipped: number;
  quotaGranted: number;
  outcomes: ApplyOutcome[];
}

/**
 * Apply to a set of matched jobs.
 *
 * Quota is reserved up front for the whole batch, then any unused portion is
 * refunded — a job that was already applied to, or whose submission failed,
 * never consumes an application from the plan.
 */
export async function applyToJobs(userId: string, jobIds: string[]): Promise<BulkApplyResult> {
  const outcomes: ApplyOutcome[] = [];
  const unique = [...new Set(jobIds)];

  const granted = await consumeQuota(userId, unique.length);
  if (granted === 0) {
    return {
      requested: unique.length,
      submitted: 0,
      prepared: 0,
      failed: 0,
      skipped: unique.length,
      quotaGranted: 0,
      outcomes: [],
    };
  }

  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  // Stage 02: the structured profile, projected, loaded on the TENANT path
  // (as app_tenant — no privilege on the sensitive schema, ADR-0007). The
  // apply engine itself stays on the system client until Stage 12 (R-35).
  const resumeContent = await withTenant({ userId }, (tx) => loadResumeContent(tx, userId));
  if (!resumeContent) {
    await refundQuota(userId, granted);
    throw new Error('Add your resume before applying.');
  }

  const ai = getAIProvider();
  const applyEngine = getApplyProvider();

  const [firstName = user.fullName, ...restName] = user.fullName.trim().split(/\s+/);

  let submitted = 0;
  let prepared = 0;
  let failed = 0;
  let skipped = 0;
  // Only the first `granted` jobs are covered by quota.
  const covered = unique.slice(0, granted);
  skipped += unique.length - covered.length;

  for (const jobId of covered) {
    const job = await db.job.findUnique({ where: { id: jobId } });
    if (!job) {
      skipped += 1;
      continue;
    }

    // One application per job per user.
    const existing = await db.application.findUnique({
      where: { userId_jobId: { userId, jobId } },
    });
    if (existing) {
      skipped += 1;
      outcomes.push({
        jobId,
        jobTitle: job.title,
        company: job.company,
        ok: false,
        reason: 'You have already applied to this role.',
      });
      continue;
    }

    try {
      const context = toJobContext(job);

      // Reuse the agent's stored analysis when present; otherwise score now.
      const match = await db.jobMatch.findFirst({
        where: { jobId, agent: { userId } },
        orderBy: { matchScore: 'desc' },
      });

      const analysis: MatchAnalysis = match
        ? {
            matchScore: match.matchScore,
            breakdown: parseJson(match.scoreBreakdown, {
              skills: 0,
              experience: 0,
              keywords: 0,
              location: 0,
              seniority: 0,
            }),
            matchedKeywords: parseJson<string[]>(match.matchedKeywords, []),
            missingKeywords: parseJson<string[]>(match.missingKeywords, []),
            rationale: match.rationale,
          }
        : await ai.analyzeMatch(resumeContent, context);

      const tailored = await ai.tailor(resumeContent, context, analysis);

      const submission = await applyEngine.apply({
        job: {
          title: job.title,
          company: job.company,
          applyUrl: job.applyUrl,
          applyMethod: job.applyMethod,
          description: job.description,
        },
        resumeText: tailored.resumeText,
        coverLetter: tailored.coverLetter,
        applicant: {
          fullName: user.fullName,
          firstName,
          lastName: restName.join(' ') || firstName,
          email: user.email,
          phone: user.phone ?? undefined,
          location: [user.city, user.country].filter(Boolean).join(', ') || undefined,
          linkedinUrl: user.linkedinUrl ?? undefined,
          portfolioUrl: user.portfolioUrl ?? undefined,
          workAuthorization: user.workAuth ?? undefined,
        },
      });

      const appliedAt = new Date();
      // An assisted application is prepared, not sent: it counts as delivered
      // work, but the record must not claim a submission that hasn't happened.
      const isAssisted = submission.ok && submission.channel === 'assisted';
      const status = !submission.ok ? 'failed' : isAssisted ? 'ready_to_submit' : 'submitted';

      const application = await db.application.create({
        data: {
          userId,
          jobId,
          agentId: match?.agentId ?? null,
          status,
          matchScore: analysis.matchScore,
          tailoredResume: tailored.resumeText,
          coverLetter: tailored.coverLetter,
          tailoringNotes: JSON.stringify(tailored.notes),
          keywordsInjected: JSON.stringify(tailored.notes.keywordsInjected),
          atsScore: tailored.notes.atsScore,
          appliedAt: status === 'submitted' ? appliedAt : null,
          failureReason: submission.failureReason ?? null,
          applyChannel: submission.channel,
          atsVendor: submission.ats ?? null,
          assistedFields: JSON.stringify(submission.assisted?.fields ?? []),
          confirmation: submission.confirmation ?? null,
        },
      });

      // Write the application folder even on failure, so the applicant can
      // still submit manually with the tailored documents in hand.
      const folderPath = await createApplicationFolder({
        userId,
        applicationId: application.id,
        job: {
          title: job.title,
          company: job.company,
          location: job.location,
          workMode: job.workMode,
          jobType: job.jobType,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          salaryCurrency: job.salaryCurrency,
          description: job.description,
          requirements: parseJson<string[]>(job.requirements, []),
          skills: parseJson<string[]>(job.skills, []),
          nocCode: job.nocCode,
          applyUrl: job.applyUrl,
          postedAt: job.postedAt,
        },
        matchScore: analysis.matchScore,
        resumeText: tailored.resumeText,
        coverLetter: tailored.coverLetter,
        notes: tailored.notes,
        appliedAt,
      });

      await db.application.update({ where: { id: application.id }, data: { folderPath } });

      if (match) {
        await db.jobMatch.update({
          where: { id: match.id },
          data: { status: submission.ok ? 'applied' : 'reviewed' },
        });
      }

      if (submission.ok) {
        if (isAssisted) prepared += 1;
        else submitted += 1;
        outcomes.push({
          jobId,
          jobTitle: job.title,
          company: job.company,
          ok: true,
          applicationId: application.id,
          matchScore: analysis.matchScore,
          atsScore: tailored.notes.atsScore,
          folderPath,
          channel: submission.channel,
          needsConfirmation: isAssisted,
        });
      } else {
        failed += 1;
        outcomes.push({
          jobId,
          jobTitle: job.title,
          company: job.company,
          ok: false,
          applicationId: application.id,
          reason: submission.failureReason,
        });
      }
    } catch (error) {
      failed += 1;
      console.error(`[applicator] job ${jobId} failed:`, error);
      outcomes.push({
        jobId,
        jobTitle: job.title,
        company: job.company,
        ok: false,
        reason: 'An unexpected error occurred while preparing this application.',
      });
    }
  }

  // Refund anything that produced no application at all. A prepared assisted
  // application consumed the tailoring work and counts against the plan.
  const delivered = submitted + prepared;
  const unused = granted - delivered;
  if (unused > 0) await refundQuota(userId, unused);

  if (delivered > 0) {
    const parts: string[] = [];
    if (submitted > 0) parts.push(`applied to ${submitted} role${submitted === 1 ? '' : 's'}`);
    if (prepared > 0) parts.push(`prepared ${prepared} ready to submit`);
    const message = `${parts.join(' and ')} with customized resumes.`;

    await db.activityEvent.create({
      data: {
        userId,
        type: 'apply',
        message: message.charAt(0).toUpperCase() + message.slice(1),
        meta: JSON.stringify({ submitted, prepared, failed, skipped }),
      },
    });
  }

  return {
    requested: unique.length,
    submitted,
    prepared,
    failed,
    skipped,
    quotaGranted: granted,
    outcomes,
  };
}

/**
 * Record that the applicant completed an assisted application on the
 * employer's form. This is the only way a `ready_to_submit` record becomes
 * `submitted` — JobPilot never infers a submission it did not make.
 */
export async function confirmAssistedSubmission(
  userId: string,
  applicationId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const application = await db.application.findFirst({
    where: { id: applicationId, userId },
  });
  if (!application) return { ok: false, reason: 'Application not found.' };
  if (application.status !== 'ready_to_submit') {
    return { ok: false, reason: 'This application is not awaiting confirmation.' };
  }

  await db.application.update({
    where: { id: application.id },
    data: { status: 'submitted', appliedAt: new Date() },
  });

  return { ok: true };
}

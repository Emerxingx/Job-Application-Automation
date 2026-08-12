import { db } from '@/lib/db';
import { getAIProvider, getJobProvider } from '@/lib/providers';
import { createApplicationFolder } from '@/lib/storage';
import { consumeQuota, refundQuota } from '@/lib/subscription';
import { parseJson } from '@/lib/types';
import type { MatchAnalysis, ResumeContent } from '@/lib/types';
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
}

export interface BulkApplyResult {
  requested: number;
  submitted: number;
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
      failed: 0,
      skipped: unique.length,
      quotaGranted: 0,
      outcomes: [],
    };
  }

  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const resume = await db.resume.findFirst({
    where: { userId, isMaster: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!resume) {
    await refundQuota(userId, granted);
    throw new Error('Add your resume before applying.');
  }

  const resumeContent = parseJson<ResumeContent | null>(resume.content, null);
  if (!resumeContent) {
    await refundQuota(userId, granted);
    throw new Error('Your resume could not be read. Please re-save it.');
  }

  const ai = getAIProvider();
  const jobs = getJobProvider();

  let submitted = 0;
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

      const submission = await jobs.submit({
        job: {
          title: job.title,
          company: job.company,
          applyUrl: job.applyUrl,
          applyMethod: job.applyMethod,
        },
        resumeText: tailored.resumeText,
        coverLetter: tailored.coverLetter,
        applicant: { fullName: user.fullName, email: user.email, phone: user.phone ?? undefined },
      });

      const appliedAt = new Date();

      const application = await db.application.create({
        data: {
          userId,
          jobId,
          agentId: match?.agentId ?? null,
          status: submission.ok ? 'submitted' : 'failed',
          matchScore: analysis.matchScore,
          tailoredResume: tailored.resumeText,
          coverLetter: tailored.coverLetter,
          tailoringNotes: JSON.stringify(tailored.notes),
          keywordsInjected: JSON.stringify(tailored.notes.keywordsInjected),
          atsScore: tailored.notes.atsScore,
          appliedAt: submission.ok ? appliedAt : null,
          failureReason: submission.failureReason ?? null,
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
        submitted += 1;
        outcomes.push({
          jobId,
          jobTitle: job.title,
          company: job.company,
          ok: true,
          applicationId: application.id,
          matchScore: analysis.matchScore,
          atsScore: tailored.notes.atsScore,
          folderPath,
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

  // Refund everything that didn't result in a real submission.
  const unused = granted - submitted;
  if (unused > 0) await refundQuota(userId, unused);

  if (submitted > 0) {
    await db.activityEvent.create({
      data: {
        userId,
        type: 'apply',
        message: `Applied to ${submitted} role${submitted === 1 ? '' : 's'} with customized resumes.`,
        meta: JSON.stringify({ submitted, failed, skipped }),
      },
    });
  }

  return {
    requested: unique.length,
    submitted,
    failed,
    skipped,
    quotaGranted: granted,
    outcomes,
  };
}

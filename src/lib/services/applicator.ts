import { db } from '@/lib/db';
import * as ai from '@/lib/ai/gateway';
import { loadEvidenceForGeneration } from '@/lib/evidence/vault';
import { getApplyProvider } from '@/lib/providers/apply';
import type { ApplyChannel } from '@/lib/providers/apply';
import { createApplicationFolder } from '@/lib/storage';
import { writeApplicationDocuments } from '@/lib/documents/application-documents';
import { sealApplicationDocuments } from '@/lib/documents/versions';
import { flushAudit, folderActor, recordInitialStatus, transitionApplication } from '@/lib/applications/service';
import { consumeQuota, refundQuota } from '@/lib/subscription';
import { parseJson } from '@/lib/types';
import type { MatchAnalysis } from '@/lib/types';
import { loadResumeContent } from '@/lib/candidate/profile';
import { withTenant } from '@/lib/tenancy/context';
import { toJobContext } from './scanner';
import { assertModePermits, storedApplicationMode, type ApplicationMode } from '@/lib/apply/modes';
import { getActiveFieldMappings } from '@/lib/apply/field-mappings';
import { prepareQuestions } from '@/lib/apply/prepare';
import { listQuestions } from '@/lib/evidence/questions';
import { atsDisplayName } from '@/lib/providers/apply';
import type { ApplicantProfile, ApplyRequest } from '@/lib/providers/apply';
import type { User } from '@prisma/client';

/** The applicant as an employer form sees them — from the profile, never from a model. */
export function applicantOf(user: Pick<User, 'fullName' | 'email' | 'phone' | 'city' | 'country' | 'linkedinUrl' | 'portfolioUrl' | 'workAuth'>): ApplicantProfile {
  const [firstName = user.fullName, ...restName] = user.fullName.trim().split(/\s+/);
  return {
    fullName: user.fullName,
    firstName,
    lastName: restName.join(' ') || firstName,
    email: user.email,
    phone: user.phone ?? undefined,
    location: [user.city, user.country].filter(Boolean).join(', ') || undefined,
    linkedinUrl: user.linkedinUrl ?? undefined,
    portfolioUrl: user.portfolioUrl ?? undefined,
    workAuthorization: user.workAuth ?? undefined,
  };
}

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
  // Stage 12 (ADR-0016): the applicant's mode. Recommend-only prepares
  // nothing; nothing here ever submits — that is a separate, instructed step.
  const mode: ApplicationMode = storedApplicationMode(user.applicationMode);
  try {
    assertModePermits(mode, 'generate_documents');
  } catch (error) {
    await refundQuota(userId, granted);
    throw error;
  }
  // Stage 02: the structured profile, projected, loaded on the TENANT path
  // (as app_tenant — no privilege on the sensitive schema, ADR-0007). The
  // apply engine itself stays on the system client until Stage 12 (R-35).
  // Stage 03: approved evidence (ids + claims) accompanies every generation.
  // Stage 12: the question bank, prepared per policy against the ACTIVE
  // field-mapping register, whose version every application records.
  const { resumeContent, evidence, questions } = await withTenant({ userId }, async (tx) => ({
    resumeContent: await loadResumeContent(tx, userId),
    evidence: await loadEvidenceForGeneration(tx, userId),
    questions: await listQuestions(tx, userId),
  }));
  if (!resumeContent) {
    await refundQuota(userId, granted);
    throw new Error('Add your resume before applying.');
  }

  const applyEngine = getApplyProvider();
  const applicant = applicantOf(user);
  const mappings = await getActiveFieldMappings();
  const preparedQuestions = prepareQuestions(questions, mappings.mappings, applicant);

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
        : (await ai.analyzeMatch({ userId, evidence, inputRefs: [`job:${jobId}`] }, resumeContent, context)).value;

      // Stage 03: the gateway resolves the tenant's AI policy, records the
      // run, and rejects unevidenced claims in code before render.
      const { value: tailored } = await ai.tailor({ userId, evidence, inputRefs: [`job:${jobId}`] }, resumeContent, context, analysis);

      const request: ApplyRequest = {
        job: {
          title: job.title,
          company: job.company,
          applyUrl: job.applyUrl,
          applyMethod: job.applyMethod,
          description: job.description,
        },
        resumeText: tailored.resumeText,
        coverLetter: tailored.coverLetter,
        applicant,
      };
      // Stage 12: preparation only. Nothing reaches the employer here, in any
      // mode; a programmatic submission is a separate step the applicant
      // instructs after review (submitThroughAts), and only where the mode
      // permits it and the employer has authorised it.
      const submission = await applyEngine.apply(request);
      const atsSubmittable = mode === 'review_submit' && applyEngine.canSubmit(request);

      const appliedAt = new Date();
      // A prepared application is prepared, not sent: it counts as delivered
      // work, but the record must not claim a submission that hasn't happened.
      const isAssisted = submission.ok;
      const status = submission.ok ? 'ready_to_submit' : 'failed';

      // Stage 10: the record and the first row of its status history — how it
      // came into being — are written together, so a folder can never exist
      // with an empty timeline (the history is the machine's evidence).
      const application = await db.$transaction(async (tx) => {
        const created = await tx.application.create({
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
            // Stage 12: nothing is sent at preparation; appliedAt is stamped by the confirm or the instructed submission.
            appliedAt: null,
            failureReason: submission.failureReason ?? null,
            applyChannel: submission.channel,
            atsVendor: submission.ats ?? null,
            assistedFields: JSON.stringify(submission.assisted?.fields ?? []),
            preparedQuestions: JSON.stringify(preparedQuestions),
            applicationMode: mode,
            fieldMappingVersion: mappings.version,
            atsSubmittable,
            confirmation: null,
          },
        });
        await recordInitialStatus(tx, userId, created.id, status, 'applicator', appliedAt);
        return created;
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

      // Stage 09: the exact documents as files — TXT, PDF and DOCX of the
      // résumé and the letter — each a hashed DocumentVersion with its ATS
      // report, sealed immutably the moment the application is submitted (an
      // assisted one is sealed when the applicant confirms). A renderer
      // failure is logged and does not fail the application: the folder and
      // the database copies above remain.
      try {
        await writeApplicationDocuments({
          userId,
          applicationId: application.id,
          jobId,
          author: user.fullName,
          company: job.company,
          resume: tailored.resumeContent,
          coverLetter: tailored.coverLetter,
          evidenceIds: evidence.ids,
          // Stage 12: never sealed at preparation — sealed when the applicant confirms or instructs the submission.
          seal: false,
        });
      } catch (error) {
        console.error('[documents] could not write the application documents:', error);
      }

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

  // Stage 10: through the status machine, so the history row, the audit row
  // and the row update commit together; appliedAt is stamped by the move.
  const actor = folderActor({ id: userId });
  await db.$transaction((tx) => transitionApplication(tx, actor, application.id, 'submitted', { actor: 'applicant', source: 'confirm', reason: 'confirmed on the employer form' }));
  await flushAudit(actor);
  // Stage 09: what was prepared is now what was sent — seal it.
  await sealApplicationDocuments(db, userId, application.id);

  return { ok: true };
}

/**
 * Stage 12 — submit a prepared application through the employer's ATS API,
 * on the applicant's explicit instruction after their review. The only
 * programmatic submission path. Refused unless the mode is Review & submit,
 * the record is `ready_to_submit`, and the employer has authorised this
 * deployment for their board. A refusal by the ATS leaves the record
 * ready for the applicant to use the form; nothing is retried unattended.
 */
export async function submitThroughAts(userId: string, applicationId: string): Promise<{ ok: boolean; reason?: string; confirmation?: string }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const mode = storedApplicationMode(user.applicationMode);
  assertModePermits(mode, 'submit_on_instruction');
  const application = await db.application.findFirst({ where: { id: applicationId, userId }, include: { job: true } });
  if (!application) return { ok: false, reason: 'Application not found.' };
  if (application.status !== 'ready_to_submit') return { ok: false, reason: 'This application is not awaiting your review.' };
  if (!application.atsSubmittable) return { ok: false, reason: 'This employer has not authorised JobPilot to submit to their applicant-tracking system. Use their form and confirm here.' };

  const request: ApplyRequest = {
    job: { title: application.job.title, company: application.job.company, applyUrl: application.job.applyUrl, applyMethod: application.job.applyMethod, description: application.job.description },
    resumeText: application.tailoredResume,
    coverLetter: application.coverLetter,
    applicant: applicantOf(user),
  };
  const engine = getApplyProvider();
  if (!engine.canSubmit(request)) return { ok: false, reason: 'This employer has not authorised JobPilot to submit to their applicant-tracking system. Use their form and confirm here.' };
  const outcome = await engine.submit(request);
  if (!outcome) return { ok: false, reason: 'No authorised submission channel exists for this posting.' };
  if (!outcome.ok) {
    await db.application.update({ where: { id: application.id }, data: { failureReason: outcome.failureReason ?? 'The employer system refused the submission.' } });
    return { ok: false, reason: outcome.failureReason ?? 'The employer system refused the submission. You can still submit on their form.' };
  }
  const via = application.atsVendor ? atsDisplayName(application.atsVendor as Parameters<typeof atsDisplayName>[0]) : 'the employer system';
  const actor = folderActor({ id: userId });
  await db.$transaction(async (tx) => {
    await tx.application.update({ where: { id: application.id }, data: { applyChannel: 'ats_api', confirmation: outcome.confirmation ?? null, failureReason: null } });
    await transitionApplication(tx, actor, application.id, 'submitted', { actor: 'applicant', source: 'ats_api', reason: `submitted through ${via} on the applicant's instruction after review` });
  });
  await flushAudit(actor);
  // Stage 09: what was reviewed is now what was sent — seal it.
  await sealApplicationDocuments(db, userId, application.id);
  return { ok: true, confirmation: outcome.confirmation };
}

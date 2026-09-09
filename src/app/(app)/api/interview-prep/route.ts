import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import * as ai from '@/lib/ai/gateway';
import { loadEvidenceForGeneration } from '@/lib/evidence/vault';
import { toJobContext } from '@/lib/services/scanner';
import { loadResumeContent } from '@/lib/candidate/profile';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, rateLimit } from '@/lib/rate-limit';

const schema = z.object({ applicationId: z.string().min(1) });

/** Generate (or regenerate) the interview preparation pack for an application. */
export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();

  // Each pack is a full generation, so it is metered like the other AI calls.
  const limit = await rateLimit('interviewPrep', user.id, LIMITS.interviewPrep);
  if (!limit.ok) {
    return tooMany(
      `You have generated a lot of prep packs. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const body = schema.parse(await request.json());

  // Reads on the tenant path; the AI call happens OUTSIDE the transaction so a
  // slow provider never holds a pooled connection.
  const loaded = await run(async (tx) => {
    const application = await tx.application.findFirst({
      where: { id: body.applicationId, userId: user.id },
      include: { job: true },
    });
    if (!application) return null;
    // Stage 02: the structured profile, projected, on the tenant path.
    const resumeContent = await loadResumeContent(tx, user.id);
    // Stage 03: approved evidence ids + claims for the run record and the corpus.
    const evidence = await loadEvidenceForGeneration(tx, user.id);
    return { application, resumeContent, evidence };
  });
  if (!loaded) return fail('Application not found.', 404);
  const { application, resumeContent, evidence } = loaded;
  if (!resumeContent) return fail('Add your resume before preparing for interviews.', 400);

  // Stage 03: through the gateway (policy resolved before dispatch, run
  // recorded, stories and answers grounded in code).
  const { value: pack } = await ai.prepareInterview(
    { userId: user.id, evidence, inputRefs: [`application:${application.id}`] },
    resumeContent,
    toJobContext(application.job),
  );

  const data = {
    questions: JSON.stringify(pack.questions),
    stories: JSON.stringify(pack.stories),
    companyResearch: pack.companyResearch,
    questionsToAsk: JSON.stringify(pack.questionsToAsk),
    status: 'ready',
  };

  const prep = await run(async (tx) => {
    const saved = await tx.interviewPrep.upsert({
      where: { applicationId: application.id },
      create: { userId: user.id, applicationId: application.id, ...data },
      update: data,
    });
    await tx.activityEvent.create({
      data: {
        userId: user.id,
        type: 'prep',
        message: `Interview prep ready for ${application.job.title} at ${application.job.company}.`,
        meta: JSON.stringify({ applicationId: application.id }),
      },
    });
    return saved;
  });

  return ok({ prepId: prep.id });
});

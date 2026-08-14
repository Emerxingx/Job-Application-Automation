import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { getAIProvider } from '@/lib/providers';
import { toJobContext } from '@/lib/services/scanner';
import { parseJson } from '@/lib/types';
import type { ResumeContent } from '@/lib/types';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, rateLimit } from '@/lib/rate-limit';

const schema = z.object({ applicationId: z.string().min(1) });

/** Generate (or regenerate) the interview preparation pack for an application. */
export const POST = route(async (request: Request) => {
  const user = await requireUser();

  // Each pack is a full generation, so it is metered like the other AI calls.
  const limit = rateLimit('interviewPrep', user.id, LIMITS.interviewPrep);
  if (!limit.ok) {
    return tooMany(
      `You have generated a lot of prep packs. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const body = schema.parse(await request.json());

  const application = await db.application.findFirst({
    where: { id: body.applicationId, userId: user.id },
    include: { job: true },
  });
  if (!application) return fail('Application not found.', 404);

  const resume = await db.resume.findFirst({
    where: { userId: user.id, isMaster: true },
    orderBy: { updatedAt: 'desc' },
  });
  const resumeContent = parseJson<ResumeContent | null>(resume?.content, null);
  if (!resumeContent) return fail('Add your resume before preparing for interviews.', 400);

  const pack = await getAIProvider().prepareInterview(
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

  const prep = await db.interviewPrep.upsert({
    where: { applicationId: application.id },
    create: { userId: user.id, applicationId: application.id, ...data },
    update: data,
  });

  await db.activityEvent.create({
    data: {
      userId: user.id,
      type: 'prep',
      message: `Interview prep ready for ${application.job.title} at ${application.job.company}.`,
      meta: JSON.stringify({ applicationId: application.id }),
    },
  });

  return ok({ prepId: prep.id });
});

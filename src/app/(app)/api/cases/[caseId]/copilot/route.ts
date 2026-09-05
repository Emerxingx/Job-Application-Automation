import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { runCopilot } from '@/lib/cases/copilot-run';

/** POST /api/cases/:caseId/copilot - run the copilot. It writes recommendations and nothing else. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ caseId: string }> }) => {
  const { caseId } = await params;
  const body = z.object({ organizationId: z.string().min(1) }).parse(await request.json());
  try {
    const { actor } = await caseRequest(request, body.organizationId);
    const result = await runCopilot(actor, caseId);
    return ok({ result });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});

import { requireTenant } from '@/lib/tenancy/request';
import { interviewPatchSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { flushAudit, folderActor, updateInterview } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string; interviewId: string }> };

export const PATCH = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id, interviewId } = await params;
  const body = interviewPatchSchema.parse(await request.json());
  const interview = await run((tx) => updateInterview(tx, actor, id, interviewId, body));
  await flushAudit(actor);
  return ok({ interview });
});

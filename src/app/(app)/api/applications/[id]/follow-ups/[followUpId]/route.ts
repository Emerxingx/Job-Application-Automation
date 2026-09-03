import { requireTenant } from '@/lib/tenancy/request';
import { followUpPatchSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { completeFollowUp, flushAudit, folderActor } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string; followUpId: string }> };

/** PATCH { done: true } — the applicant did the follow-up themselves; JobPilot sends nothing. */
export const PATCH = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id, followUpId } = await params;
  followUpPatchSchema.parse(await request.json());
  const followUp = await run((tx) => completeFollowUp(tx, actor, id, followUpId));
  await flushAudit(actor);
  return ok({ followUp });
});

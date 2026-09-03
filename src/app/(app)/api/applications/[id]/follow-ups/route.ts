import { requireTenant } from '@/lib/tenancy/request';
import { followUpSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { addFollowUp, flushAudit, folderActor } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** POST /api/applications/:id/follow-ups — plan a follow-up, optionally linked to a drafted message (Stage 09). */
export const POST = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const body = followUpSchema.parse(await request.json());
  const followUp = await run((tx) => addFollowUp(tx, actor, id, body));
  await flushAudit(actor);
  return ok({ followUp }, { status: 201 });
});

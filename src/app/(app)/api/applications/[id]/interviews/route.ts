import { requireTenant } from '@/lib/tenancy/request';
import { interviewSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { addInterview, flushAudit, folderActor } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** POST /api/applications/:id/interviews — the first interview moves a submitted application to interviewing. */
export const POST = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const body = interviewSchema.parse(await request.json());
  const interview = await run((tx) => addInterview(tx, actor, id, body));
  await flushAudit(actor);
  return ok({ interview }, { status: 201 });
});

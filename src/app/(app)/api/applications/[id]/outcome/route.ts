import { requireTenant } from '@/lib/tenancy/request';
import { outcomeSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { flushAudit, folderActor, recordOutcome } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** PUT /api/applications/:id/outcome — no response (ghosted) or the posting expired, without pretending a status change. */
export const PUT = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const body = outcomeSchema.parse(await request.json());
  const application = await run((tx) => recordOutcome(tx, actor, id, body.outcome, body.reason ?? null));
  await flushAudit(actor);
  return ok({ application });
});

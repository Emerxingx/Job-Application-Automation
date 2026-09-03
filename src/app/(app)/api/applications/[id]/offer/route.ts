import { requireTenant } from '@/lib/tenancy/request';
import { offerSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { flushAudit, folderActor, recordOffer } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** PUT /api/applications/:id/offer — the offer's terms and the applicant's decision. */
export const PUT = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const body = offerSchema.parse(await request.json());
  const application = await run((tx) => recordOffer(tx, actor, id, body));
  await flushAudit(actor);
  return ok({ application });
});

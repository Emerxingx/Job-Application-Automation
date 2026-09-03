import { requireTenant } from '@/lib/tenancy/request';
import { assessmentSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { addAssessment, flushAudit, folderActor } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

export const POST = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const body = assessmentSchema.parse(await request.json());
  const assessment = await run((tx) => addAssessment(tx, actor, id, body));
  await flushAudit(actor);
  return ok({ assessment }, { status: 201 });
});

import { requireTenant } from '@/lib/tenancy/request';
import { assessmentPatchSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { flushAudit, folderActor, updateAssessment } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string; assessmentId: string }> };

export const PATCH = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id, assessmentId } = await params;
  const body = assessmentPatchSchema.parse(await request.json());
  const assessment = await run((tx) => updateAssessment(tx, actor, id, assessmentId, body));
  await flushAudit(actor);
  return ok({ assessment });
});

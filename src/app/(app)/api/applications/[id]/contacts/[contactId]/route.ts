import { requireTenant } from '@/lib/tenancy/request';
import { contactPatchSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { flushAudit, folderActor, removeContact, updateContact } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string; contactId: string }> };

export const PATCH = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id, contactId } = await params;
  const body = contactPatchSchema.parse(await request.json());
  const contact = await run((tx) => updateContact(tx, actor, id, contactId, body));
  await flushAudit(actor);
  return ok({ contact });
});

export const DELETE = folderRoute(async (_request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id, contactId } = await params;
  await run((tx) => removeContact(tx, actor, id, contactId));
  await flushAudit(actor);
  return ok({ removed: true });
});

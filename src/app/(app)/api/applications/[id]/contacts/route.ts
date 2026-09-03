import { requireTenant } from '@/lib/tenancy/request';
import { contactSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { addContact, flushAudit, folderActor } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** POST /api/applications/:id/contacts — an employer, recruiter or referral contact on the folder. */
export const POST = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const body = contactSchema.parse(await request.json());
  const contact = await run((tx) => addContact(tx, actor, id, body));
  await flushAudit(actor);
  return ok({ contact }, { status: 201 });
});

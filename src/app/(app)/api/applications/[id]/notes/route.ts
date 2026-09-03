import { requireTenant } from '@/lib/tenancy/request';
import { noteSchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { addNote, flushAudit, folderActor } from '@/lib/applications/service';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** POST /api/applications/:id/notes — an append-only note on the folder. */
export const POST = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const { body } = noteSchema.parse(await request.json());
  const note = await run((tx) => addNote(tx, actor, id, body));
  await flushAudit(actor);
  return ok({ note }, { status: 201 });
});

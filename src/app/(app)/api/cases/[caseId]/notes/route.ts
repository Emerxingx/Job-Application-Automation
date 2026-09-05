import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest, organizationIdOf } from '@/lib/cases/request';
import { addNote, listNotes } from '@/lib/cases/service';

type Params = { params: Promise<{ caseId: string }> };

/** GET /api/cases/:caseId/notes?organizationId= - RESTRICTED; every read is audited before it happens. */
export const GET = route(async (request: Request, { params }: Params) => {
  const { caseId } = await params;
  try {
    const { tenant, actor } = await caseRequest(request, organizationIdOf(request));
    const notes = await tenant.run((tx) => listNotes(tx, actor, caseId));
    return ok({ notes: notes.map((n) => ({ id: n.id, authorEmail: n.authorEmail, body: n.body, createdAt: n.createdAt })) });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({ organizationId: z.string().min(1), body: z.string().trim().min(1).max(5000) });

/** POST /api/cases/:caseId/notes - the assigned case manager or an admin writes; audited (length only). */
export const POST = route(async (request: Request, { params }: Params) => {
  const { caseId } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const note = await tenant.run((tx) => addNote(tx, actor, caseId, body.body));
    return ok({ note: { id: note.id, createdAt: note.createdAt } }, { status: 201 });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});

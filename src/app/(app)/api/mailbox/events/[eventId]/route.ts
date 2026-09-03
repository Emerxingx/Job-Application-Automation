import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { decideEventAssociation } from '@/lib/mailbox/service';
import { mailboxRoute } from '@/lib/mailbox/route';
import { requestMeta } from '@/lib/security-audit';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ eventId: string }> };
const schema = z.object({ decision: z.enum(['confirm', 'reject']), applicationId: z.string().min(1).nullable().optional() });

/** PATCH /api/mailbox/events/:eventId — the applicant confirms (into a folder) or rejects a calendar event's association. */
export const PATCH = mailboxRoute(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { eventId } = await params;
  const body = schema.parse(await request.json());
  const event = await decideEventAssociation(user, eventId, body.decision, body.applicationId ?? null, requestMeta(request));
  return ok({ event: { id: event.id, applicationId: event.applicationId, associationStatus: event.associationStatus } });
});

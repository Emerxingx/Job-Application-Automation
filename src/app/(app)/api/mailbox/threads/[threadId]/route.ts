import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { decideThreadAssociation } from '@/lib/mailbox/service';
import { mailboxRoute } from '@/lib/mailbox/route';
import { requestMeta } from '@/lib/security-audit';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ threadId: string }> };
const schema = z.object({ decision: z.enum(['confirm', 'reject']), applicationId: z.string().min(1).nullable().optional() });

/** PATCH /api/mailbox/threads/:threadId — the applicant confirms (into a folder) or rejects an association. */
export const PATCH = mailboxRoute(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { threadId } = await params;
  const body = schema.parse(await request.json());
  const thread = await decideThreadAssociation(user, threadId, body.decision, body.applicationId ?? null, requestMeta(request));
  return ok({ thread: { id: thread.id, applicationId: thread.applicationId, associationStatus: thread.associationStatus } });
});

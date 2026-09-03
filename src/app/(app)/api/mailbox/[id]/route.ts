import { requireUser } from '@/lib/auth';
import { revokeConnection } from '@/lib/mailbox/service';
import { mailboxRoute } from '@/lib/mailbox/route';
import { requestMeta } from '@/lib/security-audit';
import { ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/mailbox/:id — revoke the grant and purge every derived row; the counts come back. */
export const DELETE = mailboxRoute(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;
  const purged = await revokeConnection(user, id, requestMeta(request));
  return ok({ revoked: true, purged });
});

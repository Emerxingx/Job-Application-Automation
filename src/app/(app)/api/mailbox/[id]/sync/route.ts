import { requireTenant } from '@/lib/tenancy/request';
import { syncConnection } from '@/lib/mailbox/service';
import { mailboxRoute } from '@/lib/mailbox/route';
import { fail, ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** POST /api/mailbox/:id/sync — ownership on the tenant path, then the sync (tokens on the system client, derived rows on the tenant path). */
export const POST = mailboxRoute(async (_request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  const owned = await run((tx) => tx.mailboxConnection.findFirst({ where: { id, userId: user.id }, select: { id: true } }));
  if (!owned) return fail('Connection not found.', 404);
  const result = await syncConnection(owned.id);
  return ok({ result });
});

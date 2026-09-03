import { requireTenant } from '@/lib/tenancy/request';
import { listConnections } from '@/lib/mailbox/service';
import { mailboxRoute } from '@/lib/mailbox/route';
import { SCOPE_INVENTORY } from '@/lib/mailbox/providers/types';
import { ok } from '@/lib/api';

/** GET /api/mailbox — the applicant's connections (never a token) and the scope inventory. */
export const GET = mailboxRoute(async () => {
  const { user, run } = await requireTenant();
  const connections = await run((tx) => listConnections(tx, user.id));
  return ok({
    connections: connections.map((c) => ({ id: c.id, provider: c.provider, kind: c.kind, accountEmail: c.accountEmail, scopes: JSON.parse(c.scopes) as string[], status: c.status, connectedAt: c.connectedAt.toISOString(), lastSyncAt: c.lastSyncAt?.toISOString() ?? null, revokedAt: c.revokedAt?.toISOString() ?? null, errorCode: c.errorCode })),
    scopes: SCOPE_INVENTORY,
  });
});

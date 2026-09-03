import { listNotifications } from '@/lib/integrations/candidate-api';
import { listEnvelope, parsePagination, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/notifications - what happened, newest first: the activity feed and the folder integration events. Ids and fixed messages only; no personal data in a notification (ADR-0013). Contract: NotificationList. */
export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const { data, total } = await listNotifications(context.key.userId, pagination);
  return v1Ok(context, listEnvelope(data, pagination, total));
});

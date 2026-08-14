/**
 * The delivery log, and the drain.
 *
 *   GET  /api/integrations/deliveries              recent attempts, newest first
 *   GET  /api/integrations/deliveries?endpointId=… scoped to one endpoint
 *   POST /api/integrations/deliveries              send everything that is due
 *
 * WHY POST EXISTS. `emitEvent` only writes rows — it deliberately does not hit
 * the network from inside a user's request. Something has to drain the queue,
 * and the honest options are a cron and a button. This is the button: it drains
 * ONLY the calling user's due deliveries, which makes it useful for a developer
 * testing an integration and useless as a way to consume anyone else's
 * capacity. A cron should call `runDueDeliveries()` without the `userId` filter.
 *
 * Not deleted after delivery: an attempt log whose rows disappear on success
 * cannot answer "did you send it?", which is the only question customers ever
 * ask about webhooks. Pruning belongs to a retention job, not to the sender.
 */

import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { runDueDeliveries, toSafeWebhookDelivery } from '@/lib/integrations/webhooks';

const listSchema = z.object({
  endpointId: z.string().trim().min(1).optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'exhausted', 'skipped']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = route(async (request: Request) => {
  const user = await requireUser();
  const url = new URL(request.url);
  const query = listSchema.parse({
    endpointId: url.searchParams.get('endpointId') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });

  // Tenancy runs through the endpoint: WebhookDelivery has no userId of its
  // own, so every query here must filter on `endpoint: { userId }` or it reads
  // other customers' rows.
  const rows = await db.webhookDelivery.findMany({
    where: {
      endpoint: { userId: user.id, ...(query.endpointId ? { id: query.endpointId } : {}) },
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
    include: { event: { select: { type: true } } },
  });

  return ok({ deliveries: rows.map(toSafeWebhookDelivery) });
});

/** Draining sends real outbound HTTP, so it is metered per user. */
const DRAIN_LIMIT = { limit: 6, windowSeconds: 60 };

export const POST = route(async () => {
  const user = await requireUser();

  const limit = rateLimit('webhook_drain', user.id, DRAIN_LIMIT);
  if (!limit.ok) {
    return tooMany(
      `Deliveries are already being sent. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  try {
    const report = await runDueDeliveries({ userId: user.id, limit: 50 });
    return ok({ report });
  } catch (error) {
    console.error('[integrations] delivery run failed:', error);
    return fail('Could not send the queued deliveries. Please try again.', 500);
  }
});

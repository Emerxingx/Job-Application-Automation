/**
 * PATCH  /api/integrations/webhooks/:id  update url, events, status, or rotate
 * DELETE /api/integrations/webhooks/:id  remove the endpoint entirely
 *
 * PATCH is also how an endpoint auto-disabled by the delivery worker gets
 * turned back on: sending `{"status":"active"}` clears `consecutiveFailures`,
 * because leaving the counter where it was would re-disable the endpoint on the
 * very next failure and make the fix look like it did not work.
 */

import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import {
  WEBHOOK_EVENT_TYPES,
  generateWebhookSecret,
  toSafeWebhookEndpoint,
  validateWebhookUrl,
} from '@/lib/integrations/webhooks';

type Params = { params: Promise<{ id: string }> };

const eventPattern = z
  .string()
  .refine(
    (value) =>
      value === '*' ||
      value.endsWith('.*') ||
      (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value),
    { message: `Unknown event. Valid events: ${WEBHOOK_EVENT_TYPES.join(', ')}, or a wildcard like "application.*".` },
  );

const patchSchema = z.object({
  url: z.string().trim().min(1).optional(),
  description: z.string().trim().max(200).optional(),
  events: z.array(eventPattern).min(1).max(50).optional(),
  /**
   * `disabled` is reachable from here as well as from the worker, so a customer
   * can switch an endpoint off without deleting it and losing its delivery log.
   */
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  /** Mint a new signing secret. The new value is returned once, like creation. */
  rotateSecret: z.boolean().optional(),
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  const body = patchSchema.parse(await request.json());

  const existing = await run((tx) => tx.webhookEndpoint.findFirst({ where: { id, userId: user.id } }));
  if (!existing) return fail('Webhook endpoint not found.', 404);

  if (body.url) {
    const url = validateWebhookUrl(body.url);
    if (!url.ok) return fail(url.message, 422);
  }

  const secret = body.rotateSecret ? generateWebhookSecret() : undefined;

  const row = await run((tx) =>
    tx.webhookEndpoint.update({
      where: { id },
      data: {
        ...(body.url ? { url: body.url.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.events ? { events: JSON.stringify([...new Set(body.events)]) } : {}),
        ...(secret ? { secret } : {}),
        ...(body.status
          ? {
              status: body.status,
              ...(body.status === 'active'
                ? // Re-enabling starts from a clean slate; see the header note.
                  { consecutiveFailures: 0, disabledAt: null, disabledReason: null }
                : {}),
            }
          : {}),
      },
    }),
  );

  return ok({
    endpoint: toSafeWebhookEndpoint(row),
    ...(secret
      ? {
          secret,
          warning:
            'The previous secret stopped working immediately. Update your receiver before the next event fires.',
        }
      : {}),
  });
});

/**
 * Deleting takes the delivery log with it — `WebhookDelivery.endpointId`
 * cascades in the schema. That is the right trade for a customer-owned
 * resource: keeping a log of deliveries to an endpoint the customer removed
 * would be retaining their data after they asked us not to. Pause instead of
 * delete when the history matters.
 */
export const DELETE = route(async (_request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;

  const deleted = await run(async (tx) => {
    const existing = await tx.webhookEndpoint.findFirst({ where: { id, userId: user.id } });
    if (!existing) return false;
    await tx.webhookEndpoint.delete({ where: { id } });
    return true;
  });
  if (!deleted) return fail('Webhook endpoint not found.', 404);
  return ok({ ok: true });
});

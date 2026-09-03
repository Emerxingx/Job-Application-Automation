/**
 * Webhook endpoint management.
 *
 *   GET  /api/integrations/webhooks   list this user's endpoints
 *   POST /api/integrations/webhooks   register one; the secret is returned ONCE
 *
 * The signing secret is the whole security model — anyone holding it can forge
 * a delivery that the customer's verification code will accept — so it follows
 * the same discipline as an API key: shown at creation, never again, rotatable.
 */

import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import {
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENT_TYPES,
  generateWebhookSecret,
  toSafeWebhookEndpoint,
  validateWebhookUrl,
} from '@/lib/integrations/webhooks';

/** Ceiling per user; six attempts per event per endpoint adds up quickly. */
const MAX_ENDPOINTS_PER_USER = 10;

export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const rows = await run((tx) =>
    tx.webhookEndpoint.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    }),
  );

  return ok({
    endpoints: rows.map(toSafeWebhookEndpoint),
    // The catalogue travels with the list so the endpoint editor never has to
    // hard-code event names that would then drift from the server's.
    availableEvents: WEBHOOK_EVENT_TYPES.map((type) => ({
      type,
      description: WEBHOOK_EVENT_DESCRIPTIONS[type],
    })),
  });
});

/**
 * `events` accepts the catalogue types plus the wildcards `*` and
 * `namespace.*`. Wildcards are allowed on purpose: a customer who wants
 * everything should not have to re-register whenever we publish a new event.
 */
const eventPattern = z
  .string()
  .refine(
    (value) =>
      value === '*' ||
      value.endsWith('.*') ||
      (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value),
    { message: `Unknown event. Valid events: ${WEBHOOK_EVENT_TYPES.join(', ')}, or a wildcard like "application.*".` },
  );

const createSchema = z.object({
  url: z.string().trim().min(1, 'A destination URL is required.'),
  description: z.string().trim().max(200).optional(),
  events: z.array(eventPattern).min(1, 'Subscribe to at least one event.').max(50),
});

export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = createSchema.parse(await request.json());

  const url = validateWebhookUrl(body.url);
  if (!url.ok) return fail(url.message, 422);

  const secret = generateWebhookSecret();
  // The ceiling check and the insert share one tenant transaction; `null`
  // means the ceiling was hit.
  const row = await run(async (tx) => {
    const count = await tx.webhookEndpoint.count({ where: { userId: user.id } });
    if (count >= MAX_ENDPOINTS_PER_USER) return null;
    return tx.webhookEndpoint.create({
      data: {
        userId: user.id,
        url: body.url.trim(),
        description: body.description ?? '',
        secret,
        events: JSON.stringify([...new Set(body.events)]),
        status: 'active',
        apiVersion: WEBHOOK_API_VERSION,
      },
    });
  });
  if (!row) {
    return fail(
      `You already have ${MAX_ENDPOINTS_PER_USER} webhook endpoints. Remove one before adding another.`,
      409,
    );
  }

  return ok(
    {
      endpoint: toSafeWebhookEndpoint(row),
      secret,
      warning:
        'Copy this signing secret now — it is not shown again. Use it to verify the JobPilot-Signature header on every delivery.',
    },
    { status: 201 },
  );
});

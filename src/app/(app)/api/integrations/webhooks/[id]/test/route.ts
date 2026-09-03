/**
 * POST /api/integrations/webhooks/:id/test — send a `ping` and report back.
 *
 * Synchronous, and it returns the exact body and signature that were sent. That
 * is the whole point: someone wiring up verification for the first time needs
 * to compare their computed HMAC against ours, and "check the delivery log in a
 * few minutes" is not a debugging loop anyone can work in.
 *
 * The ping is delivered whatever the endpoint is subscribed to, and whether or
 * not it is paused — testing an endpoint you have switched off is a reasonable
 * thing to want to do before switching it back on. It is NOT retried: a manual
 * test that failed must not leave six hours of background attempts behind it.
 */

import { requireTenant } from '@/lib/tenancy/request';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { WEBHOOK_SIGNATURE_HEADER, sendTestEvent } from '@/lib/integrations/webhooks';

type Params = { params: Promise<{ id: string }> };

/**
 * This endpoint makes an outbound request to a URL the caller chose, so it is
 * a request-forgery amplifier if left unmetered — `validateWebhookUrl` blocks
 * the obvious targets, but a probe of ten arbitrary hosts a minute is still
 * something we should not offer for free.
 */
const TEST_LIMIT = { limit: 10, windowSeconds: 60 };

export const POST = route(async (_request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;

  const limit = rateLimit('webhook_test', user.id, TEST_LIMIT);
  if (!limit.ok) {
    return tooMany(
      `Too many test deliveries. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  // The lookup runs on the tenant path; the outbound request below stays
  // outside the transaction.
  const endpoint = await run((tx) => tx.webhookEndpoint.findFirst({ where: { id, userId: user.id } }));
  if (!endpoint) return fail('Webhook endpoint not found.', 404);

  const result = await sendTestEvent({
    id: endpoint.id,
    url: endpoint.url,
    secret: endpoint.secret,
    apiVersion: endpoint.apiVersion,
  });

  return ok({
    delivered: result.status === 'succeeded',
    responseStatus: result.responseStatus,
    responseBody: result.responseBody,
    errorMessage: result.errorMessage,
    durationMs: result.durationMs,
    // Everything needed to reproduce the HMAC by hand. The secret is still not
    // included — the customer already has it, and the signature is what tells
    // them whether their computation matches ours.
    sent: {
      body: result.body,
      signatureHeader: WEBHOOK_SIGNATURE_HEADER,
      signature: result.signature,
    },
  });
});

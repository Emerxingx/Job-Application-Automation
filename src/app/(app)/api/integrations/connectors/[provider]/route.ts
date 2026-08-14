/**
 * PUT    /api/integrations/connectors/:provider  connect or reconfigure
 * DELETE /api/integrations/connectors/:provider  disconnect
 *
 * PUT rather than POST: the resource is `(user, provider)`, which is unique in
 * the schema, and sending the same configuration twice must leave the same
 * single row rather than creating a second one. `connectIntegration` upserts.
 *
 * Configuring a connector that is registered but not implemented returns 422
 * with the reason. It does NOT quietly store the settings — a row that looks
 * connected and delivers nothing is worse than an error message, because the
 * error is noticed and the silence is not.
 */

import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import {
  connectIntegration,
  disconnectIntegration,
  getConnector,
} from '@/lib/integrations/connectors';

type Params = { params: Promise<{ provider: string }> };

const putSchema = z.object({
  /** Shape is connector-specific; each connector's `validateConfig` checks it. */
  config: z.record(z.unknown()),
  displayName: z.string().trim().max(80).optional(),
});

export const PUT = route(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { provider } = await params;

  const connector = getConnector(provider);
  if (!connector) return fail('Unknown connector.', 404);

  const body = putSchema.parse(await request.json());
  const result = await connectIntegration(user.id, connector.id, body.config, body.displayName);
  if (!result.ok) return fail(result.message, 422);

  return ok({ integration: result.integration });
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { provider } = await params;

  const connector = getConnector(provider);
  if (!connector) return fail('Unknown connector.', 404);

  const integration = await disconnectIntegration(user.id, connector.id);
  if (!integration) return fail('That connector is not connected.', 404);

  return ok({ integration });
});

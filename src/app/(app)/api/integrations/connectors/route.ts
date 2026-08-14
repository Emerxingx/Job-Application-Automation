/**
 * GET /api/integrations/connectors — the catalogue and what the user has
 * connected.
 *
 * The response pairs each registered connector with the user's `Integration`
 * row for it, when one exists. `implemented: false` entries are included rather
 * than filtered out: the settings page should show Slack as a known, planned
 * connector that does not work yet, because a customer asking "do you integrate
 * with Slack?" deserves a real answer either way.
 */

import { requireUser } from '@/lib/auth';
import { ok, route } from '@/lib/api';
import { describeConnector, listConnectors, listIntegrations } from '@/lib/integrations/connectors';

export const GET = route(async () => {
  const user = await requireUser();
  const [connectors, integrations] = await Promise.all([
    Promise.resolve(listConnectors()),
    listIntegrations(user.id),
  ]);

  const byProvider = new Map(integrations.map((integration) => [integration.provider, integration]));

  return ok({
    connectors: connectors.map((connector) => ({
      ...describeConnector(connector),
      integration: byProvider.get(connector.id) ?? null,
    })),
  });
});

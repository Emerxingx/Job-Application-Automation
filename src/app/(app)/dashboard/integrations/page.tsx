import { Terminal } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { API_SCOPES, listApiKeys, type ApiScope } from '@/lib/integrations/api-keys';
import {
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENT_TYPES,
  toSafeWebhookDelivery,
  toSafeWebhookEndpoint,
} from '@/lib/integrations/webhooks';
import { Card, PageHeader, formatRelative } from '@/components/ui';
import { ApiKeysPanel } from './api-keys-panel';
import { WebhooksPanel } from './webhooks-panel';
import type { ApiKeyView, EventOption, ScopeOption, WebhookView } from './types';

export const metadata = { title: 'Integrations' };
export const dynamic = 'force-dynamic';

/** Attempts shown inline per endpoint. The full log lives in the delivery table. */
const RECENT_DELIVERIES = 5;

/** Plain-language gloss for each scope. The vocabulary itself lives in the lib. */
const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  read: 'Read jobs, matches, applications and analytics.',
  write: 'Create and update records. Includes everything read can do.',
  'apply:write': 'Submit applications on your behalf.',
  'scan:read': 'Read the results of agent scans.',
  'match:score': 'Read match scores and their rationales.',
  admin: 'Everything, including managing keys and endpoints.',
};

/** Published REST surface, so the page states what a key is actually for. */
const ENDPOINTS = [
  { method: 'GET', path: '/api/v1/applications', note: 'Your applications, filterable by status' },
  { method: 'GET', path: '/api/v1/jobs', note: 'Scored job matches from your agents' },
  { method: 'GET', path: '/api/v1/analytics/summary', note: 'Funnel counts and rates' },
];

function dateLabel(value: Date): string {
  return value.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function IntegrationsPage() {
  const { user, run } = await requireTenant();

  const [keys, endpointRows] = await Promise.all([
    listApiKeys(user.id),
    run((tx) =>
      tx.webhookEndpoint.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        include: {
          deliveries: {
            orderBy: { createdAt: 'desc' },
            take: RECENT_DELIVERIES,
            include: { event: { select: { type: true } } },
          },
          // Counted separately from the five rows above: an endpoint can have
          // dozens of queued attempts that never appear in the recent list.
          _count: { select: { deliveries: { where: { status: 'pending' } } } },
        },
      }),
    ),
  ]);

  const keyViews: ApiKeyView[] = keys.map((key) => ({
    id: key.id,
    name: key.name,
    masked: key.masked,
    environment: key.environment,
    scopes: key.scopes,
    rateLimitPerMinute: key.rateLimitPerMinute,
    requestCount: key.requestCount,
    createdLabel: dateLabel(key.createdAt),
    lastUsedLabel: key.lastUsedAt ? `last used ${formatRelative(key.lastUsedAt)}` : 'never used',
    expiresLabel: key.expiresAt ? dateLabel(key.expiresAt) : null,
    revoked: key.revoked,
    revokedLabel: key.revokedAt ? formatRelative(key.revokedAt) : null,
  }));

  const endpointViews: WebhookView[] = endpointRows.map((row) => {
    // `toSafeWebhookEndpoint` is the one place that decides what is safe to
    // expose; in particular it drops `secret`, which must never reach the
    // client after the moment the endpoint was created.
    const safe = toSafeWebhookEndpoint(row);
    return {
      id: safe.id,
      url: safe.url,
      description: safe.description,
      events: safe.events,
      status: safe.status,
      apiVersion: safe.apiVersion,
      consecutiveFailures: safe.consecutiveFailures,
      disabledReason: safe.disabledAt
        ? (safe.disabledReason ??
          'Disabled automatically after repeated failures. Delete it and add it again once the receiver is fixed.')
        : null,
      createdLabel: dateLabel(safe.createdAt),
      lastSuccessLabel: safe.lastSuccessAt ? formatRelative(safe.lastSuccessAt) : null,
      lastFailureLabel: safe.lastFailureAt ? formatRelative(safe.lastFailureAt) : null,
      pendingDeliveries: row._count.deliveries,
      deliveries: row.deliveries.map(toSafeWebhookDelivery).map((delivery) => ({
        id: delivery.id,
        eventType: delivery.eventType,
        status: delivery.status,
        responseStatus: delivery.responseStatus,
        durationMs: delivery.durationMs,
        whenLabel: formatRelative(delivery.deliveredAt ?? delivery.scheduledAt),
        errorMessage: delivery.errorMessage,
      })),
    };
  });

  const scopeOptions: ScopeOption[] = API_SCOPES.map((scope) => ({
    value: scope,
    label: scope,
    description: SCOPE_DESCRIPTIONS[scope],
  }));

  const eventOptions: EventOption[] = WEBHOOK_EVENT_TYPES.map((type) => ({
    type,
    description: WEBHOOK_EVENT_DESCRIPTIONS[type],
  }));

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect JobPilot to your own tools — pull data out with an API key, or have JobPilot push events to you as they happen."
      />

      <div className="space-y-8">
        <ApiKeysPanel keys={keyViews} scopeOptions={scopeOptions} />

        {/* A key is only useful with somewhere to point it. */}
        <Card className="p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <Terminal className="h-4 w-4 text-brand-500" aria-hidden="true" />
            Using a key
          </h2>
          <div className="scroll-x mt-3">
            <pre className="w-max min-w-full rounded-xl border border-line bg-raised px-3.5 py-3 font-mono text-xs text-ink">
              <code>{`curl https://jobpilot.ai/api/v1/applications?status=submitted \\
  -H "Authorization: Bearer jp_live_…"`}</code>
            </pre>
          </div>

          <ul className="mt-4 divide-y divide-line">
            {ENDPOINTS.map((endpoint) => (
              <li key={endpoint.path} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="chip shrink-0 font-mono text-brand-600">{endpoint.method}</span>
                <code className="min-w-0 break-all font-mono text-xs text-ink">
                  {endpoint.path}
                </code>
                <span className="text-xs text-muted">{endpoint.note}</span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-faint">
            Rate limits are per key and returned on every response in the{' '}
            <code className="rounded bg-raised px-1 py-0.5 text-ink">RateLimit-Remaining</code>{' '}
            header.
          </p>
        </Card>

        <WebhooksPanel endpoints={endpointViews} eventOptions={eventOptions} />
      </div>
    </>
  );
}

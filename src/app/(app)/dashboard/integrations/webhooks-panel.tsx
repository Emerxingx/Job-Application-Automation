'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Send,
  Trash2,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import { Card, cn } from '@/components/ui';
import { OneTimeSecret } from './api-keys-panel';
import { callApi } from './request';
import type { DeliveryView, EventOption, WebhookView } from './types';

interface CreateEndpointResponse {
  endpoint: { id: string; url: string };
  secret: string;
}

interface TestResponse {
  delivered: boolean;
  responseStatus: number | null;
  responseBody: string;
  errorMessage: string | null;
  durationMs: number;
  sent: { body: string; signatureHeader: string; signature: string };
}

interface DrainResponse {
  report: { claimed: number; succeeded: number; failed: number; exhausted: number };
}

const DELIVERY_STYLE: Record<string, { label: string; className: string }> = {
  succeeded: { label: 'Delivered', className: 'bg-success/10 text-success' },
  pending: { label: 'Queued', className: 'bg-raised text-muted' },
  failed: { label: 'Retrying', className: 'bg-warn/10 text-warn' },
  exhausted: { label: 'Gave up', className: 'bg-danger/10 text-danger' },
  skipped: { label: 'Skipped', className: 'bg-raised text-faint' },
};

const ENDPOINT_STYLE: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-success/10 text-success' },
  paused: { label: 'Paused', className: 'bg-raised text-faint' },
  disabled: { label: 'Disabled', className: 'bg-danger/10 text-danger' },
};

function DeliveryRow({ delivery }: { delivery: DeliveryView }) {
  const style = DELIVERY_STYLE[delivery.status] ?? {
    label: delivery.status,
    className: 'bg-raised text-muted',
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-lg px-2 py-0.5 font-semibold',
          style.className,
        )}
      >
        {style.label}
      </span>
      <code className="shrink-0 font-mono text-muted">{delivery.eventType}</code>
      <span className="tabular-nums text-faint">
        {delivery.responseStatus === null ? 'no response' : `HTTP ${delivery.responseStatus}`} ·{' '}
        {delivery.durationMs}ms
      </span>
      <span className="ml-auto shrink-0 text-faint">{delivery.whenLabel}</span>
      {delivery.errorMessage && (
        <span className="w-full break-words text-danger">{delivery.errorMessage}</span>
      )}
    </li>
  );
}

export function WebhooksPanel({
  endpoints,
  eventOptions,
}: {
  endpoints: WebhookView[];
  eventOptions: EventOption[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(eventOptions.map((option) => option.type));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    ok: boolean;
    message: string;
    signature?: string;
  } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const [drainMessage, setDrainMessage] = useState<string | null>(null);

  const queued = endpoints.reduce((sum, endpoint) => sum + endpoint.pendingDeliveries, 0);

  function toggleEvent(type: string) {
    setEvents((current) =>
      current.includes(type) ? current.filter((event) => event !== type) : [...current, type],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const result = await callApi<CreateEndpointResponse>('/api/integrations/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url: url.trim(), description: description.trim(), events }),
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSecret({ url: result.data.endpoint.url, secret: result.data.secret });
    setShowForm(false);
    setUrl('');
    setDescription('');
    router.refresh();
  }

  async function test(endpointId: string) {
    setError(null);
    setTestResult(null);
    setTesting(endpointId);

    const result = await callApi<TestResponse>(
      `/api/integrations/webhooks/${endpointId}/test`,
      { method: 'POST' },
    );

    setTesting(null);

    if (!result.ok) {
      setTestResult({ id: endpointId, ok: false, message: result.error });
      return;
    }

    const data = result.data;
    setTestResult({
      id: endpointId,
      ok: data.delivered,
      signature: data.sent.signature,
      message: data.delivered
        ? `Delivered in ${data.durationMs}ms — your endpoint answered ${data.responseStatus}.`
        : data.responseStatus !== null
          ? `Your endpoint answered ${data.responseStatus}${data.responseBody ? `: ${data.responseBody.slice(0, 160)}` : '.'}`
          : (data.errorMessage ?? 'The request never reached your endpoint.'),
    });
    router.refresh();
  }

  async function remove(endpointId: string) {
    setError(null);
    setDeletingId(endpointId);

    const result = await callApi(`/api/integrations/webhooks/${endpointId}`, {
      method: 'DELETE',
    });

    setDeletingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirmingId(null);
    router.refresh();
  }

  /**
   * Events are queued by the app and sent by a worker. Without a way to drain
   * the queue on demand, a developer wiring up an integration sees rows stuck
   * on "Queued" and reasonably concludes the feature is broken.
   */
  async function drain() {
    setError(null);
    setDrainMessage(null);
    setDraining(true);

    const result = await callApi<DrainResponse>('/api/integrations/deliveries', {
      method: 'POST',
    });

    setDraining(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    const report = result.data.report;
    setDrainMessage(
      report.claimed === 0
        ? 'Nothing was due to send.'
        : `Sent ${report.claimed}: ${report.succeeded} delivered, ${report.failed + report.exhausted} failed.`,
    );
    router.refresh();
  }

  return (
    <section aria-labelledby="webhooks-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="webhooks-heading" className="text-lg font-semibold text-ink">
            Webhook endpoints
          </h2>
          <p className="mt-1 text-sm text-muted">
            JobPilot POSTs each event to your URL and signs it with the{' '}
            <code className="rounded bg-raised px-1 py-0.5 text-xs text-ink">JobPilot-Signature</code>{' '}
            header. Verify that header before trusting a payload.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {queued > 0 && (
            <button
              type="button"
              onClick={drain}
              disabled={draining}
              className="btn-ghost px-2.5 py-2 text-xs"
            >
              {draining ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {draining ? 'Sending…' : `Send ${queued} queued`}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setShowForm((open) => !open);
              setError(null);
            }}
            aria-expanded={showForm}
            className="btn-secondary px-3 py-2 text-xs"
          >
            {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showForm ? 'Cancel' : 'Add endpoint'}
          </button>
        </div>
      </div>

      {secret && (
        <OneTimeSecret
          title="Endpoint added — here is its signing secret"
          secret={secret.secret}
          note={`Use it to verify every delivery to ${secret.url}. If you lose it, rotate the secret from the API rather than guessing.`}
          onDismiss={() => setSecret(null)}
        />
      )}

      {error && (
        <p
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {drainMessage && (
        <p role="status" className="mb-3 rounded-xl bg-raised px-3 py-2.5 text-sm text-muted">
          {drainMessage}
        </p>
      )}

      {showForm && (
        <Card className="mb-4 p-5">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="hook-url" className="label">
                Destination URL
              </label>
              <input
                id="hook-url"
                type="url"
                className="input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/hooks/jobpilot"
                required
              />
              <p className="mt-1 text-xs text-faint">
                Must be https in production, and answer with a 2xx within 10 seconds.
              </p>
            </div>

            <div>
              <label htmlFor="hook-description" className="label">
                Description <span className="font-normal text-faint">(optional)</span>
              </label>
              <input
                id="hook-description"
                className="input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Notion tracker"
                maxLength={200}
              />
            </div>

            <fieldset>
              <legend className="label">Events to send</legend>
              <div className="space-y-2">
                {eventOptions.map((option) => (
                  <label
                    key={option.type}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition',
                      events.includes(option.type)
                        ? 'border-brand-500 bg-brand-500/5'
                        : 'border-line hover:bg-raised',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
                      checked={events.includes(option.type)}
                      onChange={() => toggleEvent(option.type)}
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-xs font-semibold text-ink">
                        {option.type}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              {events.length === 0 && (
                <p className="mt-2 text-xs text-warn">Subscribe to at least one event.</p>
              )}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={busy || events.length === 0 || url.trim().length === 0}
                className="btn-primary"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Webhook className="h-4 w-4" aria-hidden="true" />
                )}
                {busy ? 'Adding…' : 'Add endpoint'}
              </button>
              <p className="text-xs text-muted">The signing secret is shown once.</p>
            </div>
          </form>
        </Card>
      )}

      {endpoints.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-raised text-muted">
            <Webhook className="h-5 w-5" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-ink">No endpoints yet</h3>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
            Add a URL and JobPilot will notify it the moment an application is submitted or an
            agent finds a match — no polling required.
          </p>
          <button type="button" onClick={() => setShowForm(true)} className="btn-primary mt-5">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add your first endpoint
          </button>
        </Card>
      ) : (
        <ul className="space-y-3">
          {endpoints.map((endpoint) => {
            const style = ENDPOINT_STYLE[endpoint.status] ?? {
              label: endpoint.status,
              className: 'bg-raised text-muted',
            };
            const result = testResult?.id === endpoint.id ? testResult : null;

            return (
              <Card as="li" key={endpoint.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="min-w-0 break-all font-mono text-sm font-semibold text-ink">
                        {endpoint.url}
                      </h3>
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center rounded-lg px-2 py-0.5 text-xs font-semibold',
                          style.className,
                        )}
                      >
                        {style.label}
                      </span>
                    </div>

                    {endpoint.description && (
                      <p className="mt-1 text-sm text-muted">{endpoint.description}</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {endpoint.events.map((event) => (
                        <span key={event} className="chip font-mono">
                          {event}
                        </span>
                      ))}
                    </div>

                    <p className="mt-2 text-xs text-faint">
                      Added {endpoint.createdLabel} · API {endpoint.apiVersion}
                      {endpoint.lastSuccessLabel && ` · last success ${endpoint.lastSuccessLabel}`}
                      {endpoint.consecutiveFailures > 0 &&
                        ` · ${endpoint.consecutiveFailures} failure${
                          endpoint.consecutiveFailures === 1 ? '' : 's'
                        } in a row`}
                    </p>

                    {endpoint.disabledReason && (
                      <p className="mt-2 text-xs text-danger">{endpoint.disabledReason}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => test(endpoint.id)}
                      disabled={testing === endpoint.id}
                      className="btn-secondary px-2.5 py-1.5 text-xs"
                    >
                      {testing === endpoint.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {testing === endpoint.id ? 'Sending…' : 'Send test'}
                    </button>

                    {confirmingId === endpoint.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => remove(endpoint.id)}
                          disabled={deletingId === endpoint.id}
                          className="btn bg-danger px-2.5 py-1.5 text-xs text-white hover:opacity-90"
                        >
                          {deletingId === endpoint.id && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          )}
                          Yes, delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingId(null)}
                          className="btn-ghost px-2.5 py-1.5 text-xs"
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingId(endpoint.id)}
                        aria-label={`Delete endpoint ${endpoint.url}`}
                        className="btn-secondary px-2.5 py-1.5 text-xs text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {confirmingId === endpoint.id && (
                  <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                    Deleting removes the endpoint, its signing secret and its delivery history.
                    Queued deliveries are dropped.
                  </p>
                )}

                {result && (
                  <div
                    role="status"
                    className={cn(
                      'mt-3 rounded-xl px-3 py-2 text-xs',
                      result.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
                    )}
                  >
                    <p className="flex items-start gap-2">
                      {result.ok ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      )}
                      {result.message}
                    </p>
                    {result.signature && (
                      // The signature we actually sent. When someone's
                      // verification rejects a delivery, comparing this against
                      // their own HMAC is the fastest way to find out whose
                      // side is wrong.
                      <p className="mt-1.5 break-all font-mono text-[11px] opacity-80">
                        signature sent: {result.signature}
                      </p>
                    )}
                  </div>
                )}

                {endpoint.deliveries.length > 0 && (
                  <details className="mt-3 border-t border-line pt-3">
                    <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
                      Recent deliveries ({endpoint.deliveries.length})
                    </summary>
                    <ul className="mt-1 divide-y divide-line">
                      {endpoint.deliveries.map((delivery) => (
                        <DeliveryRow key={delivery.id} delivery={delivery} />
                      ))}
                    </ul>
                  </details>
                )}
              </Card>
            );
          })}
        </ul>
      )}
    </section>
  );
}

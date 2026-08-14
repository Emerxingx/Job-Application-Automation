'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldOff,
  X,
} from 'lucide-react';
import { Card, cn } from '@/components/ui';
import { callApi } from './request';
import type { ApiKeyView, ScopeOption } from './types';

interface CreateKeyResponse {
  key: { name: string; masked: string };
  secret: string;
}

interface RevealedKey {
  name: string;
  secret: string;
  masked: string;
}

export function ApiKeysPanel({
  keys,
  scopeOptions,
}: {
  keys: ApiKeyView[];
  scopeOptions: ScopeOption[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<'live' | 'test'>('live');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const active = keys.filter((key) => !key.revoked);
  const revoked = keys.filter((key) => key.revoked);

  function toggleScope(value: string) {
    setScopes((current) =>
      current.includes(value) ? current.filter((scope) => scope !== value) : [...current, value],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const result = await callApi<CreateKeyResponse>('/api/integrations/keys', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), environment, scopes }),
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setRevealed({
      name: result.data.key.name,
      secret: result.data.secret,
      masked: result.data.key.masked,
    });
    setShowForm(false);
    setName('');
    setScopes(['read']);
    router.refresh();
  }

  async function revoke(keyId: string) {
    setError(null);
    setRevokingId(keyId);

    const result = await callApi(`/api/integrations/keys/${keyId}`, { method: 'DELETE' });

    setRevokingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirmingId(null);
    router.refresh();
  }

  return (
    <section aria-labelledby="api-keys-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="api-keys-heading" className="text-lg font-semibold text-ink">
            API keys
          </h2>
          <p className="mt-1 text-sm text-muted">
            Authenticate against the JobPilot API at{' '}
            <code className="rounded bg-raised px-1 py-0.5 text-xs text-ink">/api/v1</code> with an{' '}
            <code className="rounded bg-raised px-1 py-0.5 text-xs text-ink">
              Authorization: Bearer
            </code>{' '}
            header.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowForm((open) => !open);
            setError(null);
          }}
          aria-expanded={showForm}
          className="btn-secondary shrink-0 px-3 py-2 text-xs"
        >
          {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showForm ? 'Cancel' : 'New key'}
        </button>
      </div>

      {/* One-time reveal. Deliberately loud, and it does not disappear on its
          own — losing this value means minting a replacement key. */}
      {revealed && (
        <OneTimeSecret
          title={`“${revealed.name}” is ready`}
          secret={revealed.secret}
          note={`After you dismiss this, the key shows as ${revealed.masked} everywhere in JobPilot.`}
          onDismiss={() => setRevealed(null)}
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

      {showForm && (
        <Card className="mb-4 p-5">
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="key-name" className="label">
                  Key name
                </label>
                <input
                  id="key-name"
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Zapier automation"
                  maxLength={80}
                  minLength={2}
                  required
                />
                <p className="mt-1 text-xs text-faint">
                  Only you see this. Name it after where it will live.
                </p>
              </div>

              <div>
                <label htmlFor="key-env" className="label">
                  Environment
                </label>
                <select
                  id="key-env"
                  className="input"
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value as 'live' | 'test')}
                >
                  <option value="live">Live — reads and writes your real data</option>
                  <option value="test">Test — for local development</option>
                </select>
              </div>
            </div>

            <fieldset>
              <legend className="label">Scopes</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {scopeOptions.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition',
                      scopes.includes(option.value)
                        ? 'border-brand-500 bg-brand-500/5'
                        : 'border-line hover:bg-raised',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
                      checked={scopes.includes(option.value)}
                      onChange={() => toggleScope(option.value)}
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-xs font-semibold text-ink">
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              {scopes.length === 0 && (
                <p className="mt-2 text-xs text-warn">Pick at least one scope.</p>
              )}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={busy || scopes.length === 0 || name.trim().length < 2}
                className="btn-primary"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                )}
                {busy ? 'Creating…' : 'Create key'}
              </button>
              <p className="text-xs text-muted">The key is shown once and cannot be recovered.</p>
            </div>
          </form>
        </Card>
      )}

      {keys.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-raised text-muted">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-ink">No API keys yet</h3>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
            Create a key to pull your matches, applications and analytics into your own tools.
          </p>
          <button type="button" onClick={() => setShowForm(true)} className="btn-primary mt-5">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create your first key
          </button>
        </Card>
      ) : (
        <ul className="space-y-3">
          {[...active, ...revoked].map((key) => (
            <Card as="li" key={key.id} className={cn('p-4', key.revoked && 'opacity-70')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-ink">{key.name}</h3>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-semibold',
                        key.revoked
                          ? 'bg-raised text-faint'
                          : key.environment === 'test'
                            ? 'bg-raised text-muted'
                            : 'bg-success/10 text-success',
                      )}
                    >
                      {key.revoked ? 'Revoked' : key.environment === 'test' ? 'Test' : 'Live'}
                    </span>
                  </div>

                  <p className="mt-1 break-all font-mono text-xs text-muted">{key.masked}</p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {key.scopes.map((scope) => (
                      <span key={scope} className="chip font-mono">
                        {scope}
                      </span>
                    ))}
                  </div>

                  <p className="mt-2 text-xs text-faint">
                    Created {key.createdLabel} · {key.lastUsedLabel} ·{' '}
                    {key.requestCount.toLocaleString('en-CA')} request
                    {key.requestCount === 1 ? '' : 's'} · {key.rateLimitPerMinute}/min
                    {key.expiresLabel && ` · expires ${key.expiresLabel}`}
                    {key.revokedLabel && ` · revoked ${key.revokedLabel}`}
                  </p>
                </div>

                {!key.revoked && (
                  <div className="shrink-0">
                    {confirmingId === key.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted">Revoke for good?</span>
                        <button
                          type="button"
                          onClick={() => revoke(key.id)}
                          disabled={revokingId === key.id}
                          className="btn bg-danger px-2.5 py-1.5 text-xs text-white hover:opacity-90"
                        >
                          {revokingId === key.id && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          )}
                          Yes, revoke
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingId(null)}
                          className="btn-ghost px-2.5 py-1.5 text-xs"
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingId(key.id)}
                        aria-label={`Revoke API key ${key.name}`}
                        className="btn-secondary px-2.5 py-1.5 text-xs text-danger"
                      >
                        <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                        Revoke
                      </button>
                    )}
                  </div>
                )}
              </div>

              {confirmingId === key.id && (
                <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                  Anything using this key stops working immediately. The record stays, so you can
                  still see when it was last used.
                </p>
              )}
            </Card>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- One-time secret --------------------------------------------------------

/**
 * The single moment a secret is visible.
 *
 * Rendered as an assertive live region so a screen reader announces it, rather
 * than leaving someone to discover a value they will never be shown again. The
 * dismiss button says what dismissing costs.
 */
export function OneTimeSecret({
  title,
  secret,
  note,
  onDismiss,
}: {
  title: string;
  secret: string;
  note: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard permission can be denied; the value stays selectable.
      setCopied(false);
    }
  }

  return (
    // A plain element rather than <Card>, because this one needs `role` and
    // `aria-live`; the `.card` utility keeps it visually identical.
    <div role="alert" aria-live="assertive" className="card mb-4 border-warn/50 bg-warn/5 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warn/10">
          <AlertTriangle className="h-4 w-4 text-warn" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <p className="mt-1 text-sm text-ink">
            <strong className="font-semibold">
              Copy it now — this is the only time it is shown.
            </strong>{' '}
            JobPilot stores a hash, not the value, so it cannot be recovered or emailed to you.
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="scroll-x block flex-1 whitespace-nowrap rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-xs text-ink">
              {secret}
            </code>
            <button
              type="button"
              onClick={copy}
              className="btn-secondary shrink-0 px-3 py-2 text-xs"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <p className="mt-2 text-xs text-muted">{note}</p>

          <button
            type="button"
            onClick={onDismiss}
            className="btn-ghost mt-3 px-2.5 py-1.5 text-xs"
          >
            I have saved it — hide this
          </button>
        </div>
      </div>
    </div>
  );
}

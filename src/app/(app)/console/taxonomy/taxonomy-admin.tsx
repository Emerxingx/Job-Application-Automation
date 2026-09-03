'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';
import type { CompletenessReport } from '@/lib/taxonomy/queries';

export interface DatasetView {
  key: string;
  name: string;
  publisher: string;
  scheme: string;
  version: string;
  sourceUrl: string;
  licenceName: string;
  licenceUrl: string;
  attribution: string;
  publisherTerms: string;
  licenceStatus: string;
  licenceRecordedByEmail: string | null;
  licenceRecordedAt: string | null;
  ingestionApproved: boolean;
  ingestedAt: string | null;
  rowCount: number;
  notes: string;
}

const STATUS_TONE: Record<string, string> = {
  recorded: 'bg-success/10 text-success',
  prohibited: 'bg-danger/10 text-danger',
  unrecorded: 'bg-warn/10 text-warn',
};

export function TaxonomyAdmin({ datasets, report }: { datasets: DatasetView[]; report: CompletenessReport }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ currentPassword: '', status: 'recorded', licenceName: '', licenceUrl: '', attribution: '', ingestionApproved: false, reason: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(key: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/console/taxonomy/datasets/${key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as { error?: string; purged?: { occupations: number; codes: number } };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The record was refused.' });
        if (res.status === 403) setForm({ ...form, currentPassword: '' });
      } else {
        const purged = data.purged && (data.purged.occupations || data.purged.codes) ? ` Purged ${data.purged.occupations} occupations and ${data.purged.codes} codes.` : '';
        setMessage({ ok: true, text: `Licence state recorded for ${key}.${purged}` });
        setEditing(null);
        setForm({ ...form, currentPassword: '' });
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-base font-semibold text-ink">What is loaded</h2>
        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Occupations</dt>
            <dd className="text-ink">{report.occupations}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Codes by scheme</dt>
            <dd className="text-ink">{Object.entries(report.codesByScheme).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Unit groups without a SOC crosswalk</dt>
            <dd className="text-ink">{report.unitGroupsWithoutSoc.length}</dd>
          </div>
          {Object.entries(report.missingLabels).map(([locale, slugs]) => (
            <div key={locale}>
              <dt className="text-xs text-muted">Missing {locale.toUpperCase()} labels</dt>
              <dd className="text-ink">{slugs.length}</dd>
            </div>
          ))}
          <div>
            <dt className="text-xs text-muted">Orphaned nodes</dt>
            <dd className="text-ink">{report.orphans.length}</dd>
          </div>
        </dl>
      </Card>

      <p role="status" aria-live="polite" className={cn('m-0 flex items-center gap-1 text-sm', message?.ok ? 'text-success' : 'text-danger')}>
        {message && (
          <>
            {message.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
            {message.text}
          </>
        )}
      </p>

      {datasets.map((d) => (
        <Card key={d.key}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink">{d.name}</h2>
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[d.licenceStatus] ?? STATUS_TONE.unrecorded)}>{d.licenceStatus}</span>
            {d.ingestionApproved && <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-xs text-brand-600">ingestion approved</span>}
            <span className="ml-auto text-xs text-muted">
              {d.scheme} · {d.version} · {d.rowCount} rows{d.ingestedAt ? ` · loaded ${new Date(d.ingestedAt).toLocaleDateString('en-CA')}` : ' · not loaded'}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            {d.publisher}
            {d.sourceUrl && (
              <>
                {' · '}
                <a href={d.sourceUrl} className="text-brand-500 hover:text-brand-600" target="_blank" rel="noreferrer noopener">
                  source
                </a>
              </>
            )}
          </p>
          {d.publisherTerms && (
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium">Publisher&rsquo;s stated terms (unconfirmed, not a licence record):</span> {d.publisherTerms}
            </p>
          )}
          {d.notes && (
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium">Governance notes:</span> {d.notes}
            </p>
          )}
          {d.licenceStatus !== 'unrecorded' && (
            <p className="mt-1 text-xs text-muted">
              {d.licenceName || 'No licence name'}
              {d.attribution ? ` · attribution: “${d.attribution}”` : ''}
              {d.licenceRecordedByEmail ? ` · recorded by ${d.licenceRecordedByEmail}` : ''}
            </p>
          )}
          {editing === d.key ? (
            <form
              className="mt-3 grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(d.key);
              }}
            >
              <label className="block text-sm">
                <span className="font-medium text-ink">Decision</span>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input mt-1 w-full">
                  <option value="recorded">Licence recorded</option>
                  <option value="prohibited">Prohibited by counsel</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Licence name</span>
                <input type="text" value={form.licenceName} onChange={(e) => setForm({ ...form, licenceName: e.target.value })} className="input mt-1 w-full" maxLength={200} />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Licence URL</span>
                <input type="url" value={form.licenceUrl} onChange={(e) => setForm({ ...form, licenceUrl: e.target.value })} className="input mt-1 w-full" maxLength={500} />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Attribution text to display</span>
                <input type="text" value={form.attribution} onChange={(e) => setForm({ ...form, attribution: e.target.value })} className="input mt-1 w-full" maxLength={1000} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.ingestionApproved} onChange={(e) => setForm({ ...form, ingestionApproved: e.target.checked })} />
                Approve ingestion
              </label>
              {d.rowCount > 0 && (form.status === 'prohibited' || !form.ingestionApproved) && (
                <p className="text-xs text-danger sm:col-span-2" role="note">
                  This decision withdraws the right to serve {d.rowCount} loaded rows: they will be purged, and jobs will lose their occupation link.
                </p>
              )}
              <label className="block text-sm">
                <span className="font-medium text-ink">Current password (re-authentication)</span>
                <input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} className="input mt-1 w-full" />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Reason (the review or counsel advice this records)</span>
                <input type="text" required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="input mt-1 w-full" maxLength={500} />
              </label>
              <div className="flex gap-2">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Record
                </button>
                <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn-secondary mt-3 px-3 py-1.5 text-xs" aria-label={`Record licence for ${d.name}`} onClick={() => setEditing(d.key)}>
              Record licence decision
            </button>
          )}
        </Card>
      ))}
    </div>
  );
}

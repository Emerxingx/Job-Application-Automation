'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search } from 'lucide-react';
import { Card } from '@/components/ui';

interface OccupationOption {
  id: string;
  title: string;
  codes: { scheme: string; code: string }[];
}

/** The spine's search view (labels per locale) reduced to one line. */
function toOption(o: { id: string; slug: string; labels: { locale: string; title: string }[]; codes: { scheme: string; code: string }[] }): OccupationOption {
  return { id: o.id, title: o.labels.find((l) => l.locale === 'en')?.title ?? o.labels[0]?.title ?? o.slug, codes: o.codes.map((c) => ({ scheme: c.scheme, code: c.code })) };
}

/**
 * Stage 16 (ADR-0031): pick a target occupation from the licensed spine
 * (and optionally the current one) and start an analysis. The spine is only
 * as full as the licences recorded on /console/taxonomy: an empty search is
 * said so, never padded.
 */
export function CareerPlanner({ remaining, limit, unlimited }: { remaining: number; limit: number; unlimited: boolean }) {
  const router = useRouter();
  const [target, setTarget] = useState<OccupationOption | null>(null);
  const [current, setCurrent] = useState<OccupationOption | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStart = unlimited || remaining > 0;

  async function start() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/career/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetOccupationId: target.id, currentOccupationId: current?.id ?? null, title: title.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not start the analysis.');
        setBusy(false);
        return;
      }
      router.push(`/dashboard/career/${data.plan.id}`);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Start a transition analysis</h2>
      <p className="mt-1 text-sm text-muted">
        {limit === 0
          ? 'Career transition analysis is not included in your plan.'
          : unlimited
            ? 'Your plan includes unlimited analyses.'
            : `${remaining} of ${limit} analyses left in the last 30 days.`}
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <OccupationPicker label="Target occupation" value={target} onChange={setTarget} />
        <OccupationPicker label="Current occupation (optional)" value={current} onChange={setCurrent} />
      </div>
      <label className="mt-4 flex flex-col text-sm">
        <span className="text-muted">Plan title (optional)</span>
        <input className="rounded-md border border-line bg-surface px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <button type="button" onClick={start} disabled={!target || !canStart || busy} className="btn-primary mt-4">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? 'Analysing…' : 'Analyse the transition'}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

function OccupationPicker({ label, value, onChange }: { label: string; value: OccupationOption | null; onChange: (o: OccupationOption | null) => void }) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<OccupationOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const term = q.trim();
  const active = term.length >= 2;
  useEffect(() => {
    // Nothing is set synchronously here: below two characters the list is
    // simply not rendered (`active`), and the fetch itself sets state later.
    if (!active) return;
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/taxonomy/occupations?q=${encodeURIComponent(term)}&limit=8`);
        const data = await res.json();
        setOptions(res.ok ? (data.occupations as Parameters<typeof toOption>[0][]).map(toOption) : []);
      } catch {
        setOptions([]);
      } finally {
        setSearching(false);
        setSearched(true);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [term, active]);

  const inputId = `occ-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="text-sm">
      <label htmlFor={inputId} className="text-muted">
        {label}
      </label>
      {value ? (
        <div className="mt-1 flex items-center justify-between rounded-md border border-line bg-raised px-3 py-2">
          <span className="text-ink">
            {value.title} <span className="text-xs text-muted">{value.codes.map((c) => `${c.scheme} ${c.code}`).join(' · ')}</span>
          </span>
          <button type="button" className="text-xs text-muted underline" onClick={() => onChange(null)}>
            change
          </button>
        </div>
      ) : (
        <div className="relative mt-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
          <input id={inputId} className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or NOC code" autoComplete="off" role="combobox" aria-autocomplete="list" aria-controls={active && options.length > 0 ? `${inputId}-list` : undefined} aria-expanded={active && options.length > 0} />
          {searching ? <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted" aria-label="Searching" /> : null}
          {active && options.length > 0 ? (
            <ul id={`${inputId}-list`} role="listbox" className="absolute z-10 mt-1 w-full rounded-md border border-line bg-surface shadow">
              {options.map((o) => (
                <li key={o.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left hover:bg-raised"
                    onClick={() => {
                      onChange(o);
                      setQ('');
                      setOptions([]);
                    }}
                  >
                    {o.title} <span className="text-xs text-muted">{o.codes.map((c) => `${c.scheme} ${c.code}`).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : active && searched && !searching ? (
            <p className="mt-1 text-xs text-muted">No occupation matches. The spine holds only what a recorded licence has loaded.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

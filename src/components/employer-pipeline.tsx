'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Search } from 'lucide-react';
import { Card, StatusBadge } from '@/components/ui';

export interface PipelineRow {
  id: string;
  stage: string;
  source: string;
  disclosed: boolean;
  candidate: { name: string | null; headline: string | null; city: string | null };
  counts: { interviews: number; notes: number; offers: number };
}

interface SourcedCard {
  candidateUserId: string;
  visibility: 'anonymous' | 'visible';
  score: number;
  matched: string[];
  missing: string[];
  region: string;
  name: string | null;
  headline: string | null;
  disclosure: string;
  submissionStage: string | null;
}

/**
 * Stage 18 (ADR-0033): a requisition's pipeline and candidate sourcing.
 * Sourcing returns anonymised, scored cards (a hidden candidate never
 * appears; an anonymous one has no name); a recruiter asks for disclosure
 * and the candidate answers under their Settings. Nothing past consent is
 * possible without it.
 */
export function EmployerPipeline({ organizationId, requisitionId, status, rows, canWrite, canSource }: { organizationId: string; requisitionId: string; status: string; rows: PipelineRow[]; canWrite: boolean; canSource: boolean }) {
  const router = useRouter();
  const [cards, setCards] = useState<SourcedCard[] | null>(null);
  const [considered, setConsidered] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(key: string, url: string, method: string, body?: unknown) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'The request failed.');
        return null;
      }
      return data as Record<string, unknown>;
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function source() {
    const data = await call('source', `/api/employer/requisitions/${requisitionId}/sourcing?organizationId=${organizationId}`, 'GET');
    if (data) {
      setCards(data.cards as SourcedCard[]);
      setConsidered(data.considered as number);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">Pipeline</h2>
            <p className="text-xs text-muted">A name appears only once the candidate has granted disclosure to your organisation. Every stage past consent needs it.</p>
          </div>
          {canSource && status === 'open' ? (
            <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={source}>
              {busy === 'source' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              Find candidates
            </button>
          ) : null}
        </div>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2">Candidate</th>
              <th className="py-2">Stage</th>
              <th className="py-2">Source</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="py-4 text-muted" colSpan={4}>
                  Nobody in the pipeline yet.
                </td>
              </tr>
            ) : null}
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className="py-2">
                  {s.disclosed ? (
                    <>
                      <span className="font-medium text-ink">{s.candidate.name}</span>
                      <p className="text-xs text-muted">{[s.candidate.headline, s.candidate.city].filter(Boolean).join(' · ')}</p>
                    </>
                  ) : (
                    <span className="text-muted">Undisclosed candidate</span>
                  )}
                </td>
                <td className="py-2">
                  <StatusBadge status={s.stage} />
                </td>
                <td className="py-2 text-muted">{s.source}</td>
                <td className="py-2 text-right">
                  <Link href={`/dashboard/employer/submissions/${s.id}?org=${organizationId}`} className="text-xs underline">
                    open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {cards ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Sourced candidates</h2>
          <p className="text-xs text-muted">
            {considered} candidate{considered === 1 ? '' : 's'} open to recruiters were scored against this posting; the best {cards.length} are shown. An anonymous card shows fit and region only; ask for disclosure to see who it is. This search was recorded.
          </p>
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {cards.map((c) => (
              <li key={c.candidateUserId} className="rounded-md border border-line p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">{c.name ?? 'Anonymous candidate'}</span>
                  <span className="text-xs text-muted">fit {c.score}</span>
                </div>
                <p className="text-xs text-muted">{[c.headline, c.region].filter(Boolean).join(' · ')}</p>
                <p className="mt-1 text-xs text-muted">Matches: {c.matched.join(', ') || '—'}</p>
                {c.missing.length ? <p className="text-xs text-muted">Missing: {c.missing.join(', ')}</p> : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {c.disclosure === 'granted' ? (
                    <span className="text-xs text-success">disclosed</span>
                  ) : c.disclosure === 'requested' ? (
                    <span className="text-xs text-muted">disclosure requested</span>
                  ) : c.disclosure === 'declined' ? (
                    <span className="text-xs text-muted">declined</span>
                  ) : canSource ? (
                    <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={async () => (await call(c.candidateUserId, '/api/employer/disclosures', 'POST', { organizationId, candidateUserId: c.candidateUserId, requisitionId })) && (source(), router.refresh())}>
                      Ask for disclosure
                    </button>
                  ) : null}
                  {canWrite && !c.submissionStage ? (
                    <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={async () => (await call(`add-${c.candidateUserId}`, `/api/employer/requisitions/${requisitionId}/submissions`, 'POST', { organizationId, candidateUserId: c.candidateUserId })) && (source(), router.refresh())}>
                      Add to pipeline
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

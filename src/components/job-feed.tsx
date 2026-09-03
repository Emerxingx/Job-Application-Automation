'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, MapPin, Sparkles, Wallet } from 'lucide-react';
import { Card, ScoreRing, cn, formatRelative, formatSalary, scoreTone } from '@/components/ui';

export interface JobFeedItem {
  matchId: string;
  jobId: string;
  title: string;
  company: string;
  location: string;
  workMode: string;
  jobType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  postedAt: string;
  matchScore: number;
  rationale: string;
  matchedKeywords: string[];
  missingKeywords: string[];
  agentName: string;
  /** Stage 07: `unknown` when an eligibility rule left a question open (never an exclusion). */
  eligibility?: 'eligible' | 'unknown';
}

type SortKey = 'score' | 'recent' | 'salary';

interface ApplyResult {
  submitted: number;
  prepared: number;
  failed: number;
  skipped: number;
  outcomes: { jobTitle: string; company: string; ok: boolean; reason?: string }[];
}

export function JobFeed({ items, remaining }: { items: JobFeedItem[]; remaining: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState(0);
  const [sort, setSort] = useState<SortKey>('score');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const filtered = items.filter((i) => i.matchScore >= minScore);
    return [...filtered].sort((a, b) => {
      if (sort === 'recent') return +new Date(b.postedAt) - +new Date(a.postedAt);
      if (sort === 'salary') return (b.salaryMax ?? 0) - (a.salaryMax ?? 0);
      return b.matchScore - a.matchScore;
    });
  }, [items, minScore, sort]);

  function toggle(jobId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function selectAllVisible() {
    // Selecting more than the quota allows is permitted — the server applies
    // as many as the plan covers and reports the rest as skipped.
    setSelected(new Set(visible.map((i) => i.jobId)));
  }

  async function apply(jobIds: string[]) {
    if (jobIds.length === 0) return;
    setApplying(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Could not submit applications.');
        return;
      }

      setResult(data);
      setSelected(new Set());
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div>
      {/* Controls */}
      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-5">
            <div>
              <label htmlFor="minScore" className="label mb-1 text-xs">
                Minimum match: <span className="tabular-nums text-brand-600">{minScore}%</span>
              </label>
              <input
                id="minScore"
                type="range"
                min={0}
                max={95}
                step={5}
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                className="w-40 accent-brand-500"
              />
            </div>

            <div>
              <label htmlFor="sort" className="label mb-1 text-xs">
                Sort by
              </label>
              <select
                id="sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="input py-1.5 text-sm"
              >
                <option value="score">Best match</option>
                <option value="recent">Most recent</option>
                <option value="salary">Highest salary</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">
              {visible.length} job{visible.length === 1 ? '' : 's'} · {remaining} application
              {remaining === 1 ? '' : 's'} left
            </span>
            <button onClick={selectAllVisible} className="btn-secondary px-3 py-1.5 text-xs">
              Select all
            </button>
            {selected.size > 0 && (
              <button
                onClick={() => setSelected(new Set())}
                className="btn-ghost px-3 py-1.5 text-xs"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* Bulk apply bar */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 mb-5">
          <Card className="flex flex-wrap items-center justify-between gap-3 border-brand-500 bg-brand-500/5 p-4 shadow-lift">
            <div>
              <p className="text-sm font-semibold text-ink">
                {selected.size} job{selected.size === 1 ? '' : 's'} selected
              </p>
              <p className="text-xs text-muted">
                {selected.size > remaining
                  ? `Your plan covers ${remaining} more this cycle — the rest will be skipped.`
                  : 'Each gets a tailored resume, a cover letter and its own folder.'}
              </p>
            </div>
            <button
              onClick={() => apply([...selected])}
              disabled={applying}
              className="btn-primary"
            >
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {applying ? 'Applying…' : `Apply to ${Math.min(selected.size, remaining)}`}
            </button>
          </Card>
        </div>
      )}

      {/* Feedback */}
      {error && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2 rounded-xl bg-danger/10 p-4 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <Card className="mb-5 border-success/40 bg-success/5 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">
                {[
                  result.submitted > 0 &&
                    `${result.submitted} application${result.submitted === 1 ? '' : 's'} submitted`,
                  result.prepared > 0 && `${result.prepared} prepared for your review`,
                ]
                  .filter(Boolean)
                  .join(', ') || 'Nothing was prepared'}
                {result.failed > 0 && `, ${result.failed} need${result.failed === 1 ? 's' : ''} attention`}
                {result.skipped > 0 && `, ${result.skipped} skipped`}
              </p>
              <p className="mt-0.5 text-sm text-muted">
                {result.prepared > 0
                  ? 'Each one has its own folder with every field prepared. Nothing has been sent: review it, then submit on the employer form — or, where the employer has authorised it, from the folder with one click.'
                  : 'Each one has its own folder with the resume and cover letter that were sent.'}
              </p>
              <Link
                href="/dashboard/applications"
                className="mt-2 inline-block text-sm font-semibold text-brand-500 hover:text-brand-600"
              >
                View your applications →
              </Link>
            </div>
          </div>
        </Card>
      )}

      {/* Feed */}
      <ul className="space-y-3">
        {visible.map((item) => {
          const tone = scoreTone(item.matchScore);
          const isSelected = selected.has(item.jobId);

          return (
            <Card
              as="li"
              key={item.matchId}
              className={cn('p-4 transition', isSelected && 'border-brand-500 ring-1 ring-brand-500')}
            >
              <div className="flex items-start gap-4">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(item.jobId)}
                  aria-label={`Select ${item.title} at ${item.company}`}
                  className="mt-1.5 h-4 w-4 shrink-0 rounded accent-brand-500"
                />

                <ScoreRing score={item.matchScore} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <h3 className="font-semibold text-ink">{item.title}</h3>
                    <span className={cn('text-xs font-semibold', tone.text)}>{tone.label} fit</span>
                  </div>
                  <p className="text-sm text-muted">{item.company}</p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {item.location} · {item.workMode}
                    </span>
                    <span className="flex items-center gap-1">
                      <Wallet className="h-3 w-3" />
                      {formatSalary(item.salaryMin, item.salaryMax, item.salaryCurrency)}
                    </span>
                    <span>Posted {formatRelative(item.postedAt)}</span>
                    {item.eligibility === 'unknown' && (
                      <span className="chip text-warning" title="An eligibility rule left a question open; nothing here excludes you. See the posting for details.">
                        Eligibility unconfirmed
                      </span>
                    )}
                  </div>

                  <p className="mt-2.5 line-clamp-2 text-sm text-muted">{item.rationale}</p>

                  {item.matchedKeywords.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {item.matchedKeywords.slice(0, 6).map((k) => (
                        <span key={k} className="chip bg-success/10 text-success">
                          {k}
                        </span>
                      ))}
                      {item.missingKeywords.slice(0, 3).map((k) => (
                        <span key={k} className="chip text-faint line-through">
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-col gap-2">
                  <button
                    onClick={() => apply([item.jobId])}
                    disabled={applying || remaining === 0}
                    className="btn-primary px-3 py-1.5 text-xs"
                  >
                    Apply
                  </button>
                  <Link
                    href={`/dashboard/jobs/${item.jobId}`}
                    className="btn-secondary px-3 py-1.5 text-xs"
                  >
                    Details
                  </Link>
                </div>
              </div>
            </Card>
          );
        })}
      </ul>

      {visible.length === 0 && (
        <p className="py-12 text-center text-sm text-muted">
          No jobs meet a {minScore}% match. Lower the threshold to see more.
        </p>
      )}
    </div>
  );
}

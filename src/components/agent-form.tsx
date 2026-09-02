'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { Card } from '@/components/ui';

/** Comma/enter-driven tag input. */
function TagInput({
  id,
  label,
  hint,
  placeholder,
  values,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  function commit() {
    const parts = draft
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    onChange([...new Set([...values, ...parts])]);
    setDraft('');
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {hint && <p className="-mt-1 mb-1.5 text-xs text-faint">{hint}</p>}

      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span key={v} className="chip bg-brand-500/10 text-brand-600">
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                aria-label={`Remove ${v}`}
                className="ml-0.5 rounded hover:text-brand-700"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          placeholder={placeholder}
          className="input"
        />
        <button type="button" onClick={commit} className="btn-secondary shrink-0 px-3">
          Add
        </button>
      </div>
    </div>
  );
}

export function AgentForm({ defaultLocation }: { defaultLocation?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [titles, setTitles] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [excludeKeywords, setExcludeKeywords] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>(
    defaultLocation ? [defaultLocation] : ['Remote'],
  );
  const [workMode, setWorkMode] = useState('any');
  const [jobType, setJobType] = useState('full_time');
  const [minSalary, setMinSalary] = useState('');
  const [minMatchScore, setMinMatchScore] = useState(65);
  // Fixed, not state: the auto-apply control is disabled because automatic
  // submission is not implemented (see the form field below and
  // docs/adr/ADR-0016-application-automation.md). These are still sent so the
  // API contract and the Agent model are unchanged — Stage 00 touches no schema.
  const autoApply = false;
  const autoApplyThreshold = 85;
  const [scanFrequency, setScanFrequency] = useState('daily');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (titles.length === 0) {
      setError('Add at least one job title for this agent to search for.');
      return;
    }
    if (locations.length === 0) {
      setError('Add at least one location (use "Remote" if location does not matter).');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || `${titles[0]} search`,
          titles,
          keywords,
          excludeKeywords,
          locations,
          workMode,
          jobType,
          minSalary: minSalary ? Number(minSalary) : null,
          seniority: 'any',
          minMatchScore,
          autoApply,
          autoApplyThreshold,
          scanFrequency,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Could not create the agent.');
        setLoading(false);
        return;
      }

      router.push('/dashboard/agents');
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-5">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Card className="space-y-5 p-6">
        <h2 className="font-semibold text-ink">What to look for</h2>

        <div>
          <label className="label" htmlFor="name">
            Agent name
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Senior Data Roles — Toronto"
            className="input"
          />
        </div>

        <TagInput
          id="titles"
          label="Job titles"
          hint="The exact titles you want. Add several variations to widen the net."
          placeholder="Senior Data Analyst"
          values={titles}
          onChange={setTitles}
        />

        <TagInput
          id="keywords"
          label="Must-have keywords (optional)"
          hint="Skills or tools that should appear in the posting."
          placeholder="SQL, Python, dbt"
          values={keywords}
          onChange={setKeywords}
        />

        <TagInput
          id="exclude"
          label="Exclude keywords (optional)"
          hint="Postings containing these are filtered out."
          placeholder="unpaid, commission-only"
          values={excludeKeywords}
          onChange={setExcludeKeywords}
        />
      </Card>

      <Card className="space-y-5 p-6">
        <h2 className="font-semibold text-ink">Where and what kind</h2>

        <TagInput
          id="locations"
          label="Locations"
          hint='Cities, provinces or states. Use "Remote" for anywhere.'
          placeholder="Toronto, ON"
          values={locations}
          onChange={setLocations}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="workMode">
              Work arrangement
            </label>
            <select
              id="workMode"
              value={workMode}
              onChange={(e) => setWorkMode(e.target.value)}
              className="input"
            >
              <option value="any">Any</option>
              <option value="remote">Remote only</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">On-site</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="jobType">
              Employment type
            </label>
            <select
              id="jobType"
              value={jobType}
              onChange={(e) => setJobType(e.target.value)}
              className="input"
            >
              <option value="any">Any</option>
              <option value="full_time">Full-time</option>
              <option value="part_time">Part-time</option>
              <option value="contract">Contract</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="minSalary">
            Minimum salary (optional)
          </label>
          <input
            id="minSalary"
            type="number"
            min={0}
            step={5000}
            value={minSalary}
            onChange={(e) => setMinSalary(e.target.value)}
            placeholder="95000"
            className="input"
          />
        </div>
      </Card>

      <Card className="space-y-5 p-6">
        <h2 className="font-semibold text-ink">How selective to be</h2>

        <div>
          <label className="label" htmlFor="minMatch">
            Only show matches above{' '}
            <span className="tabular-nums text-brand-600">{minMatchScore}%</span>
          </label>
          <input
            id="minMatch"
            type="range"
            min={0}
            max={95}
            step={5}
            value={minMatchScore}
            onChange={(e) => setMinMatchScore(Number(e.target.value))}
            className="w-full accent-brand-500"
          />
          <p className="mt-1 text-xs text-faint">
            Higher keeps the feed focused; lower surfaces more stretch opportunities.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="scanFrequency">
            Scan frequency
          </label>
          <select
            id="scanFrequency"
            value={scanFrequency}
            onChange={(e) => setScanFrequency(e.target.value)}
            className="input"
          >
            <option value="hourly">Hourly — first-mover advantage</option>
            <option value="twice_daily">Twice daily</option>
            <option value="daily">Daily</option>
            <option value="manual">Manual only</option>
          </select>
        </div>

        {/*
          AUTOMATIC APPLICATION IS NOT IMPLEMENTED, AND THIS CONTROL MUST NOT
          IMPLY THAT IT IS.

          This block previously rendered an enabled checkbox reading "Apply
          automatically to strong matches", with the sub-label "Applications are
          submitted without asking, using quota from your plan." None of that is
          true. `autoApplyThreshold` is read in exactly one place —
          src/lib/services/scanner.ts — where it only increments a counter of
          matches above the threshold. No scheduler exists (the `AgentSchedule`
          model has no code that reads it), so nothing is ever submitted
          unattended.

          Applying without a human in the loop is deliberately out of scope until
          Stage 22, and is gated on lawfulness review and an explicit founder
          decision — see docs/adr/ADR-0016-application-automation.md.

          The control is therefore disabled and labelled accurately rather than
          removed: the `autoApply` and `autoApplyThreshold` columns still exist on
          the Agent model, and Stage 00 does not change the schema.
        */}
        {/*
          The container is NOT dimmed with opacity. The explanatory copy below is
          informative content, not an inactive control: at `opacity-70` the muted
          token resolves to roughly rgb(136,133,129) on this background, which is
          3.5:1 and fails WCAG 2.2 AA (4.5:1) for text this size. Undimmed it is
          7.3:1. The disabled checkbox is dimmed by the browser's own native
          disabled styling, which is what 1.4.3 exempts.
        */}
        <div className="rounded-xl border border-line p-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={false}
              disabled
              readOnly
              aria-describedby="auto-apply-note"
              className="mt-0.5 h-4 w-4 accent-brand-500 opacity-60"
            />
            <span>
              <span className="block text-sm font-medium text-ink">
                Apply automatically to strong matches
                <span className="ml-2 align-middle text-[11px] font-normal uppercase tracking-wide text-muted">
                  Not available
                </span>
              </span>
              <span id="auto-apply-note" className="mt-0.5 block text-xs text-muted">
                JobPilot never submits an application on its own. Every application is
                prepared for you — tailored resume, cover letter and answers — and you
                confirm it before it is sent.
              </span>
            </span>
          </label>
        </div>
      </Card>

      <div className="flex gap-3">
        <button type="submit" disabled={loading} className="btn-primary">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Create agent
        </button>
        <button type="button" onClick={() => router.back()} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

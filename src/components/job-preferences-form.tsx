'use client';

import { useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

/**
 * Career preferences and work authorisation (Stage 02 Digital Twin). Two
 * forms, two endpoints, each saving its own row on the tenant path. Every
 * control is labelled; groups are fieldsets with legends; status is announced.
 */

export interface PreferencesValues {
  targetTitles: string;
  adjacentTitles: string;
  employmentTypes: string[];
  workModes: string[];
  locations: string;
  countries: string[];
  salaryMin: string;
  salaryCurrency: 'CAD' | 'USD';
  relocation: 'no' | 'open' | 'yes';
  recruiterVisibility: 'hidden' | 'anonymous' | 'visible';
  noticePeriodDays: string;
  availableFrom: string;
}

export interface WorkAuthorizationValues {
  country: 'CA' | 'US';
  status: string;
  permitType: string;
  permitExpiresAt: string;
  sponsorshipNeeded: boolean;
  notes: string;
}

const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function Status({ saving, saved, error }: { saving: boolean; saved: boolean; error: string | null }) {
  return (
    <div className="mt-4 flex items-center gap-3" role="status" aria-live="polite">
      <button type="submit" disabled={saving} className="btn-primary">
        {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Save
      </button>
      {saved && (
        <span className="flex items-center gap-1 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Saved
        </span>
      )}
      {error && (
        <span className="flex items-center gap-1 text-sm text-danger" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" /> {error}
        </span>
      )}
    </div>
  );
}

export function JobPreferencesForm({ initial }: { initial: PreferencesValues }) {
  const [v, setV] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof PreferencesValues>(k: K, value: PreferencesValues[K]) => {
    setV((p) => ({ ...p, [k]: value }));
    setSaved(false);
  };
  const toggle = (k: 'employmentTypes' | 'workModes' | 'countries', value: string) =>
    set(k, v[k].includes(value) ? v[k].filter((x) => x !== value) : [...v[k], value]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/profile/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetTitles: list(v.targetTitles),
          adjacentTitles: list(v.adjacentTitles),
          employmentTypes: v.employmentTypes,
          workModes: v.workModes,
          locations: list(v.locations),
          countries: v.countries,
          salaryMinCents: v.salaryMin ? Math.round(Number(v.salaryMin) * 100) : null,
          salaryCurrency: v.salaryCurrency,
          relocation: v.relocation,
          recruiterVisibility: v.recruiterVisibility,
          autonomy: 'assist_only',
          noticePeriodDays: v.noticePeriodDays ? Number(v.noticePeriodDays) : null,
          availableFrom: v.availableFrom || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Could not save.');
      else setSaved(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} aria-labelledby="prefs-heading">
      <Card className="max-w-2xl p-6">
      <h2 id="prefs-heading" className="font-semibold text-ink">
        Job preferences
      </h2>
      <p className="mt-1 text-sm text-muted">
        What you are looking for. Used to filter and rank jobs; nothing here is shared with an
        employer unless you choose to be visible to recruiters.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="targetTitles">
            Target job titles
          </label>
          <input id="targetTitles" className="input" value={v.targetTitles} onChange={(e) => set('targetTitles', e.target.value)} aria-describedby="targetTitles-help" />
          <p id="targetTitles-help" className="mt-1 text-xs text-muted">
            Separate with commas.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="adjacentTitles">
            Adjacent titles you would consider
          </label>
          <input id="adjacentTitles" className="input" value={v.adjacentTitles} onChange={(e) => set('adjacentTitles', e.target.value)} />
        </div>
        <fieldset className="sm:col-span-1">
          <legend className="label">Employment type</legend>
          {(['full_time', 'part_time', 'contract', 'internship'] as const).map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={v.employmentTypes.includes(t)} onChange={() => toggle('employmentTypes', t)} />
              {t.replace('_', '-')}
            </label>
          ))}
        </fieldset>
        <fieldset className="sm:col-span-1">
          <legend className="label">Work mode</legend>
          {(['onsite', 'hybrid', 'remote'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={v.workModes.includes(m)} onChange={() => toggle('workModes', m)} />
              {m}
            </label>
          ))}
        </fieldset>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="locations">
            Locations
          </label>
          <input id="locations" className="input" value={v.locations} onChange={(e) => set('locations', e.target.value)} placeholder="Toronto, ON; Remote" />
        </div>
        <fieldset className="sm:col-span-1">
          <legend className="label">Countries</legend>
          {(['CA', 'US'] as const).map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={v.countries.includes(c)} onChange={() => toggle('countries', c)} />
              {c === 'CA' ? 'Canada' : 'United States'}
            </label>
          ))}
        </fieldset>
        <div>
          <label className="label" htmlFor="salaryMin">
            Minimum salary ({v.salaryCurrency})
          </label>
          <input id="salaryMin" className="input" inputMode="numeric" value={v.salaryMin} onChange={(e) => set('salaryMin', e.target.value.replace(/[^\d]/g, ''))} />
        </div>
        <div>
          <label className="label" htmlFor="salaryCurrency">
            Currency
          </label>
          <select id="salaryCurrency" className="input" value={v.salaryCurrency} onChange={(e) => set('salaryCurrency', e.target.value as 'CAD' | 'USD')}>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="relocation">
            Relocation
          </label>
          <select id="relocation" className="input" value={v.relocation} onChange={(e) => set('relocation', e.target.value as PreferencesValues['relocation'])}>
            <option value="no">Not willing to relocate</option>
            <option value="open">Open to relocating</option>
            <option value="yes">Actively want to relocate</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="recruiterVisibility">
            Visibility to recruiters
          </label>
          <select id="recruiterVisibility" className="input" value={v.recruiterVisibility} onChange={(e) => set('recruiterVisibility', e.target.value as PreferencesValues['recruiterVisibility'])} aria-describedby="visibility-help">
            <option value="hidden">Hidden (default)</option>
            <option value="anonymous">Anonymous profile only</option>
            <option value="visible">Visible</option>
          </select>
          <p id="visibility-help" className="mt-1 text-xs text-muted">
            No recruiter features exist yet; this records your choice for when they do.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="noticePeriodDays">
            Notice period (days)
          </label>
          <input id="noticePeriodDays" className="input" inputMode="numeric" value={v.noticePeriodDays} onChange={(e) => set('noticePeriodDays', e.target.value.replace(/[^\d]/g, ''))} />
        </div>
        <div>
          <label className="label" htmlFor="availableFrom">
            Available from
          </label>
          <input id="availableFrom" type="date" className="input" value={v.availableFrom} onChange={(e) => set('availableFrom', e.target.value)} />
        </div>
      </div>
      <Status saving={saving} saved={saved} error={error} />
      </Card>
    </form>
  );
}

const STATUS_LABELS: Record<string, string> = {
  unspecified: 'Prefer not to say yet',
  citizen: 'Citizen',
  permanent_resident: 'Permanent resident',
  work_permit: 'Work permit',
  study_permit: 'Study permit',
  requires_sponsorship: 'Require sponsorship',
  other: 'Other',
};

export function WorkAuthorizationForm({ initial }: { initial: WorkAuthorizationValues }) {
  const [v, setV] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof WorkAuthorizationValues>(k: K, value: WorkAuthorizationValues[K]) => {
    setV((p) => ({ ...p, [k]: value }));
    setSaved(false);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/profile/work-authorization', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: v.country,
          status: v.status,
          permitType: v.permitType || null,
          permitExpiresAt: v.permitExpiresAt || null,
          sponsorshipNeeded: v.sponsorshipNeeded,
          notes: v.notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Could not save.');
      else setSaved(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} aria-labelledby="workauth-heading">
      <Card className="mt-6 max-w-2xl p-6">
      <h2 id="workauth-heading" className="font-semibold text-ink">
        Work authorization
      </h2>
      <p className="mt-1 text-sm text-muted">
        Used only to check eligibility for postings. Access to this is recorded.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="wa-country">
            Country
          </label>
          <select id="wa-country" className="input" value={v.country} onChange={(e) => set('country', e.target.value as 'CA' | 'US')}>
            <option value="CA">Canada</option>
            <option value="US">United States</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="wa-status">
            Status
          </label>
          <select id="wa-status" className="input" value={v.status} onChange={(e) => set('status', e.target.value)}>
            {Object.entries(STATUS_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="wa-permitType">
            Permit type (if any)
          </label>
          <input id="wa-permitType" className="input" value={v.permitType} onChange={(e) => set('permitType', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="wa-expires">
            Permit expiry
          </label>
          <input id="wa-expires" type="date" className="input" value={v.permitExpiresAt} onChange={(e) => set('permitExpiresAt', e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
          <input type="checkbox" checked={v.sponsorshipNeeded} onChange={(e) => set('sponsorshipNeeded', e.target.checked)} />
          I would need employer sponsorship
        </label>
      </div>
      <Status saving={saving} saved={saved} error={error} />
      </Card>
    </form>
  );
}

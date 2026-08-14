'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

export interface ProfileValues {
  fullName: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  headline: string;
  linkedinUrl: string;
  portfolioUrl: string;
  workAuth: string;
}

const WORK_AUTH_CA = [
  'Canadian Citizen',
  'Permanent Resident',
  'Open Work Permit',
  'Closed Work Permit',
  'Require Sponsorship',
];

const WORK_AUTH_US = [
  'US Citizen',
  'Green Card Holder',
  'H-1B',
  'TN Visa',
  'Require Sponsorship',
];

export function SettingsForm({ initial }: { initial: ProfileValues }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ProfileValues>(key: K, value: ProfileValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Could not save your profile.');
        setSaving(false);
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const workAuthOptions = values.country === 'US' ? WORK_AUTH_US : WORK_AUTH_CA;

  return (
    <form onSubmit={save} className="max-w-2xl space-y-5">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Card className="space-y-4 p-6">
        <h2 className="font-semibold text-ink">Profile</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="fullName">
              Full name
            </label>
            <input
              id="fullName"
              value={values.fullName}
              onChange={(e) => set('fullName', e.target.value)}
              required
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input id="email" value={values.email} disabled className="input opacity-60" />
          </div>
          <div>
            <label className="label" htmlFor="phone">
              Phone
            </label>
            <input
              id="phone"
              value={values.phone}
              onChange={(e) => set('phone', e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="headline">
              Professional headline
            </label>
            <input
              id="headline"
              value={values.headline}
              onChange={(e) => set('headline', e.target.value)}
              placeholder="Senior Data Analyst"
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="country">
              Country
            </label>
            <select
              id="country"
              value={values.country}
              onChange={(e) => set('country', e.target.value)}
              className="input"
            >
              <option value="CA">Canada</option>
              <option value="US">United States</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="city">
              City
            </label>
            <input
              id="city"
              value={values.city}
              onChange={(e) => set('city', e.target.value)}
              placeholder="Toronto, ON"
              className="input"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="workAuth">
              Work authorization
            </label>
            <select
              id="workAuth"
              value={values.workAuth}
              onChange={(e) => set('workAuth', e.target.value)}
              className="input"
            >
              <option value="">Prefer not to say</option>
              {workAuthOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-faint">
              Many postings ask about this. Setting it lets applications be completed accurately.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="linkedinUrl">
              LinkedIn
            </label>
            <input
              id="linkedinUrl"
              value={values.linkedinUrl}
              onChange={(e) => set('linkedinUrl', e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="portfolioUrl">
              Portfolio / website
            </label>
            <input
              id="portfolioUrl"
              value={values.portfolioUrl}
              onChange={(e) => set('portfolioUrl', e.target.value)}
              className="input"
            />
          </div>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save changes
        </button>
        {saved && (
          <span role="status" className="flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" />
            Saved
          </span>
        )}
      </div>
    </form>
  );
}

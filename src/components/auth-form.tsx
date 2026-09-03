'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';

export function AuthForm({
  mode,
  plan,
  interval,
  prefillDemo,
}: {
  mode: 'login' | 'signup';
  plan?: string;
  interval?: string;
  prefillDemo?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());

    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, plan, interval }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Something went wrong. Please try again.');
        setLoading(false);
        return;
      }

      // Send new users through onboarding; returning users to the dashboard.
      router.push(data.redirect ?? '/dashboard');
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {mode === 'signup' && (
        <div>
          <label className="label" htmlFor="fullName">
            Full name
          </label>
          <input
            id="fullName"
            name="fullName"
            type="text"
            required
            autoComplete="name"
            className="input"
            placeholder="Alex Morgan"
          />
        </div>
      )}

      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="input"
          placeholder="you@example.com"
          defaultValue={prefillDemo ? 'demo@jobpilot.ai' : undefined}
        />
      </div>

      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          className="input"
          placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
          defaultValue={prefillDemo ? 'demo1234' : undefined}
        />
      </div>

      {mode === 'signup' && (
        <div>
          <label className="label" htmlFor="country">
            Where are you job hunting?
          </label>
          <select id="country" name="country" className="input" defaultValue="CA">
            <option value="CA">Canada</option>
            <option value="US">United States</option>
          </select>
        </div>
      )}

      {mode === 'signup' && (
        <div className="flex items-start gap-3">
          <input
            id="acceptTerms"
            name="acceptTerms"
            type="checkbox"
            required
            aria-describedby="acceptTerms-help"
            className="mt-1 h-4 w-4 shrink-0 rounded border-line text-brand-500 focus:ring-brand-500"
          />
          <label htmlFor="acceptTerms" className="text-sm text-ink">
            I agree to the{' '}
            <a href="/terms" className="font-semibold text-brand-500 hover:text-brand-600" target="_blank" rel="noopener">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="/privacy" className="font-semibold text-brand-500 hover:text-brand-600" target="_blank" rel="noopener">
              Privacy Policy
            </a>
            <span id="acceptTerms-help" className="mt-0.5 block text-xs text-muted">
              Required. We record the version you agreed to and when.
            </span>
          </label>
        </div>
      )}

      <button type="submit" disabled={loading} className="btn-primary w-full py-3">
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
    </form>
  );
}

'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Stage 20 (ADR-0035): the enterprise entry point on the login page. The
 * address is only used to find the organisation's connection; the provider
 * does the authenticating. The platform's terms and privacy policy apply to
 * an account created at first sign-in, and the page says so before the
 * redirect - that statement is the consent the sign-in records.
 */
/** The callback sends a CODE, never text; the wording lives here (review L2). */
const MESSAGES: Record<string, string> = {
  provider: 'The identity provider did not complete the sign-in. Try again, or contact your administrator.',
  expired: 'This sign-in has expired. Start again.',
  refused: 'Your organisation\'s sign-in was refused for this account. Your administrator can see why in the audit log.',
  unavailable: 'Organisation sign-in is not available on this deployment yet.',
};

export function SsoSignIn({ message }: { message?: string }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(message ? (MESSAGES[message] ?? MESSAGES.refused!) : null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sso/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not start the sign-in.');
        return;
      }
      window.location.assign(data.redirect as string);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={start} className="mt-6 space-y-2 border-t border-line pt-6">
      <p className="text-xs font-semibold text-ink">Sign in with your organisation</p>
      <p className="text-xs text-muted">Your work email is used to find your organisation&rsquo;s single sign-on. By continuing you accept the Terms of Service and Privacy Policy for an account created in your name.</p>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex gap-2">
        <input type="email" required autoComplete="email" placeholder="you@company.com" className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit" className="btn-secondary text-sm" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Continue'}
        </button>
      </div>
    </form>
  );
}

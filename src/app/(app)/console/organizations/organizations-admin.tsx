'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface OrganizationRowView {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  verifiedAt: string | null;
  verifiedByEmail: string;
  members: number;
  requireSso: boolean;
  allowedEmailDomains: string[];
  sessionMaxHours: number | null;
  sso: { status: string; emailDomain: string } | null;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = { active: 'bg-success/10 text-success', suspended: 'bg-danger/10 text-danger', past_due: 'bg-warning/10 text-warning', canceled: 'bg-warning/10 text-warning' };

export function OrganizationsAdmin({ canChange, query, organizations }: { canChange: boolean; query: string; organizations: OrganizationRowView[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', type: 'employer', ownerEmail: '', billingEmail: '', reason: '', currentPassword: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/console/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, billingEmail: form.billingEmail || undefined }) });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'Could not create the organisation.' });
        return;
      }
      setMessage({ ok: true, text: `${data.organization.name} created and verified.` });
      setForm({ name: '', type: 'employer', ownerEmail: '', billingEmail: '', reason: '', currentPassword: '' });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form method="get" className="flex gap-2">
        <input name="q" defaultValue={query} placeholder="Search by name or slug" className="w-72 rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <button type="submit" className="btn-secondary text-sm">
          Search
        </button>
      </form>
      {message ? <p className={cn('text-sm', message.ok ? 'text-success' : 'text-danger')}>{message.text}</p> : null}
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Organisation</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Verified</th>
              <th className="px-4 py-3">Members</th>
              <th className="px-4 py-3">Policy</th>
              <th className="px-4 py-3">SSO</th>
            </tr>
          </thead>
          <tbody>
            {organizations.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-muted">
                  No organisations yet.
                </td>
              </tr>
            ) : null}
            {organizations.map((o) => (
              <tr key={o.id} className="border-t border-line">
                <td className="px-4 py-2">
                  <Link href={`/console/organizations/${o.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                    {o.name}
                  </Link>
                  <span className="ml-2 text-xs text-muted">{o.slug}</span>
                </td>
                <td className="px-4 py-2 text-muted">{o.type}</td>
                <td className="px-4 py-2">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', STATUS_TONE[o.status] ?? 'bg-surface text-muted')}>{o.status}</span>
                </td>
                <td className="px-4 py-2 text-xs text-muted">{o.verifiedAt ? `${o.verifiedByEmail} · ${new Date(o.verifiedAt).toLocaleDateString('en-CA')}` : 'not verified'}</td>
                <td className="px-4 py-2 text-muted">{o.members}</td>
                <td className="px-4 py-2 text-xs text-muted">
                  {o.requireSso ? 'SSO required · ' : ''}
                  {o.allowedEmailDomains.length ? `domains: ${o.allowedEmailDomains.join(', ')} · ` : ''}
                  {o.sessionMaxHours ? `sessions ≤ ${o.sessionMaxHours}h` : 'platform session'}
                </td>
                <td className="px-4 py-2 text-xs text-muted">{o.sso ? `${o.sso.status} (${o.sso.emailDomain})` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {canChange ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Create a verified organisation</h2>
          <p className="mt-1 text-sm text-muted">For an account that already exists (the owner). Say in the reason what was verified and how - the business registration, the domain, the signed agreement. Re-authenticated and audited.</p>
          <form onSubmit={create} className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col text-sm">
              <span className="text-muted">Name</span>
              <input required minLength={2} className="rounded-md border border-line bg-surface px-3 py-2" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Type</span>
              <select className="rounded-md border border-line bg-surface px-3 py-2" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="employer">employer</option>
                <option value="service_provider">service_provider</option>
                <option value="staffing_agency">staffing_agency</option>
              </select>
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Owner account email</span>
              <input type="email" required className="rounded-md border border-line bg-surface px-3 py-2" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Billing email (defaults to the owner)</span>
              <input type="email" className="rounded-md border border-line bg-surface px-3 py-2" value={form.billingEmail} onChange={(e) => setForm({ ...form, billingEmail: e.target.value })} />
            </label>
            <label className="flex flex-col text-sm md:col-span-2">
              <span className="text-muted">Reason (what was verified, and how)</span>
              <input required minLength={3} className="rounded-md border border-line bg-surface px-3 py-2" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </label>
            <label className="flex flex-col text-sm md:col-span-2">
              <span className="text-muted">Your current password</span>
              <input type="password" required autoComplete="current-password" className="rounded-md border border-line bg-surface px-3 py-2" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
            </label>
            <div className="md:col-span-2">
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create verified organisation'}
              </button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

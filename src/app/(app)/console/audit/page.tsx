import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { queryAuditLog } from '@/lib/admin/audit';
import { isFlagEnabled } from '@/lib/admin/feature-flags';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';

export const metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

/** /console/audit - the append-only security and governance log, filtered; CSV export (itself audited) when the flag allows. Admin only. */
export default async function ConsoleAuditPage({ searchParams }: { searchParams: Promise<{ action?: string; entityType?: string; entityId?: string; actorEmail?: string; from?: string; to?: string; cursor?: string }> }) {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;
  const p = await searchParams;
  const date = (v?: string) => (v && !Number.isNaN(new Date(v).getTime()) ? new Date(v) : undefined);
  const { rows, nextCursor } = await queryAuditLog({ action: p.action, entityType: p.entityType, entityId: p.entityId, actorEmail: p.actorEmail, from: date(p.from), to: date(p.to), cursor: p.cursor, take: 100 });
  const exportAllowed = await isFlagEnabled('console.report_export', gate.staff.id);
  const qs = new URLSearchParams(Object.entries(p).filter(([k, v]) => v && k !== 'cursor') as [string, string][]);
  return (
    <>
      <PageHeader title="Audit log" description="Append-only. Every staff change, every consent, every sensitive read, every sign-in outcome. Rows carry ids, kinds and reasons - never a secret, a token, a body or a note; a failed sign-in names only a digest, while a row a person acted on carries their address as its actor. An export is itself an audit row." />
      <form method="get" className="mb-4 grid gap-2 md:grid-cols-6">
        <input name="action" defaultValue={p.action ?? ''} placeholder="action prefix (e.g. staffing.)" className="rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <input name="entityType" defaultValue={p.entityType ?? ''} placeholder="entity type" className="rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <input name="entityId" defaultValue={p.entityId ?? ''} placeholder="entity id" className="rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <input name="actorEmail" defaultValue={p.actorEmail ?? ''} placeholder="actor email" className="rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <input name="from" type="date" defaultValue={p.from ?? ''} className="rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <input name="to" type="date" defaultValue={p.to ?? ''} className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm" />
          <button type="submit" className="btn-secondary text-sm">
            Filter
          </button>
        </div>
      </form>
      <p className="mb-2 text-xs text-muted">
        {exportAllowed ? (
          <a href={`/api/console/audit/export?${qs.toString()}`} className="font-medium text-brand-500 hover:text-brand-600">
            Export these rows as CSV (up to 1000)
          </a>
        ) : (
          'CSV export is switched off (feature flag console.report_export).'
        )}
      </p>
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Entity</th>
              <th className="px-4 py-3">Summary</th>
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted">
                  No rows match.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-muted">{r.createdAt.toLocaleString('en-CA')}</td>
                <td className="px-4 py-2 text-xs text-muted">
                  {r.actorType}
                  {r.actorEmail ? ` · ${r.actorEmail}` : ''}
                  {r.actorRole ? ` (${r.actorRole})` : ''}
                </td>
                <td className="px-4 py-2">
                  <code className="text-xs">{r.action}</code>
                </td>
                <td className="px-4 py-2 text-xs text-muted">
                  {r.entityType} <span className="break-all">{r.entityId}</span>
                </td>
                <td className="px-4 py-2 text-ink">{r.summary}</td>
                <td className="px-4 py-2 text-xs text-muted">{r.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {nextCursor ? (
        <p className="mt-3 text-sm">
          <Link href={`/console/audit?${new URLSearchParams({ ...Object.fromEntries(qs), cursor: nextCursor }).toString()}`} className="font-medium text-brand-500 hover:text-brand-600">
            Older rows
          </Link>
        </p>
      ) : null}
    </>
  );
}

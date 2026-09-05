import { fail } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { exportAuditLog } from '@/lib/admin/audit';
import { isFlagEnabled } from '@/lib/admin/feature-flags';

/** GET /api/console/audit/export?action=&entityType=&entityId=&actorEmail=&from=&to= - up to 1000 rows as CSV; the export is itself audited. Admin; gated by the `console.audit_export` flag. */
export const GET = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  if (!(await isFlagEnabled('console.audit_export', staff.id))) return fail('Audit export is switched off.', 403);
  const q = new URL(request.url).searchParams;
  const date = (v: string | null) => (v ? new Date(v) : undefined);
  const from = date(q.get('from'));
  const to = date(q.get('to'));
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) return fail('from and to are dates.', 422);
  const { csv } = await exportAuditLog(staff, { action: q.get('action') ?? undefined, entityType: q.get('entityType') ?? undefined, entityId: q.get('entityId') ?? undefined, actorEmail: q.get('actorEmail') ?? undefined, from, to }, requestMeta(request));
  return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' } });
});

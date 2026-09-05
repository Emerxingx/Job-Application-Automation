import { db } from '@/lib/db';
import type { StaffContext } from '@/lib/crm/auth';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';

/**
 * Stage 20 (ADR-0035) - the audit viewer and its export. The log is
 * append-only and system-only; staff read it filtered, and an export is
 * itself an audited event. The CSV carries ids, actions, summaries and
 * reasons - the columns the writer already redacted - and never the IP or
 * user-agent columns, which are personal data kept for incident response and
 * read in place.
 */
export interface AuditQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorEmail?: string;
  from?: Date;
  to?: Date;
  take?: number;
  cursor?: string;
}

export async function queryAuditLog(q: AuditQuery) {
  const take = Math.min(Math.max(q.take ?? 100, 1), 1000);
  const where = {
    ...(q.action ? { action: { startsWith: q.action.trim() } } : {}),
    ...(q.entityType ? { entityType: q.entityType.trim() } : {}),
    ...(q.entityId ? { entityId: q.entityId.trim() } : {}),
    ...(q.actorEmail ? { actorEmail: q.actorEmail.trim().toLowerCase() } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
  const rows = await db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), select: { id: true, createdAt: true, actorType: true, actorEmail: true, actorRole: true, action: true, entityType: true, entityId: true, summary: true, reason: true, after: true } });
  const next = rows.length > take ? rows[take]!.id : null;
  return { rows: rows.slice(0, take), nextCursor: next };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // A cell beginning with = + - @ is neutralised so a spreadsheet never executes it.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function auditCsv(rows: { id: string; createdAt: Date; actorType: string; actorEmail: string; actorRole: string; action: string; entityType: string; entityId: string; summary: string; reason: string | null }[]): string {
  const header = ['id', 'createdAt', 'actorType', 'actorEmail', 'actorRole', 'action', 'entityType', 'entityId', 'summary', 'reason'];
  const lines = rows.map((r) => [r.id, r.createdAt, r.actorType, r.actorEmail, r.actorRole, r.action, r.entityType, r.entityId, r.summary, r.reason].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

export async function exportAuditLog(staff: StaffContext, q: AuditQuery, meta?: RequestMeta): Promise<{ csv: string; count: number }> {
  const { rows } = await queryAuditLog({ ...q, take: 1000, cursor: undefined });
  await recordSecurityEvent(
    { event: 'audit.exported', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'AuditLog', entityId: 'export', summary: `Audit log exported (${rows.length} rows)`, detail: { count: rows.length, action: q.action ?? null, entityType: q.entityType ?? null, entityId: q.entityId ?? null, from: q.from?.toISOString() ?? null, to: q.to?.toISOString() ?? null }, meta },
    db,
    { strict: true },
  );
  return { csv: auditCsv(rows), count: rows.length };
}

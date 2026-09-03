import { BUILTIN_FIELD_MAPPINGS, BUILTIN_FIELD_MAPPING_VERSION, getActiveFieldMappings, listFieldMappingVersions } from '@/lib/apply/field-mappings';
import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { FieldMappingAdmin, type MappingAuditView, type MappingVersionView } from './field-mapping-admin';

export const metadata = { title: 'Field mappings' };
export const dynamic = 'force-dynamic';

/** /console/field-mappings — the governed field-mapping register (Stage 12, ADR-0019 Tier 1). Admin only. */
export default async function ConsoleFieldMappingsPage() {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;
  const [versions, active, audit] = await Promise.all([
    listFieldMappingVersions(),
    getActiveFieldMappings(),
    db.auditLog.findMany({ where: { entityType: 'FieldMappingVersion' }, orderBy: { createdAt: 'desc' }, take: 40, select: { id: true, action: true, summary: true, actorEmail: true, reason: true, createdAt: true } }),
  ]);
  const view: MappingVersionView[] = versions.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    mappings: v.mappings,
    notes: v.notes,
    createdByEmail: v.createdByEmail,
    approvedByEmail: v.approvedByEmail,
    updatedAt: v.updatedAt.toISOString(),
  }));
  const auditView: MappingAuditView[] = audit.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actorEmail: a.actorEmail, reason: a.reason, createdAt: a.createdAt.toISOString() }));
  return (
    <>
      <PageHeader
        title="Field mappings"
        description="How the free-text questions employer forms ask map onto canonical profile keys, so the same fact is answered the same way on every form. These rules decide what is placed into an employer's form: a version is written as a draft, approved by a second admin, then activated — one active version, and activating an older approved version is the rollback. Every application records the version it was prepared with. Until a version is active, the built-in set applies and is recorded as such. A fallback rule is a note to the applicant; it may never tell anyone to invent an answer."
      />
      <FieldMappingAdmin versions={view} active={{ version: active.version, mappings: JSON.stringify(active.mappings, null, 2) }} builtin={{ version: BUILTIN_FIELD_MAPPING_VERSION, mappings: JSON.stringify(BUILTIN_FIELD_MAPPINGS, null, 2) }} audit={auditView} />
    </>
  );
}

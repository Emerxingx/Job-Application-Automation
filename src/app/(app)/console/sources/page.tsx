import { db } from '@/lib/db';
import { ensureSourceRegistry, missingCredentials, recordComplete } from '@/lib/connectors/registry';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { SourcesAdmin, type SourceRunView, type SourceView } from './sources-admin';

export const metadata = { title: 'Job sources' };
export const dynamic = 'force-dynamic';

/**
 * /console/sources — the connector register (ADR-0008): every source, its
 * per-connector policy record, health, and recent runs. Admin only.
 */
export default async function ConsoleSourcesPage() {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;
  const [sources, runs] = await Promise.all([ensureSourceRegistry(), db.jobSourceRun.findMany({ orderBy: { startedAt: 'desc' }, take: 40, include: { source: { select: { key: true } } } })]);
  const view: SourceView[] = sources.map((s) => ({
    key: s.key,
    name: s.name,
    kind: s.kind,
    priority: s.priority,
    status: s.status,
    legalBasis: s.legalBasis,
    termsReviewedAt: s.termsReviewedAt?.toISOString() ?? null,
    termsReviewedByEmail: s.termsReviewedByEmail,
    robotsPosition: s.robotsPosition,
    rateLimitPerMinute: s.rateLimitPerMinute,
    attributionRequired: s.attributionRequired,
    attributionText: s.attributionText,
    dataCategories: s.dataCategories,
    personalData: s.personalData,
    retentionRef: s.retentionRef,
    approvedAt: s.approvedAt?.toISOString() ?? null,
    approvedByEmail: s.approvedByEmail,
    credentialEnvVars: s.credentialEnvVars,
    missingCredentials: missingCredentials(s),
    recordComplete: recordComplete(s),
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
    lastHealthAt: s.lastHealthAt?.toISOString() ?? null,
    lastHealthStatus: s.lastHealthStatus,
    lastError: s.lastError,
    errorCount: s.errorCount,
    notes: s.notes,
  }));
  const runView: SourceRunView[] = runs.map((r) => ({
    id: r.id,
    sourceKey: r.source.key,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    discovered: r.discovered,
    created: r.created,
    updated: r.updated,
    closed: r.closed,
    rejected: r.rejected,
    error: r.error,
  }));
  return (
    <>
      <PageHeader
        title="Job sources"
        description="Every connector, its per-connector record (legal basis, terms review, robots position, rate limit, attribution, data categories, retention, approval), its health and its recent runs. A connector runs only while it is enabled, its record is complete and its credentials are present — enabling it here is the approval SOURCE_ACCESS_POLICY.md requires, re-authenticated and audited."
      />
      <SourcesAdmin sources={view} runs={runView} />
    </>
  );
}

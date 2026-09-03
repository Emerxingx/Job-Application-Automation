import { db } from '@/lib/db';
import { ensureDatasetRegistry } from '@/lib/taxonomy/datasets';
import { completeness } from '@/lib/taxonomy/queries';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { TaxonomyAdmin, type DatasetView } from './taxonomy-admin';

export const metadata = { title: 'Taxonomy' };
export const dynamic = 'force-dynamic';

/**
 * /console/taxonomy — the occupational spine's datasets and their licence
 * state (the L-2 gate), with the integrity report. Admin only.
 */
export default async function ConsoleTaxonomyPage() {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;

  const [datasets, report] = await Promise.all([ensureDatasetRegistry(), completeness(db)]);
  const view: DatasetView[] = datasets.map((d) => ({
    key: d.key,
    name: d.name,
    publisher: d.publisher,
    scheme: d.scheme,
    version: d.version,
    sourceUrl: d.sourceUrl,
    licenceName: d.licenceName,
    licenceUrl: d.licenceUrl,
    attribution: d.attribution,
    publisherTerms: d.publisherTerms,
    licenceStatus: d.licenceStatus,
    licenceRecordedByEmail: d.licenceRecordedByEmail,
    licenceRecordedAt: d.licenceRecordedAt?.toISOString() ?? null,
    ingestionApproved: d.ingestionApproved,
    ingestedAt: d.ingestedAt?.toISOString() ?? null,
    rowCount: d.rowCount,
    notes: d.notes,
  }));

  return (
    <>
      <PageHeader
        title="Occupational taxonomy"
        description="Datasets that may feed the occupation and skills spine, and whether their licence has been recorded. Nothing is ingested until a licence and its attribution are recorded here by an admin and ingestion is approved (SOURCE_ACCESS_POLICY.md, L-2)."
      />
      <TaxonomyAdmin datasets={view} report={report} />
    </>
  );
}

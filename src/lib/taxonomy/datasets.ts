import type { Prisma, TaxonomyDataset } from '@prisma/client';
import { db } from '../db';
import type { StaffContext } from '../crm/auth';

/**
 * The licence gate (ADR-0009, SOURCE_ACCESS_POLICY.md § Taxonomy licensing,
 * COMPLIANCE_REGISTER L-2).
 *
 * Every dataset that can feed the occupational spine is registered here with
 * its publisher, version and — once counsel has confirmed the terms — its
 * licence, attribution text and an explicit ingestion approval recorded by
 * name and audited. `requireIngestible()` is the only way a loader obtains a
 * dataset to write under, and it refuses anything not `recorded` + approved.
 * A dataset counsel rules out is marked `prohibited` and can never be loaded.
 *
 * The registry below is what is KNOWN about each dataset's public terms,
 * written down so the review has something to confirm or correct. None of
 * it is a recorded licence: `licenceStatus` starts `unrecorded` for every
 * real dataset, and stays so until a person records it. Only the test
 * fixture (a dozen hand-written rows, attributed) is approvable by tests.
 */

export type DatasetKey = 'noc-2021' | 'soc-2018' | 'oasis' | 'csct' | 'onet' | 'fixture';

export interface DatasetDefinition {
  key: DatasetKey;
  name: string;
  publisher: string;
  scheme: 'NOC2021' | 'SOC2018' | 'OASIS' | 'CSCT' | 'ONET' | 'FIXTURE';
  version: string;
  sourceUrl: string;
  /** What the publisher states publicly. To be confirmed by counsel (L-2). */
  knownTerms: string;
}

export const DATASET_DEFINITIONS: readonly DatasetDefinition[] = [
  {
    key: 'noc-2021',
    name: 'National Occupational Classification (NOC) 2021 Version 1.0',
    publisher: 'Statistics Canada / Employment and Social Development Canada',
    scheme: 'NOC2021',
    version: '2021 V1.0',
    sourceUrl: 'https://www.statcan.gc.ca/en/subjects/standard/noc/2021/indexV1',
    knownTerms: 'Published under the Open Government Licence – Canada, which permits copying, modification and redistribution with attribution. Confirmation of commercial redistribution and the exact attribution wording is L-2.',
  },
  {
    key: 'soc-2018',
    name: 'Standard Occupational Classification (SOC) 2018',
    publisher: 'U.S. Bureau of Labor Statistics',
    scheme: 'SOC2018',
    version: '2018',
    sourceUrl: 'https://www.bls.gov/soc/2018/',
    knownTerms: 'U.S. federal government work, public domain in the United States. Confirmation for use in a Canadian commercial product is L-2.',
  },
  {
    key: 'oasis',
    name: 'Occupational and Skills Information System (OaSIS)',
    publisher: 'Employment and Social Development Canada',
    scheme: 'OASIS',
    version: 'unversioned',
    sourceUrl: 'https://noc.esdc.gc.ca/Oasis/OasisWelcome',
    knownTerms: 'Government of Canada content; licence to be confirmed (L-2). Not ingested.',
  },
  {
    key: 'csct',
    name: 'Canadian Skills and Competencies Taxonomy',
    publisher: 'Employment and Social Development Canada',
    scheme: 'CSCT',
    version: 'unversioned',
    sourceUrl: 'https://noc.esdc.gc.ca/SkillsTaxonomy/SkillsTaxonomyWelcome',
    knownTerms: 'Government of Canada content; licence to be confirmed (L-2). Not ingested.',
  },
  {
    key: 'onet',
    name: 'O*NET Database',
    publisher: 'U.S. Department of Labor / National Center for O*NET Development',
    scheme: 'ONET',
    version: 'unversioned',
    sourceUrl: 'https://www.onetcenter.org/database.html',
    knownTerms: 'Published under a Creative Commons Attribution 4.0 licence with a required attribution statement. Confirmation and wording are L-2. Not ingested.',
  },
  {
    key: 'fixture',
    name: 'Hand-written test fixture (a dozen occupations)',
    publisher: 'This repository',
    scheme: 'FIXTURE',
    version: 'test',
    sourceUrl: '',
    knownTerms: 'Authored for tests; codes and titles follow the NOC 2021 / SOC 2018 structure and are attributed to their publishers in the file. Never loaded outside a test database.',
  },
];

export class TaxonomyLicenceError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'TaxonomyLicenceError';
  }
}

type Client = Prisma.TransactionClient | typeof db;

/** Ensure every known dataset has a row (unrecorded until someone records it). Idempotent. */
export async function ensureDatasetRegistry(client: Client = db): Promise<TaxonomyDataset[]> {
  const rows: TaxonomyDataset[] = [];
  for (const d of DATASET_DEFINITIONS) {
    rows.push(
      await client.taxonomyDataset.upsert({
        where: { key: d.key },
        create: { key: d.key, name: d.name, publisher: d.publisher, scheme: d.scheme, version: d.version, sourceUrl: d.sourceUrl, notes: d.knownTerms },
        update: {},
      }),
    );
  }
  return rows;
}

export interface LicenceRecord {
  licenceName: string;
  licenceUrl?: string;
  attribution: string;
  /** `prohibited` records a counsel decision that the dataset may not be used. */
  status: 'recorded' | 'prohibited';
  ingestionApproved: boolean;
  notes?: string;
}

/**
 * Record a dataset's licence and whether it may be ingested. A governance
 * action: admin-only at the route, and audited here with who and why.
 */
export async function recordDatasetLicence(key: string, record: LicenceRecord, actor: StaffContext, reason: string): Promise<TaxonomyDataset> {
  if (record.status === 'recorded' && (!record.licenceName.trim() || !record.attribution.trim())) {
    throw new TaxonomyLicenceError('A recorded licence needs its name and the attribution text the product must display.');
  }
  if (!reason.trim()) throw new TaxonomyLicenceError('A reason is required: name the review or the counsel advice this records.');
  return db.$transaction(async (tx) => {
    const before = await tx.taxonomyDataset.findUnique({ where: { key } });
    if (!before) throw new TaxonomyLicenceError('Unknown dataset.');
    const after = await tx.taxonomyDataset.update({
      where: { key },
      data: {
        licenceName: record.licenceName.trim(),
        licenceUrl: record.licenceUrl?.trim() ?? '',
        attribution: record.attribution.trim(),
        licenceStatus: record.status,
        ingestionApproved: record.status === 'recorded' && record.ingestionApproved,
        licenceRecordedAt: new Date(),
        licenceRecordedById: actor.id,
        licenceRecordedByEmail: actor.email,
        ...(record.notes !== undefined ? { notes: record.notes } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actorType: 'staff',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: 'taxonomy.licence.recorded',
        entityType: 'TaxonomyDataset',
        entityId: after.id,
        summary: `${record.status === 'prohibited' ? 'Prohibited' : 'Recorded licence for'} ${after.name}${after.ingestionApproved ? ' (ingestion approved)' : ''}.`,
        before: JSON.stringify({ licenceStatus: before.licenceStatus, ingestionApproved: before.ingestionApproved, licenceName: before.licenceName }),
        after: JSON.stringify({ licenceStatus: after.licenceStatus, ingestionApproved: after.ingestionApproved, licenceName: after.licenceName, attribution: after.attribution }),
        changedFields: JSON.stringify(['licenceStatus', 'ingestionApproved', 'licenceName', 'attribution']),
        reason,
      },
    });
    return after;
  });
}

/** The only way a loader gets a dataset to write under. */
export async function requireIngestible(client: Client, key: string): Promise<TaxonomyDataset> {
  const dataset = await client.taxonomyDataset.findUnique({ where: { key } });
  if (!dataset) throw new TaxonomyLicenceError(`Dataset "${key}" is not registered.`);
  if (dataset.licenceStatus === 'prohibited') throw new TaxonomyLicenceError(`Dataset "${key}" may not be used: counsel recorded it as prohibited.`);
  if (dataset.licenceStatus !== 'recorded' || !dataset.ingestionApproved) {
    throw new TaxonomyLicenceError(`Dataset "${key}" cannot be ingested: its licence has not been recorded and approved (SOURCE_ACCESS_POLICY.md, L-2).`);
  }
  return dataset;
}

/** Attribution lines the product must show for the datasets currently loaded. */
export async function loadedAttributions(client: Client = db): Promise<{ key: string; attribution: string }[]> {
  const rows = await client.taxonomyDataset.findMany({ where: { ingestedAt: { not: null }, attribution: { not: '' } }, select: { key: true, attribution: true }, orderBy: { key: 'asc' } });
  return rows;
}

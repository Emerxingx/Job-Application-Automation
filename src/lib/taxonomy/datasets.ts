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
 * real dataset, and stays so until a person records it. The text is synced
 * to `publisherTerms` on every upsert and shown in the console labelled as
 * the publisher's unconfirmed statement. Only the test fixture (seventeen
 * hand-written rows, attributed) is approvable by tests.
 *
 * THE GATE COVERS WHAT IS ALREADY LOADED. Recording `prohibited`, or
 * recording a licence without ingestion approval, on a dataset that has
 * rows PURGES them in the same transaction: every Occupation the dataset
 * introduced (labels, codes and skill links cascade; jobs lose the link)
 * and every code row it attached. A counsel decision that the data may not
 * be used cannot leave the data serving. Loads are single transactions, so
 * a partial state never exists to be read. (The register itself is
 * system-only, so the tenant path cannot filter on it — the purge is the
 * control, not a read-time check.)
 */

export type DatasetKey = 'noc-2021' | 'soc-2018' | 'oasis' | 'csct' | 'onet' | 'fixture' | 'esdc-regulated-occupations' | 'cicic-programs' | 'learning-fixture';

export interface DatasetDefinition {
  key: DatasetKey;
  name: string;
  publisher: string;
  scheme: 'NOC2021' | 'SOC2018' | 'OASIS' | 'CSCT' | 'ONET' | 'FIXTURE' | 'LEARNING';
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
  // Stage 16 (ADR-0031): the learning and credential graph is licensed content too.
  {
    key: 'esdc-regulated-occupations',
    name: 'Job Bank - regulated occupations and certification requirements by province and territory',
    publisher: 'Employment and Social Development Canada (Job Bank)',
    scheme: 'LEARNING',
    version: '2026',
    sourceUrl: 'https://www.jobbank.gc.ca/',
    knownTerms: 'Job Bank content is Government of Canada material; the terms under which regulated-occupation requirements may be redistributed in a commercial product, and the attribution wording, are to be confirmed by counsel (L-2). Nothing is loaded until recorded.',
  },
  {
    key: 'cicic-programs',
    name: 'CICIC directory of educational institutions and programs in Canada',
    publisher: 'Canadian Information Centre for International Credentials (CMEC)',
    scheme: 'LEARNING',
    version: '2026',
    sourceUrl: 'https://www.cicic.ca/',
    knownTerms: 'The CICIC directory is published for public information; redistribution and the recognition claims it carries need counsel review (L-2) before any row is loaded. Nothing is loaded until recorded.',
  },
  {
    key: 'learning-fixture',
    name: 'Hand-written learning-graph fixture (credentials, providers, offerings)',
    publisher: 'This repository',
    scheme: 'LEARNING',
    version: 'test',
    sourceUrl: '',
    knownTerms: 'Authored for tests against the occupation fixture; every recognition value is what the file states. Never loaded outside a test database.',
  },
];

export class TaxonomyLicenceError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'TaxonomyLicenceError';
    this.status = status;
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
        create: { key: d.key, name: d.name, publisher: d.publisher, scheme: d.scheme, version: d.version, sourceUrl: d.sourceUrl, publisherTerms: d.knownTerms },
        // Descriptive fields follow the code; governance fields (licence,
        // approval, notes) are a person's record and are never touched here.
        update: { name: d.name, publisher: d.publisher, scheme: d.scheme, version: d.version, sourceUrl: d.sourceUrl, publisherTerms: d.knownTerms },
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

export interface LicenceDecision {
  dataset: TaxonomyDataset;
  /** Rows removed because the decision withdrew the right to serve them. */
  purged: { occupations: number; codes: number };
}

function snapshot(d: TaxonomyDataset) {
  return {
    licenceStatus: d.licenceStatus,
    ingestionApproved: d.ingestionApproved,
    licenceName: d.licenceName,
    licenceUrl: d.licenceUrl,
    attribution: d.attribution,
    notes: d.notes,
    rowCount: d.rowCount,
    ingestedAt: d.ingestedAt?.toISOString() ?? null,
  };
}

/**
 * Purge everything a dataset put into the spine. Occupations it introduced
 * cascade to their labels, codes, skill links and paths; jobs lose the link
 * (SET NULL). Codes it merely attached to other datasets' occupations (a SOC
 * crosswalk) are removed by scheme + version.
 */
async function purgeDataset(tx: Prisma.TransactionClient, dataset: TaxonomyDataset): Promise<{ occupations: number; codes: number }> {
  const occupations = await tx.occupation.deleteMany({ where: { datasetId: dataset.id } });
  const codes = await tx.occupationCode.deleteMany({ where: { scheme: dataset.scheme, version: dataset.version } });
  await tx.occupationSkill.deleteMany({ where: { datasetId: dataset.id } });
  // Stage 16: a learning-graph dataset's credentials, providers, offerings and requirements go with it.
  await tx.occupationCredential.deleteMany({ where: { datasetId: dataset.id } });
  await tx.learningOffering.deleteMany({ where: { datasetId: dataset.id } });
  await tx.learningProvider.deleteMany({ where: { datasetId: dataset.id } });
  await tx.credential.deleteMany({ where: { datasetId: dataset.id } });
  return { occupations: occupations.count, codes: codes.count };
}

/**
 * Record a dataset's licence and whether it may be ingested. A governance
 * action: admin-only and step-up re-authenticated at the route, audited
 * here with who and why. A decision that withdraws the right to serve —
 * `prohibited`, or `recorded` without approval — purges loaded rows.
 */
export async function recordDatasetLicence(key: string, record: LicenceRecord, actor: StaffContext, reason: string): Promise<LicenceDecision> {
  if (record.status === 'recorded' && (!record.licenceName.trim() || !record.attribution.trim())) {
    throw new TaxonomyLicenceError('A recorded licence needs its name and the attribution text the product must display.', 422);
  }
  if (!reason.trim()) throw new TaxonomyLicenceError('A reason is required: name the review or the counsel advice this records.', 422);
  return db.$transaction(async (tx) => {
    const before = await tx.taxonomyDataset.findUnique({ where: { key } });
    if (!before) throw new TaxonomyLicenceError('Unknown dataset.', 404);
    const approved = record.status === 'recorded' && record.ingestionApproved;
    const purged = !approved && (before.ingestedAt || before.rowCount > 0) ? await purgeDataset(tx, before) : { occupations: 0, codes: 0 };
    const after = await tx.taxonomyDataset.update({
      where: { key },
      data: {
        licenceName: record.licenceName.trim(),
        licenceUrl: record.licenceUrl?.trim() ?? '',
        attribution: record.attribution.trim(),
        licenceStatus: record.status,
        ingestionApproved: approved,
        licenceRecordedAt: new Date(),
        licenceRecordedById: actor.id,
        licenceRecordedByEmail: actor.email,
        ...(record.notes !== undefined ? { notes: record.notes } : {}),
        ...(purged.occupations || purged.codes || !approved ? { ingestedAt: null, rowCount: 0 } : {}),
      },
    });
    const b = snapshot(before);
    const a = snapshot(after);
    const changed = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]);
    await tx.auditLog.create({
      data: {
        actorType: 'staff',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: 'taxonomy.licence.recorded',
        entityType: 'TaxonomyDataset',
        entityId: after.id,
        summary:
          `${record.status === 'prohibited' ? 'Prohibited' : 'Recorded licence for'} ${after.name}${approved ? ' (ingestion approved)' : ''}` +
          `${purged.occupations || purged.codes ? ` — purged ${purged.occupations} occupations and ${purged.codes} codes` : ''}.`,
        before: JSON.stringify(b),
        after: JSON.stringify(a),
        changedFields: JSON.stringify(changed),
        reason,
      },
    });
    return { dataset: after, purged };
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

/**
 * The attribution line for one occupation's dataset, read on the SYSTEM
 * client: the register is system-only (it carries who recorded a licence),
 * and this is the one column a page needs from it.
 */
export async function attributionFor(occupationId: string | null | undefined): Promise<string | null> {
  if (!occupationId) return null;
  const row = await db.occupation.findUnique({ where: { id: occupationId }, select: { dataset: { select: { attribution: true, licenceStatus: true } } } });
  return row?.dataset?.licenceStatus === 'recorded' && row.dataset.attribution ? row.dataset.attribution : null;
}

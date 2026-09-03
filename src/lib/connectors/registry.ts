import type { JobSource, Prisma } from '@prisma/client';
import { db } from '../db';
import type { StaffContext } from '../crm/auth';
import { MockConnector } from './mock';
import type { JobSourceConnector, SourceKind } from './types';
import { SOURCE_PRIORITY } from './types';

/**
 * The source register and the enablement gate (ADR-0008,
 * SOURCE_ACCESS_POLICY.md "Per-connector record").
 *
 * A connector runs only while its JobSource row is `enabled` AND its policy
 * record is complete: legal basis, terms reviewed (by whom, when), approval
 * (by whom, when). The mock is the one source whose record is complete out
 * of the box — it is synthetic, touches no network and holds no personal
 * data, and its row says so. Adzuna is registered `disabled` with its
 * credential NAMES and stays so until a person records the review and
 * enables it; enabling also requires the credentials to be present.
 *
 * Adapters are required lazily so an SDK-free build never loads them.
 */

export interface ConnectorDefinition {
  key: string;
  name: string;
  kind: SourceKind;
  credentialEnvVars: readonly string[];
  /** The record as it can be pre-filled from the code; a person still approves. */
  defaults: Pick<JobSource, 'legalBasis' | 'robotsPosition' | 'rateLimitPerMinute' | 'attributionRequired' | 'attributionText' | 'dataCategories' | 'personalData' | 'retentionRef' | 'notes'>;
  /** Whether the register row is complete and enabled on creation (mock only). */
  enabledByDefault: boolean;
  load(): Promise<JobSourceConnector>;
}

export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    key: 'mock',
    name: 'Built-in synthetic catalogue',
    kind: 'mock',
    credentialEnvVars: [],
    defaults: {
      legalBasis: 'Synthetic catalogue shipped in the repository; no external access, no third-party terms.',
      robotsPosition: 'not applicable — no network access',
      rateLimitPerMinute: 0,
      attributionRequired: false,
      attributionText: '',
      dataCategories: JSON.stringify(['synthetic postings']),
      personalData: false,
      retentionRef: 'DATA_RETENTION_MATRIX.md — Job postings & snapshots',
      notes: 'Enabled by default: it is the reason a clean clone boots with nothing configured.',
    },
    enabledByDefault: true,
    load: async () => new MockConnector(),
  },
  {
    key: 'adzuna',
    name: 'Adzuna (search API)',
    kind: 'aggregator',
    credentialEnvVars: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    defaults: {
      legalBasis: '',
      robotsPosition: 'not applicable — documented API, no crawling',
      rateLimitPerMinute: 0,
      attributionRequired: true,
      attributionText: '',
      dataCategories: JSON.stringify(['job postings (CA/US)']),
      personalData: false,
      retentionRef: 'DATA_RETENTION_MATRIX.md — Job postings & snapshots',
      notes: 'Disabled until the API terms are reviewed and recorded and ADZUNA_APP_ID / ADZUNA_APP_KEY are present. Never validated against the live API from this codebase.',
    },
    enabledByDefault: false,
    load: async () => {
      // Imported lazily so the adapter never loads in deployments without a key.
      const { AdzunaConnector } = await import('./adzuna');
      return new AdzunaConnector();
    },
  },
];

export class SourceAccessError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'SourceAccessError';
    this.status = status;
  }
}

type Client = Prisma.TransactionClient | typeof db;

/** Ensure every known connector has a register row. Idempotent; governance fields untouched on update. */
export async function ensureSourceRegistry(client: Client = db): Promise<JobSource[]> {
  const rows: JobSource[] = [];
  for (const d of CONNECTOR_DEFINITIONS) {
    rows.push(
      await client.jobSource.upsert({
        where: { key: d.key },
        create: {
          key: d.key,
          name: d.name,
          kind: d.kind,
          priority: SOURCE_PRIORITY[d.kind],
          status: d.enabledByDefault ? 'enabled' : 'disabled',
          credentialEnvVars: JSON.stringify(d.credentialEnvVars),
          ...d.defaults,
          ...(d.enabledByDefault
            ? { termsReviewedAt: new Date(), termsReviewedByEmail: 'repository', approvedAt: new Date(), approvedByEmail: 'repository' }
            : {}),
        },
        update: { name: d.name, kind: d.kind, priority: SOURCE_PRIORITY[d.kind], credentialEnvVars: JSON.stringify(d.credentialEnvVars) },
      }),
    );
  }
  return rows;
}

/** The per-connector record is complete when the policy fields a person must fill are filled. */
export function recordComplete(s: JobSource): boolean {
  return Boolean(s.legalBasis.trim() && s.termsReviewedAt && s.termsReviewedByEmail && s.approvedAt && s.approvedByEmail && s.retentionRef.trim());
}

/** Which credential names are missing from the environment for a source. */
export function missingCredentials(s: JobSource): string[] {
  let names: string[] = [];
  try {
    names = JSON.parse(s.credentialEnvVars) as string[];
  } catch {
    names = [];
  }
  return names.filter((n) => !process.env[n]);
}

/**
 * The only way the pipeline obtains a connector to run. Refuses a source
 * that is not registered, not enabled, whose record is incomplete, or
 * whose credentials are absent — each with a stable message.
 */
export async function requireEnabledSource(key: string, client: Client = db): Promise<{ source: JobSource; connector: JobSourceConnector }> {
  const definition = CONNECTOR_DEFINITIONS.find((d) => d.key === key);
  if (!definition) throw new SourceAccessError(`Job source "${key}" is not a known connector.`, 404);
  const source = await client.jobSource.findUnique({ where: { key } });
  if (!source) throw new SourceAccessError(`Job source "${key}" is not registered.`, 404);
  if (source.status === 'disabled') throw new SourceAccessError(`Job source "${key}" is disabled (SOURCE_ACCESS_POLICY.md).`);
  if (!recordComplete(source)) throw new SourceAccessError(`Job source "${key}" cannot run: its per-connector record is incomplete (legal basis, terms review, approval, retention).`);
  const missing = missingCredentials(source);
  if (missing.length) throw new SourceAccessError(`Job source "${key}" cannot run: missing credential(s) ${missing.join(', ')}.`);
  return { source, connector: await definition.load() };
}

export interface SourcePolicyRecord {
  legalBasis: string;
  robotsPosition?: string;
  rateLimitPerMinute?: number;
  attributionRequired?: boolean;
  attributionText?: string;
  dataCategories?: string[];
  personalData?: boolean;
  retentionRef: string;
  notes?: string;
  /** enable | disable | record-only */
  action: 'enable' | 'disable' | 'record';
}

/**
 * Record a source's policy and enable or disable it. Admin + step-up at the
 * route; audited here. Enabling checks the record and the credentials, so a
 * source can never be enabled into a state the pipeline would refuse.
 */
export async function recordSourcePolicy(key: string, record: SourcePolicyRecord, actor: StaffContext, reason: string): Promise<JobSource> {
  if (!reason.trim()) throw new SourceAccessError('A reason is required: name the terms review this records.', 422);
  return db.$transaction(async (tx) => {
    const before = await tx.jobSource.findUnique({ where: { key } });
    if (!before) throw new SourceAccessError('Unknown job source.', 404);
    const now = new Date();
    const data: Prisma.JobSourceUpdateInput = {
      legalBasis: record.legalBasis.trim(),
      robotsPosition: record.robotsPosition?.trim() ?? before.robotsPosition,
      rateLimitPerMinute: record.rateLimitPerMinute ?? before.rateLimitPerMinute,
      attributionRequired: record.attributionRequired ?? before.attributionRequired,
      attributionText: record.attributionText?.trim() ?? before.attributionText,
      dataCategories: record.dataCategories ? JSON.stringify(record.dataCategories) : before.dataCategories,
      personalData: record.personalData ?? before.personalData,
      retentionRef: record.retentionRef.trim(),
      notes: record.notes ?? before.notes,
      termsReviewedAt: now,
      termsReviewedByEmail: actor.email,
    };
    if (record.action === 'enable') {
      const candidate = { ...before, ...data, termsReviewedAt: now, termsReviewedByEmail: actor.email, approvedAt: now, approvedByEmail: actor.email } as JobSource;
      if (!recordComplete(candidate)) throw new SourceAccessError('The record is incomplete: legal basis and retention reference are required to enable a source.', 422);
      const missing = missingCredentials(candidate);
      if (missing.length) throw new SourceAccessError(`Cannot enable: missing credential(s) ${missing.join(', ')} in this deployment.`, 422);
      Object.assign(data, { status: 'enabled', approvedAt: now, approvedByEmail: actor.email, errorCount: 0, lastError: null });
    } else if (record.action === 'disable') {
      Object.assign(data, { status: 'disabled' });
    }
    const after = await tx.jobSource.update({ where: { key }, data });
    await tx.auditLog.create({
      data: {
        actorType: 'staff',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: record.action === 'enable' ? 'source.enabled' : record.action === 'disable' ? 'source.disabled' : 'source.policy.recorded',
        entityType: 'JobSource',
        entityId: after.id,
        summary: `${record.action === 'enable' ? 'Enabled' : record.action === 'disable' ? 'Disabled' : 'Recorded the policy for'} job source ${after.name}.`,
        before: JSON.stringify({ status: before.status, legalBasis: before.legalBasis, approvedByEmail: before.approvedByEmail, retentionRef: before.retentionRef }),
        after: JSON.stringify({ status: after.status, legalBasis: after.legalBasis, approvedByEmail: after.approvedByEmail, retentionRef: after.retentionRef }),
        changedFields: JSON.stringify(['status', 'legalBasis', 'termsReviewedAt', 'approvedAt', 'retentionRef']),
        reason,
      },
    });
    return after;
  });
}

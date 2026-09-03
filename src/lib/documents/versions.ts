import { createHash } from 'node:crypto';
import { Prisma, type DocumentVersion } from '@prisma/client';
import { db } from '../db';
import { getStorageProvider } from '../storage';

/**
 * Stage 09 — document versions.
 *
 * Every rendered or uploaded document is a `DocumentVersion` row whose
 * bytes live in the object store under a key that names the owner, the
 * scope (an application, a posting, or general), the kind, the format and
 * the version number. The row carries the SHA-256 of the bytes; every read
 * recomputes it and refuses a mismatch, so a document either comes back
 * byte-identical or not at all — that is what "byte-reproducible from
 * storage" means here, and the immutability test proves it.
 *
 * A version sealed at submission (`status = submitted`) is immutable. This
 * module offers no way to change one; a database trigger refuses an UPDATE
 * of a submitted row, and a DIRECT delete of one, independently (migration
 * 20260903170000_document_versions). The one way a sealed version leaves is
 * with its owner: the cascade from the User row — account erasure — passes
 * the guard, because a person's right to erasure outranks our
 * record-keeping and a sealed document has no meaning without its owner.
 */
export type { DocumentFormat, DocumentKind, MessageKind } from './kinds';
export { CONTENT_TYPES, DOCUMENT_FORMATS, DOCUMENT_KINDS, KIND_LABELS, MESSAGE_KINDS } from './kinds';
import { CONTENT_TYPES, type DocumentFormat, type DocumentKind } from './kinds';

export class DocumentIntegrityError extends Error {
  constructor(message: string, readonly documentId: string) {
    super(message);
    this.name = 'DocumentIntegrityError';
  }
}

type Client = Prisma.TransactionClient | typeof db;

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The application id, "job:<id>" for a message about a posting, or "general". */
export function scopeKeyFor(input: { applicationId?: string | null; jobId?: string | null }): string {
  return input.applicationId ?? (input.jobId ? `job:${input.jobId}` : 'general');
}

export interface RecordDocumentInput {
  userId: string;
  applicationId?: string | null;
  jobId?: string | null;
  kind: DocumentKind;
  format: DocumentFormat;
  bytes: Buffer;
  evidenceIds?: string[];
  aiRunId?: string | null;
  atsReport?: unknown;
  scanReport?: unknown;
}

/**
 * Store the bytes and write the row, taking the next version number in the
 * scope. Two writers racing for the same scope, kind and format take
 * consecutive numbers: the unique index refuses the loser, who retries once.
 */
export async function recordDocumentVersion(client: Client, input: RecordDocumentInput): Promise<DocumentVersion> {
  const scopeKey = scopeKeyFor(input);
  const contentHash = sha256(input.bytes);
  const store = await getStorageProvider();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await client.documentVersion.findFirst({
      where: { userId: input.userId, scopeKey, kind: input.kind, format: input.format },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const storageKey = `${input.userId}/documents/${scopeKey.replace(/[^A-Za-z0-9_.:-]/g, '_')}/${input.kind}-v${version}.${input.format}`;
    await store.putBytes(storageKey, input.bytes, CONTENT_TYPES[input.format]);
    try {
      return await client.documentVersion.create({
        data: {
          userId: input.userId,
          applicationId: input.applicationId ?? null,
          jobId: input.jobId ?? null,
          scopeKey,
          kind: input.kind,
          format: input.format,
          version,
          contentHash,
          sizeBytes: input.bytes.length,
          storageKey,
          evidenceIds: JSON.stringify(input.evidenceIds ?? []),
          aiRunId: input.aiRunId ?? null,
          atsReport: JSON.stringify(input.atsReport ?? {}),
          scanReport: JSON.stringify(input.scanReport ?? {}),
        },
      });
    } catch (error) {
      const collision = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      if (!collision || attempt === 1) throw error;
    }
  }
  throw new Error('unreachable');
}

/**
 * The bytes of a version, verified against the stored hash. A missing or
 * altered object is refused, never served.
 */
export async function readDocumentBytes(row: Pick<DocumentVersion, 'id' | 'storageKey' | 'contentHash'>): Promise<Buffer> {
  const bytes = await (await getStorageProvider()).getBytes(row.storageKey);
  if (!bytes) throw new DocumentIntegrityError('The stored document is missing.', row.id);
  if (sha256(bytes) !== row.contentHash) throw new DocumentIntegrityError('The stored document does not match its recorded hash.', row.id);
  return bytes;
}

/** The kinds a submission consists of. A drafted message is never "sent" by the platform and is never sealed. */
export const SUBMITTED_KINDS: readonly DocumentKind[] = ['resume', 'cover_letter'];

/**
 * Seal the résumé and cover-letter drafts of an application at the moment it
 * is submitted: those drafts ARE what was sent. Any other kind under the
 * application (a thank-you note drafted before confirmation, an outreach
 * message) is left a draft — sealing it would record a submission that
 * never happened. Returns how many were sealed. Idempotent.
 */
export async function sealApplicationDocuments(client: Client, userId: string, applicationId: string, at = new Date(), kinds: readonly DocumentKind[] = SUBMITTED_KINDS): Promise<number> {
  const result = await client.documentVersion.updateMany({
    where: { userId, applicationId, status: 'draft', kind: { in: [...kinds] } },
    data: { status: 'submitted', sealedAt: at },
  });
  return result.count;
}

export async function listDocumentVersions(client: Client, userId: string, filter: { applicationId?: string; jobId?: string; kind?: DocumentKind } = {}): Promise<DocumentVersion[]> {
  return client.documentVersion.findMany({
    where: { userId, ...(filter.applicationId ? { applicationId: filter.applicationId } : {}), ...(filter.jobId ? { jobId: filter.jobId } : {}), ...(filter.kind ? { kind: filter.kind } : {}) },
    orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
  });
}

/** Filesystem-safe slug for a download name. */
function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'document';
}

export function documentFileName(row: Pick<DocumentVersion, 'kind' | 'format' | 'version'>, context: { company?: string | null } = {}): string {
  return `${slug(row.kind.replace(/_/g, ' '))}${context.company ? `-${slug(context.company)}` : ''}-v${row.version}.${row.format}`;
}

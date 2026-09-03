import { Prisma } from '@prisma/client';
import { db } from '../db';
import { assertTenantId, TenantContextError } from '../tenancy/context';
import { GUC_USER_ID } from '../tenancy/rls-tables';
import { recordSecurityEvent, type RequestMeta } from '../security-audit';

/**
 * Voluntary demographic self-identification — the ONLY code that touches the
 * `sensitive` schema (ADR-0007).
 *
 * WHAT MAKES THIS THE ONLY PATH
 * ----------------------------
 * There is no Prisma model for `sensitive.self_identification`, so the Prisma
 * client cannot select, include or serialise it. The table is reachable only
 * with raw SQL, only by a role that holds a privilege on the schema, and the
 * only such role the application can assume is `app_sensitive`, which this
 * module assumes with `SET LOCAL ROLE` inside a transaction that has set the
 * candidate's own id as context. The row-level policy on the table then binds
 * reads and writes to that one row. The tenant role (`app_tenant`) and the
 * system role's ordinary Prisma queries hold no such privilege — a query from
 * the matching, scoring or AI path fails with a permission error at runtime,
 * which tests/sensitive-segregation.test.ts proves.
 *
 * Every read and every write is audited WITHOUT the values: the audit row says
 * that the candidate viewed or changed their self-identification, never what
 * it says. Aggregate EEO reporting with small-cohort suppression is a later
 * stage and will need its own, separately authorised path.
 *
 * "Prefer not to say" is a stored value, distinct from "never asked".
 */

export const SENSITIVE_ROLE = 'app_sensitive';

/** Version of the notice shown when the candidate is asked. Bump when its wording changes. */
export const SELF_IDENTIFICATION_NOTICE_VERSION = '2026-09-01';

export const PREFER_NOT_TO_SAY = 'prefer_not_to_say';

export const GENDER = ['woman', 'man', 'non_binary', 'self_described', PREFER_NOT_TO_SAY] as const;
export const ETHNICITY = ['racialized', 'not_racialized', 'self_described', PREFER_NOT_TO_SAY] as const;
export const INDIGENOUS_STATUS = ['first_nations', 'metis', 'inuit', 'not_indigenous', PREFER_NOT_TO_SAY] as const;
export const VETERAN_STATUS = ['veteran', 'not_veteran', PREFER_NOT_TO_SAY] as const;
export const DISABILITY_STATUS = ['person_with_disability', 'no_disability', PREFER_NOT_TO_SAY] as const;

export interface SelfIdentification {
  gender: (typeof GENDER)[number];
  ethnicity: (typeof ETHNICITY)[number];
  indigenousStatus: (typeof INDIGENOUS_STATUS)[number];
  veteranStatus: (typeof VETERAN_STATUS)[number];
  disabilityStatus: (typeof DISABILITY_STATUS)[number];
  noticeVersion: string;
  updatedAt: Date;
}

export type SelfIdentificationInput = Omit<SelfIdentification, 'noticeVersion' | 'updatedAt'>;

const includes = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

export function isSelfIdentificationInput(value: unknown): value is SelfIdentificationInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    includes(GENDER, v.gender) &&
    includes(ETHNICITY, v.ethnicity) &&
    includes(INDIGENOUS_STATUS, v.indigenousStatus) &&
    includes(VETERAN_STATUS, v.veteranStatus) &&
    includes(DISABILITY_STATUS, v.disabilityStatus)
  );
}

interface Row {
  gender: string;
  ethnicity: string;
  indigenous_status: string;
  veteran_status: string;
  disability_status: string;
  notice_version: string;
  updated_at: Date;
}

/**
 * Run `fn` as the sensitive role, for one candidate, in one transaction. The
 * client is a parameter so the segregation test can drive it against a pool
 * of its own; the default is the application's system client, which is the
 * only client that is a member of `app_sensitive`.
 */
async function asSensitive<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  client: typeof db = db,
): Promise<T> {
  assertTenantId(userId, 'userId');
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${SENSITIVE_ROLE}`);
    await tx.$queryRaw`SELECT set_config(${GUC_USER_ID}, ${userId}, TRUE)`;
    return fn(tx);
  });
}

function fromRow(r: Row): SelfIdentification {
  return {
    gender: r.gender as SelfIdentification['gender'],
    ethnicity: r.ethnicity as SelfIdentification['ethnicity'],
    indigenousStatus: r.indigenous_status as SelfIdentification['indigenousStatus'],
    veteranStatus: r.veteran_status as SelfIdentification['veteranStatus'],
    disabilityStatus: r.disability_status as SelfIdentification['disabilityStatus'],
    noticeVersion: r.notice_version,
    updatedAt: r.updated_at,
  };
}

/** The candidate's own answers, or null if never recorded. Audited. */
export async function readSelfIdentification(
  user: { id: string; email: string },
  options: { meta?: RequestMeta; client?: typeof db } = {},
): Promise<SelfIdentification | null> {
  const rows = await asSensitive(
    user.id,
    (tx) => tx.$queryRaw<Row[]>`
      SELECT gender, ethnicity, indigenous_status, veteran_status, disability_status, notice_version, updated_at
        FROM sensitive.self_identification
       WHERE user_id = ${user.id}`,
    options.client,
  );
  await recordSecurityEvent(
    { event: 'sensitive.read', user, entityType: 'SelfIdentification', entityId: user.id, summary: 'Viewed own self-identification', meta: options.meta },
    options.client,
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Record or replace the candidate's own answers. Values are validated, never logged. Audited. */
export async function writeSelfIdentification(
  user: { id: string; email: string },
  input: SelfIdentificationInput,
  options: { meta?: RequestMeta; client?: typeof db } = {},
): Promise<SelfIdentification> {
  if (!isSelfIdentificationInput(input)) {
    throw new TenantContextError('self-identification values are outside the permitted vocabulary');
  }
  const rows = await asSensitive(
    user.id,
    (tx) => tx.$queryRaw<Row[]>`
      INSERT INTO sensitive.self_identification
        (user_id, gender, ethnicity, indigenous_status, veteran_status, disability_status, notice_version, updated_at)
      VALUES (${user.id}, ${input.gender}, ${input.ethnicity}, ${input.indigenousStatus}, ${input.veteranStatus}, ${input.disabilityStatus}, ${SELF_IDENTIFICATION_NOTICE_VERSION}, now())
      ON CONFLICT (user_id) DO UPDATE SET
        gender = EXCLUDED.gender, ethnicity = EXCLUDED.ethnicity, indigenous_status = EXCLUDED.indigenous_status,
        veteran_status = EXCLUDED.veteran_status, disability_status = EXCLUDED.disability_status,
        notice_version = EXCLUDED.notice_version, updated_at = now()
      RETURNING gender, ethnicity, indigenous_status, veteran_status, disability_status, notice_version, updated_at`,
    options.client,
  );
  await recordSecurityEvent(
    { event: 'sensitive.write', user, entityType: 'SelfIdentification', entityId: user.id, summary: 'Updated own self-identification', detail: { noticeVersion: SELF_IDENTIFICATION_NOTICE_VERSION }, meta: options.meta },
    options.client,
  );
  return fromRow(rows[0]);
}

/** Delete the candidate's answers entirely (their right; also part of erasure). Audited. */
export async function eraseSelfIdentification(
  user: { id: string; email: string },
  options: { meta?: RequestMeta; client?: typeof db; actor?: 'user' | 'system' } = {},
): Promise<boolean> {
  const count = await asSensitive(
    user.id,
    (tx) => tx.$executeRaw`DELETE FROM sensitive.self_identification WHERE user_id = ${user.id}`,
    options.client,
  );
  if (count > 0) {
    await recordSecurityEvent(
      { event: 'sensitive.erased', user, actor: options.actor === 'system' ? { type: 'system' } : undefined, entityType: 'SelfIdentification', entityId: user.id, summary: 'Self-identification erased', meta: options.meta },
      options.client,
    );
  }
  return count > 0;
}

/**
 * Whether `error` is PostgreSQL refusing access to the sensitive schema — the
 * signature the segregation test looks for when the wrong role tries.
 */
export function isSensitiveAccessDenied(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return /permission denied/i.test(error.message);
  return error instanceof Error && /permission denied/i.test(error.message);
}

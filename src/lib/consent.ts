import type { Prisma } from '@prisma/client';
import { db } from './db';
import { recordSecurityEvent, type RequestMeta } from './security-audit';

/**
 * Consent capture — explicit, versioned, revocable (PRODUCTION_READINESS_GATES
 * G5). This module owns the purpose vocabulary and the CURRENT version string
 * of each document. The legal wording behind a version is owned by the founder
 * and counsel (COMPLIANCE_REGISTER.md L-5) and lives in the CMS or the public
 * site, never here; what this records is that a specific person agreed to a
 * specific version at a specific time from a specific address.
 *
 * Bumping a version here means every user must re-consent to that purpose
 * before the platform treats them as having agreed to it. That is the whole
 * point of versioning; do not bump casually.
 */

export const CONSENT_PURPOSES = [
  'terms_of_service',
  'privacy_policy',
  'marketing_email',
  'cross_border_ai_processing',
  // Stage 11: one grant per connection kind; recorded before an OAuth flow starts.
  'mailbox_sync',
  'calendar_sync',
  // Stage 17: a service provider's case manager may read this person's job-search data (never the sensitive schema); one record per accepted case.
  'employment_services_case',
  // Stage 18: this person's profile may be disclosed to ONE employer organisation; one record per granted disclosure. Wording pending L-5.
  'employer_disclosure',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * The purposes a person grants and withdraws THEMSELVES, as a setting and on
 * the candidate API (`/v1/consents`, whose contract enumerates exactly these).
 * A purpose bound to a specific counterparty - the Stage 17 case consent, one
 * record per accepted case - is granted and revoked only through that flow
 * (Settings → invitations), never as a generic toggle: withdrawing it means
 * closing that case, which the flow does and a toggle could not.
 */
export const SELF_SERVICE_PURPOSES = ['terms_of_service', 'privacy_policy', 'marketing_email', 'cross_border_ai_processing', 'mailbox_sync', 'calendar_sync'] as const satisfies readonly ConsentPurpose[];
export type SelfServicePurpose = (typeof SELF_SERVICE_PURPOSES)[number];

export function isSelfServicePurpose(value: unknown): value is SelfServicePurpose {
  return typeof value === 'string' && (SELF_SERVICE_PURPOSES as readonly string[]).includes(value);
}

/** Purposes an account cannot be created without. */
export const REQUIRED_AT_SIGNUP: readonly ConsentPurpose[] = ['terms_of_service', 'privacy_policy'];

export const CONSENT_VERSIONS: Record<ConsentPurpose, string> = {
  terms_of_service: '2026-09-01',
  privacy_policy: '2026-09-01',
  marketing_email: '2026-09-01',
  // Deliberately unversioned-as-unavailable until L-3 is resolved: no code
  // path may record this consent while the legal question is open, so the
  // version is a sentinel the gateway (Stage 03) will refuse.
  cross_border_ai_processing: 'PENDING-L-3',
  mailbox_sync: '2026-09-03',
  calendar_sync: '2026-09-03',
  employment_services_case: '2026-09-05',
  // The consent MECHANISM is in force; the wording a candidate reads is a draft until counsel settles L-5 (COMPLIANCE_REGISTER.md).
  employer_disclosure: '2026-09-05-draft',
};

export function isConsentPurpose(value: unknown): value is ConsentPurpose {
  return typeof value === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(value);
}

type Client = Prisma.TransactionClient | typeof db;

/** The wording for this purpose is a draft (an open item in COMPLIANCE_REGISTER.md); nothing is recorded under it in production. */
export class ConsentWordingPendingError extends Error {
  readonly status = 503;
  readonly purpose: ConsentPurpose;
  constructor(purpose: ConsentPurpose) {
    super(`The ${purpose} consent wording is pending legal review (${CONSENT_VERSIONS[purpose]}); it cannot be recorded in production yet.`);
    this.name = 'ConsentWordingPendingError';
    this.purpose = purpose;
  }
}

/** Record a grant of the current version of `purpose`. */
export async function grantConsent(
  client: Client,
  user: { id: string; email: string },
  purpose: ConsentPurpose,
  options: { source?: string; meta?: RequestMeta } = {},
) {
  if (purpose === 'cross_border_ai_processing') {
    throw new Error('cross_border_ai_processing consent cannot be recorded while L-3 is open');
  }
  // A purpose whose wording counsel has not settled carries a `-draft` version
  // (employer_disclosure, L-5). The mechanism is exercised outside production;
  // in production no such consent is recorded until the version is final -
  // the register's rule that an open legal question is never treated as
  // settled in code.
  if (CONSENT_VERSIONS[purpose].endsWith('-draft') && process.env.NODE_ENV === 'production') {
    throw new ConsentWordingPendingError(purpose);
  }
  const row = await client.consentRecord.create({
    data: {
      userId: user.id,
      purpose,
      version: CONSENT_VERSIONS[purpose],
      source: options.source ?? 'signup',
      ip: options.meta?.ip ?? null,
    },
  });
  await recordSecurityEvent(
    {
      event: 'consent.granted',
      user,
      entityType: 'ConsentRecord',
      entityId: row.id,
      summary: `Consent granted: ${purpose} v${CONSENT_VERSIONS[purpose]}`,
      detail: { purpose, version: CONSENT_VERSIONS[purpose], source: row.source },
      meta: options.meta,
    },
    client,
  );
  return row;
}

/** Revoke every open grant of `purpose`. Rows are kept; `revokedAt` is set. */
export async function revokeConsent(
  client: Client,
  user: { id: string; email: string },
  purpose: ConsentPurpose,
  options: { meta?: RequestMeta } = {},
) {
  const result = await client.consentRecord.updateMany({
    where: { userId: user.id, purpose, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    await recordSecurityEvent(
      {
        event: 'consent.revoked',
        user,
        entityType: 'ConsentRecord',
        entityId: user.id,
        summary: `Consent revoked: ${purpose}`,
        detail: { purpose, revoked: result.count },
        meta: options.meta,
      },
      client,
    );
  }
  return result.count;
}

/** Whether the user holds an unrevoked grant of the CURRENT version. */
export async function hasCurrentConsent(client: Client, userId: string, purpose: ConsentPurpose): Promise<boolean> {
  const row = await client.consentRecord.findFirst({
    where: { userId, purpose, version: CONSENT_VERSIONS[purpose], revokedAt: null },
    select: { id: true },
  });
  return row !== null;
}

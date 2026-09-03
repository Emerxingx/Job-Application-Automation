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
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

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
};

export function isConsentPurpose(value: unknown): value is ConsentPurpose {
  return typeof value === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(value);
}

type Client = Prisma.TransactionClient | typeof db;

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

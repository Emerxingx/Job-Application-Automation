import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { revokeAllSessions } from '@/lib/auth';
import { revokeAllDeviceSessions } from '@/lib/integrations/device-sessions';
import { eraseSelfIdentification } from '@/lib/sensitive/self-identification';
import { revokeConnection } from '@/lib/mailbox/service';
import { getStorageProvider } from '@/lib/storage';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';

/**
 * Stage 23 (ADR-0037) - account erasure, end to end.
 *
 * `DATA_RETENTION_MATRIX.md` designed "scrub-in-place" erasure in Stage 00
 * and `DeletionRequest` was modelled for it; neither had code (readiness gate
 * G3 "Erasure: PARTIAL - DeletionRequest unused"). This module is that code.
 *
 * The shape, and why:
 * - A request is SCHEDULED, not immediate: fourteen days of grace
 *   (`ERASURE_GRACE_DAYS`), cancellable, because an erasure cannot be undone
 *   and a compromised session must not be able to destroy an account in one
 *   click. A live subscription must be cancelled first, so no invoice is
 *   raised against an erased person.
 * - Execution SCRUBS the `User` row and DELETES the personal tables. The user
 *   row itself stays: invoices, payments, refunds, credit notes and
 *   placements reference it with RESTRICT and are statutory or contractual
 *   records (matrix rule 1), and audit rows must keep pointing at a stable
 *   id. Every identifying column on it is replaced with a value that
 *   identifies nobody.
 * - What is deleted is the person's own data: profile, evidence, résumés,
 *   applications and their folders (the submitted document versions leave
 *   through the Application cascade, which the Stage 09 trigger allows at
 *   depth 2 - the erasure path it was written for), agents and matches,
 *   plans, mailbox connections (revoked first so tokens are purged the Stage
 *   11 way), sessions, keys, identities, notifications, per-person marts and
 *   usage rows, billing profile and payment methods, the CRM record. The
 *   sensitive schema is erased through its own module (ADR-0007). Files
 *   under the person's storage prefix are removed.
 * - What is scrubbed but kept, because it is ANOTHER party's record: a
 *   service provider's `Case` (the client's invited name and address are
 *   replaced; the provider's notes and outcomes are the provider's, under
 *   their retention policy), an agency's `RepresentationConsent`, a support
 *   ticket (address replaced; the ticket stays for the support record),
 *   memberships (marked removed), the personal workspace (renamed).
 *   Employer submissions, disclosures and notes keep their ids only.
 * - Never touched: `AuditLog`, `ConsentRecord` (the evidence that consent
 *   was given and withdrawn), invoices, payments, refunds, credit notes,
 *   placements and placement invoices.
 *
 * Every step is on the system client: a person's erasure spans tables the
 * tenant role may not write. The report carries counts and ids only.
 */
export const ERASURE_GRACE_DAYS = 14;

export class ErasureError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'ErasureError';
  }
}

export interface ErasureStatus {
  status: 'none' | 'scheduled' | 'canceled' | 'completed';
  scheduledFor: Date | null;
  completedAt: Date | null;
}

export async function erasureStatus(userId: string): Promise<ErasureStatus> {
  const r = await db.deletionRequest.findUnique({ where: { userId }, select: { status: true, scheduledFor: true, completedAt: true } });
  if (!r) return { status: 'none', scheduledFor: null, completedAt: null };
  return { status: r.status === 'scheduled' ? 'scheduled' : r.status === 'completed' ? 'completed' : 'canceled', scheduledFor: r.status === 'scheduled' ? r.scheduledFor : null, completedAt: r.completedAt };
}

/** The address an erased account carries: unique, unroutable (`.invalid`, RFC 2606), identifies nobody. */
export function erasedEmail(userId: string): string {
  return `erased-${userId}@erased.invalid`;
}

export async function requestErasure(user: { id: string; email: string }, options: { reason?: string; meta?: RequestMeta; now?: Date } = {}): Promise<ErasureStatus> {
  const now = options.now ?? new Date();
  const subscription = await db.subscription.findUnique({ where: { userId: user.id }, select: { status: true } });
  if (subscription && ['active', 'trialing', 'past_due'].includes(subscription.status)) {
    throw new ErasureError('Cancel your subscription before requesting erasure, so nothing is billed to an account that no longer exists.', 409);
  }
  const existing = await db.deletionRequest.findUnique({ where: { userId: user.id } });
  if (existing?.status === 'scheduled') return erasureStatus(user.id);
  if (existing?.status === 'completed') throw new ErasureError('This account has already been erased.', 409);
  const scheduledFor = new Date(now.getTime() + ERASURE_GRACE_DAYS * 86_400_000);
  const reason = (options.reason ?? '').slice(0, 500) || null;
  const row = await db.deletionRequest.upsert({
    where: { userId: user.id },
    create: { userId: user.id, reason, status: 'scheduled', scheduledFor },
    update: { reason, status: 'scheduled', scheduledFor, canceledAt: null, completedAt: null },
    select: { id: true },
  });
  await recordSecurityEvent({ event: 'privacy.erasure.requested', user, entityType: 'DeletionRequest', entityId: row.id, summary: `Account erasure requested; scheduled for ${scheduledFor.toISOString().slice(0, 10)} (${ERASURE_GRACE_DAYS}-day grace).`, meta: options.meta });
  return erasureStatus(user.id);
}

export async function cancelErasure(user: { id: string; email: string }, options: { meta?: RequestMeta; now?: Date } = {}): Promise<ErasureStatus> {
  const existing = await db.deletionRequest.findUnique({ where: { userId: user.id } });
  if (!existing || existing.status !== 'scheduled') throw new ErasureError('No erasure is scheduled.', 404);
  await db.deletionRequest.update({ where: { id: existing.id }, data: { status: 'canceled', canceledAt: options.now ?? new Date() } });
  await recordSecurityEvent({ event: 'privacy.erasure.canceled', user, entityType: 'DeletionRequest', entityId: existing.id, summary: 'Account erasure cancelled by the account holder within the grace period.', meta: options.meta });
  return erasureStatus(user.id);
}

export interface ErasureReport {
  userId: string;
  deleted: Record<string, number>;
  scrubbed: Record<string, number>;
  filesRemoved: number;
}

/** The scheduled requests whose grace period has passed. */
export async function dueErasures(now = new Date()): Promise<string[]> {
  const rows = await db.deletionRequest.findMany({ where: { status: 'scheduled', scheduledFor: { lte: now } }, select: { userId: true }, orderBy: { scheduledFor: 'asc' } });
  return rows.map((r) => r.userId);
}

/**
 * Execute one person's erasure. Called by the retention sweep for due
 * requests, or by a test; a person cannot skip their own grace period, so
 * `force` exists for the sweep and for staff, never for a route.
 */
export async function executeErasure(userId: string, options: { now?: Date; force?: boolean; meta?: RequestMeta } = {}): Promise<ErasureReport> {
  const now = options.now ?? new Date();
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, anonymizedAt: true } });
  if (!user) throw new ErasureError('No such account.', 404);
  const request = await db.deletionRequest.findUnique({ where: { userId } });
  if (!options.force) {
    if (!request || request.status !== 'scheduled') throw new ErasureError('No erasure is scheduled for this account.', 409);
    if (request.scheduledFor > now) throw new ErasureError('The grace period has not ended.', 409);
  }
  if (user.anonymizedAt) throw new ErasureError('This account has already been erased.', 409);

  // 1. The RESTRICTED schema first, through its own module (ADR-0007), and the
  //    mailbox connections through their own revocation (ADR-0025) - each
  //    purges what it owns and writes its own audit row.
  await eraseSelfIdentification({ id: user.id, email: user.email }, { actor: 'system', meta: options.meta });
  const connections = await db.mailboxConnection.findMany({ where: { userId }, select: { id: true, status: true } });
  for (const c of connections) if (c.status !== 'revoked') await revokeConnection({ id: user.id, email: user.email }, c.id, options.meta).catch(() => undefined);

  // 2. Sessions and keys, so nothing authenticates as this person again.
  await revokeAllSessions(userId, 'account_erasure');
  await revokeAllDeviceSessions(userId, 'account_erasure');

  // 3. The storage keys to remove, collected before the rows go.
  const versions = await db.documentVersion.findMany({ where: { userId }, select: { storageKey: true } });
  const exports = await db.exportJob.findMany({ where: { userId }, select: { filePath: true } });

  const scrubbedEmail = erasedEmail(userId);
  const deleted: Record<string, number> = {};
  const scrubbed: Record<string, number> = {};

  await db.$transaction(
    async (tx) => {
      const del = async (name: string, run: () => Promise<{ count: number }>) => {
        deleted[name] = (await run()).count;
      };
      const upd = async (name: string, run: () => Promise<{ count: number }>) => {
        scrubbed[name] = (await run()).count;
      };
      // Applications first: the Stage 09 trigger lets a submitted DocumentVersion go only inside a cascade.
      await del('applications', () => tx.application.deleteMany({ where: { userId } }));
      await del('documentVersions', () => tx.documentVersion.deleteMany({ where: { userId, status: { not: 'submitted' } } }));
      await del('agents', () => tx.agent.deleteMany({ where: { userId } }));
      await del('resumes', () => tx.resume.deleteMany({ where: { userId } }));
      await del('resumeScans', () => tx.resumeScan.deleteMany({ where: { userId } }));
      await del('candidateProfiles', () => tx.candidateProfile.deleteMany({ where: { userId } }));
      await del('careerEvidence', () => tx.careerEvidence.deleteMany({ where: { userId } }));
      await del('careerPlans', () => tx.careerPlan.deleteMany({ where: { userId } }));
      await del('eligibilityResults', () => tx.eligibilityResult.deleteMany({ where: { userId } }));
      await del('interviewPreps', () => tx.interviewPrep.deleteMany({ where: { userId } }));
      await del('savedJobs', () => tx.savedJob.deleteMany({ where: { userId } }));
      await del('mailboxConnections', () => tx.mailboxConnection.deleteMany({ where: { userId } }));
      await del('emailThreads', () => tx.emailThread.deleteMany({ where: { userId } }));
      await del('calendarEventRefs', () => tx.calendarEventRef.deleteMany({ where: { userId } }));
      await del('integrationEvents', () => tx.integrationEvent.deleteMany({ where: { userId } }));
      await del('integrations', () => tx.integration.deleteMany({ where: { userId } }));
      await del('sessions', () => tx.session.deleteMany({ where: { userId } }));
      await del('apiKeys', () => tx.apiKey.deleteMany({ where: { userId } }));
      await del('identities', () => tx.userIdentity.deleteMany({ where: { userId } }));
      await del('emailTokens', () => tx.emailToken.deleteMany({ where: { userId } }));
      await del('notifications', () => tx.notification.deleteMany({ where: { userId } }));
      await del('notificationPreferences', () => tx.notificationPreference.deleteMany({ where: { userId } }));
      await del('emailLogs', () => tx.emailLog.deleteMany({ where: { userId } }));
      await del('aiRuns', () => tx.aiRun.deleteMany({ where: { userId } }));
      await del('usageEvents', () => tx.usageEvent.deleteMany({ where: { userId } }));
      await del('activityEvents', () => tx.activityEvent.deleteMany({ where: { userId } }));
      await del('usageRollups', () => tx.dailyUsageRollup.deleteMany({ where: { userId } }));
      await del('outcomeMart', () => tx.candidateOutcomeMart.deleteMany({ where: { userId } }));
      await del('matchMart', () => tx.candidateMatchMart.deleteMany({ where: { userId } }));
      await del('exportJobs', () => tx.exportJob.deleteMany({ where: { userId } }));
      await del('paymentMethods', () => tx.paymentMethod.deleteMany({ where: { userId } }));
      await del('billingProfiles', () => tx.billingProfile.deleteMany({ where: { userId } }));
      await del('customers', () => tx.customer.deleteMany({ where: { userId } }));
      await del('referralCodes', () => tx.referralCode.deleteMany({ where: { userId } }));

      // Another party's records: the identity is scrubbed, the record stays.
      await upd('cases', () => tx.case.updateMany({ where: { clientUserId: userId }, data: { invitedEmail: scrubbedEmail, invitedName: '' } }));
      await upd('representations', () => tx.representationConsent.updateMany({ where: { candidateUserId: userId }, data: { invitedEmail: scrubbedEmail, invitedName: '' } }));
      await upd('supportTickets', () => tx.supportTicket.updateMany({ where: { userId }, data: { email: scrubbedEmail, contextSnapshot: '{}' } }));
      await upd('memberships', () => tx.membership.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now, invitedEmail: null } }));
      const personal = await tx.membership.findMany({ where: { userId, role: 'owner', organization: { type: 'personal' } }, select: { organizationId: true } });
      await upd('workspaces', () => tx.organization.updateMany({ where: { id: { in: personal.map((m) => m.organizationId) } }, data: { name: 'Erased workspace', billingEmail: scrubbedEmail, status: 'canceled' } }));

      // The person, scrubbed in place. The password hash is replaced by a value
      // no password verifies against; the address by one that routes nowhere.
      await tx.user.update({
        where: { id: userId },
        data: { email: scrubbedEmail, fullName: 'Erased user', phone: null, city: null, headline: null, linkedinUrl: null, portfolioUrl: null, workAuth: null, passwordHash: `!erased:${randomBytes(24).toString('hex')}`, emailVerifiedAt: null, role: 'member', anonymizedAt: now, passwordChangedAt: now },
      });
      scrubbed.user = 1;
      if (request) await tx.deletionRequest.update({ where: { id: request.id }, data: { status: 'completed', completedAt: now, anonymizedAt: now } });
    },
    { timeout: 60_000 },
  );

  // 4. Files: the person's storage prefix (application folders, exports) and every document version's object.
  let filesRemoved = 0;
  try {
    const provider = await getStorageProvider();
    for (const v of versions) filesRemoved += (await provider.delete(v.storageKey)) ? 1 : 0;
    for (const e of exports) if (e.filePath) filesRemoved += (await provider.delete(e.filePath)) ? 1 : 0;
    filesRemoved += await provider.deletePrefix(`${userId}/`);
    if (request) await db.deletionRequest.update({ where: { id: request.id }, data: { purgedFolders: true } });
  } catch (error) {
    // The rows are gone; a storage failure is reported, never hidden, and the
    // request stays `purgedFolders: false` so the sweep retries the files.
    await recordSecurityEvent({ event: 'privacy.erased', actor: { type: 'system' }, entityType: 'User', entityId: userId, summary: 'Account erased; the object-store purge FAILED and will be retried by the sweep.', detail: { filesRemoved, storageError: true }, meta: options.meta });
    throw error;
  }

  await recordSecurityEvent({ event: 'privacy.erased', actor: { type: 'system' }, entityType: 'User', entityId: userId, summary: 'Account erased: personal tables deleted, the person scrubbed in place, files removed; statutory and other parties\' records retained with the identity removed.', detail: { ...Object.fromEntries(Object.entries(deleted).map(([k, v]) => [`deleted.${k}`, v])), ...Object.fromEntries(Object.entries(scrubbed).map(([k, v]) => [`scrubbed.${k}`, v])), filesRemoved }, meta: options.meta });
  return { userId, deleted, scrubbed, filesRemoved };
}

/** Retry the file purge for a completed request whose object-store step failed. */
export async function retryFilePurge(userId: string): Promise<number> {
  const provider = await getStorageProvider();
  const removed = await provider.deletePrefix(`${userId}/`);
  await db.deletionRequest.updateMany({ where: { userId, status: 'completed', purgedFolders: false }, data: { purgedFolders: true } });
  return removed;
}

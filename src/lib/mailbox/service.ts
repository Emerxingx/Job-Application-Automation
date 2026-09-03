import type { EmailThread, MailboxConnection, Prisma, CalendarEventRef } from '@prisma/client';
import { db } from '../db';
import { hasCurrentConsent, type ConsentPurpose } from '../consent';
import { hashEmail, recordSecurityEvent, type RequestMeta } from '../security-audit';
import { withTenant } from '../tenancy/context';
import { associateThread, detectSignals, type FolderCandidate, type ThreadFacts } from './associate';
import { decryptSecret, encryptSecret, MailboxKeyMissingError } from './crypto';
import { getMailboxConnector, MailboxNotConfiguredError } from './providers';
import type { ConnectionKind, EventSummary, MailboxProvider, ThreadSummary, TokenSet } from './providers/types';
import { SCOPE_INVENTORY } from './providers/types';
import { signOAuthState, verifyOAuthState } from './state';

/**
 * Stage 11 — connect, sync, associate, revoke.
 *
 * WHAT RUNS WHERE
 *   - Tokens: encrypted at rest in `MailboxSecret`, a system-only table. Only
 *     this module decrypts them, only on the system client, only to call the
 *     provider. They are never returned, logged or audited.
 *   - Derived rows (threads, message refs, calendar refs, integration events)
 *     are the applicant's own and are written on the TENANT path with their
 *     `userId`, so RLS backstops every write.
 *   - Bodies: never requested (metadata scopes), never stored, never passed
 *     on. The association and detection engines receive subjects,
 *     participants, dates and an invite flag; nothing in this module imports
 *     the AI gateway (a static test enforces it).
 *   - Revocation purges every derived row and the secret in one transaction
 *     and asks the provider to invalidate the grant (best effort); the purge
 *     does not depend on the provider answering.
 */
export class MailboxError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'MailboxError';
  }
}

export interface MailboxUser {
  id: string;
  email: string;
  role?: string;
}

/** How far back a sync looks; also the retention horizon for references (DATA_RETENTION_MATRIX). */
export const SYNC_WINDOW_DAYS = 180;

export function consentPurposeFor(kind: ConnectionKind): ConsentPurpose {
  return kind === 'mail' ? 'mailbox_sync' : 'calendar_sync';
}

function connectorFor(provider: MailboxProvider) {
  try {
    return getMailboxConnector(provider);
  } catch (error) {
    if (error instanceof MailboxNotConfiguredError) throw new MailboxError(error.message, 503);
    throw error;
  }
}

// --- connect ----------------------------------------------------------------------

/** Start the OAuth flow. Refused without the current consent for this kind. */
export async function beginConnection(user: MailboxUser, provider: MailboxProvider, kind: ConnectionKind, redirectUri: string): Promise<{ url: string }> {
  if (!(await hasCurrentConsent(db, user.id, consentPurposeFor(kind)))) throw new MailboxError(`Consent to ${kind === 'mail' ? 'mailbox' : 'calendar'} access is required before connecting.`, 403);
  const connector = connectorFor(provider);
  const state = signOAuthState({ userId: user.id, provider, kind });
  return { url: connector.authorizeUrl(kind, state, redirectUri) };
}

/**
 * Finish the OAuth flow: verify the signed state against the signed-in user,
 * exchange the code, refuse a grant that carries a content scope, encrypt the
 * tokens, record the connection against the consent that authorised it.
 */
export async function completeConnection(user: MailboxUser, params: { code: string; state: string; redirectUri: string }, meta?: RequestMeta): Promise<MailboxConnection> {
  const state = verifyOAuthState(params.state);
  if (!state || state.userId !== user.id) throw new MailboxError('This sign-in did not start from your account, or it has expired. Start again.', 403);
  const purpose = consentPurposeFor(state.kind);
  if (!(await hasCurrentConsent(db, user.id, purpose))) throw new MailboxError('Consent was withdrawn before the connection completed. Nothing was saved.', 403);
  const connector = connectorFor(state.provider);
  const tokens = await connector.exchangeCode(params.code, params.redirectUri);

  // Least privilege is enforced on what was GRANTED, not only on what was asked.
  const content = new Set(SCOPE_INVENTORY[state.provider][state.kind].content);
  if (tokens.scopes.some((s) => content.has(s))) {
    await connector.revoke(tokens).catch(() => undefined);
    throw new MailboxError('The grant included message content access, which this connection must not have. Nothing was saved; reconnect and accept only the requested permissions.', 422);
  }
  if (!tokens.accountEmail) throw new MailboxError('The provider did not identify the account. Nothing was saved.', 502);

  let secret;
  try {
    secret = encryptSecret(JSON.stringify(tokens));
  } catch (error) {
    if (error instanceof MailboxKeyMissingError) throw new MailboxError('This deployment cannot store mailbox tokens (no encryption key is configured). Nothing was saved.', 503);
    throw error;
  }
  const consent = await db.consentRecord.findFirst({ where: { userId: user.id, purpose, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  const accountEmail = tokens.accountEmail.toLowerCase();
  const connection = await db.$transaction(async (tx) => {
    const row = await tx.mailboxConnection.upsert({
      where: { userId_provider_kind_accountEmail: { userId: user.id, provider: state.provider, kind: state.kind, accountEmail } },
      create: { userId: user.id, provider: state.provider, kind: state.kind, accountEmail, scopes: JSON.stringify(tokens.scopes), status: 'connected', consentId: consent?.id ?? null },
      update: { scopes: JSON.stringify(tokens.scopes), status: 'connected', consentId: consent?.id ?? null, errorCode: null, revokedAt: null, connectedAt: new Date() },
    });
    await tx.mailboxSecret.upsert({ where: { connectionId: row.id }, create: { connectionId: row.id, ...secret }, update: { ...secret } });
    return row;
  });
  await recordSecurityEvent({
    event: 'mailbox.connected',
    user,
    entityType: 'MailboxConnection',
    entityId: connection.id,
    summary: `${state.provider} ${state.kind} connected with metadata scopes.`,
    detail: { provider: state.provider, kind: state.kind, scopes: tokens.scopes.join(' '), accountDigest: hashEmail(accountEmail), consentId: consent?.id ?? null },
    meta,
  });
  return connection;
}

// --- sync -------------------------------------------------------------------------

export interface SyncResult {
  threads: number;
  newThreads: number;
  auto: number;
  pending: number;
  calendarEvents: number;
  integrationEvents: number;
}

type Tx = Prisma.TransactionClient;

/** The folders a thread can be filed into: applications the employer has (or is about to have), with their contacts. Tenant path. */
export async function loadFolders(tx: Tx, userId: string): Promise<FolderCandidate[]> {
  const rows = await tx.application.findMany({
    where: { userId, status: { in: ['ready_to_submit', 'submitted', 'interviewing', 'offer'] } },
    include: { job: { select: { company: true, normalizedCompany: true, title: true } }, contacts: { select: { email: true } } },
  });
  return rows.map((a) => ({
    applicationId: a.id,
    company: a.job.company,
    normalizedCompany: a.job.normalizedCompany || a.job.company.toLowerCase(),
    jobTitle: a.job.title,
    contactEmails: a.contacts.map((c) => c.email?.toLowerCase() ?? '').filter(Boolean),
    appliedAt: a.appliedAt,
    atsVendor: a.atsVendor,
  }));
}

async function emit(tx: Tx, userId: string, connectionId: string, type: 'EMAIL_RECEIVED' | 'INTERVIEW_DETECTED' | 'OFFER_RECEIVED', ids: { threadId?: string | null; calendarEventId?: string | null; applicationId?: string | null }): Promise<void> {
  await tx.integrationEvent.create({ data: { userId, connectionId, type, threadId: ids.threadId ?? null, applicationId: ids.applicationId ?? null, payload: JSON.stringify(ids) } });
}

const filed = (status: string) => status === 'auto' || status === 'confirmed';

async function upsertThread(tx: Tx, connection: MailboxConnection, summary: ThreadSummary, folders: FolderCandidate[], result: SyncResult): Promise<EmailThread> {
  const facts: ThreadFacts = { subject: summary.subject, participants: summary.participants.map((p) => p.toLowerCase()), from: summary.from.toLowerCase(), lastMessageAt: summary.lastMessageAt, hasCalendarInvite: summary.hasCalendarInvite };
  const association = associateThread(facts, folders);
  const detection = detectSignals(facts);
  const existing = await tx.emailThread.findUnique({ where: { connectionId_providerThreadId: { connectionId: connection.id, providerThreadId: summary.providerThreadId } } });
  // The applicant's own decision is never overwritten by a re-sync.
  const decided = existing !== null && (existing.associationStatus === 'confirmed' || existing.associationStatus === 'rejected');
  const data = {
    userId: connection.userId,
    connectionId: connection.id,
    providerThreadId: summary.providerThreadId,
    subject: summary.subject.slice(0, 500),
    participants: JSON.stringify(facts.participants),
    fromAddress: facts.from,
    lastMessageAt: facts.lastMessageAt,
    hasCalendarInvite: facts.hasCalendarInvite,
    interviewDetected: detection.interview,
    offerDetected: detection.offer,
    ...(decided
      ? {}
      : {
          applicationId: association.applicationId,
          rivalApplicationId: association.rivalApplicationId,
          confidence: association.confidence,
          associationStatus: association.status,
          associatedBy: association.status === 'none' ? null : 'system',
          signals: JSON.stringify(association.signals),
        }),
  };
  const row = existing ? await tx.emailThread.update({ where: { id: existing.id }, data }) : await tx.emailThread.create({ data });
  for (const m of summary.messages) {
    await tx.emailMessageRef.upsert({
      where: { threadId_providerMessageId: { threadId: row.id, providerMessageId: m.providerMessageId } },
      create: { userId: connection.userId, threadId: row.id, providerMessageId: m.providerMessageId, fromAddress: m.from.toLowerCase(), sentAt: m.sentAt, direction: m.direction },
      update: {},
    });
  }
  result.threads += 1;
  if (!existing) {
    result.newThreads += 1;
    if (row.associationStatus === 'auto') result.auto += 1;
    if (row.associationStatus === 'pending') result.pending += 1;
    await emit(tx, connection.userId, connection.id, 'EMAIL_RECEIVED', { threadId: row.id, applicationId: row.applicationId });
    result.integrationEvents += 1;
  }
  // Detections fire once, and only for a thread that is filed (auto or confirmed) — never for a pending guess.
  if (filed(row.associationStatus)) {
    if (detection.interview && !(existing?.interviewDetected && filed(existing.associationStatus))) {
      await emit(tx, connection.userId, connection.id, 'INTERVIEW_DETECTED', { threadId: row.id, applicationId: row.applicationId });
      result.integrationEvents += 1;
    }
    if (detection.offer && !(existing?.offerDetected && filed(existing.associationStatus))) {
      await emit(tx, connection.userId, connection.id, 'OFFER_RECEIVED', { threadId: row.id, applicationId: row.applicationId });
      result.integrationEvents += 1;
    }
  }
  return row;
}

async function upsertEvent(tx: Tx, connection: MailboxConnection, event: EventSummary, folders: FolderCandidate[], result: SyncResult): Promise<void> {
  const facts: ThreadFacts = { subject: event.title, participants: [...new Set([event.organiser, ...event.attendees].map((p) => p.toLowerCase()).filter(Boolean))], from: event.organiser.toLowerCase(), lastMessageAt: event.startsAt, hasCalendarInvite: true };
  const association = associateThread(facts, folders);
  const existing = await tx.calendarEventRef.findUnique({ where: { connectionId_providerEventId: { connectionId: connection.id, providerEventId: event.providerEventId } } });
  const decided = existing !== null && (existing.associationStatus === 'confirmed' || existing.associationStatus === 'rejected');
  const data = {
    userId: connection.userId,
    connectionId: connection.id,
    providerEventId: event.providerEventId,
    title: event.title.slice(0, 500),
    organiser: facts.from,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    attendees: JSON.stringify(facts.participants),
    ...(decided ? {} : { applicationId: association.applicationId, confidence: association.confidence, associationStatus: association.status, signals: JSON.stringify(association.signals) }),
  };
  const row = existing ? await tx.calendarEventRef.update({ where: { id: existing.id }, data }) : await tx.calendarEventRef.create({ data });
  result.calendarEvents += 1;
  // An invite fires INTERVIEW_DETECTED once, on the sync that FILES it —
  // its first sync or a later one (a contact added to the folder since) —
  // never for a pending guess; a confirmation fires it in decideEventAssociation.
  if (filed(row.associationStatus) && !(existing && filed(existing.associationStatus))) {
    await emit(tx, connection.userId, connection.id, 'INTERVIEW_DETECTED', { calendarEventId: row.id, applicationId: row.applicationId });
    result.integrationEvents += 1;
  }
}

/**
 * Sync one connection over the window. Tokens are decrypted on the system
 * client and used only here; derived rows are written on the tenant path.
 * A provider failure marks the connection `error` with a stable code and
 * rethrows — nothing is half-written outside its own transaction.
 */
export async function syncConnection(connectionId: string, options: { now?: Date } = {}): Promise<SyncResult> {
  const connection = await db.mailboxConnection.findUnique({ where: { id: connectionId }, include: { secret: true } });
  if (!connection || connection.status !== 'connected' || !connection.secret) throw new MailboxError('That connection is not active.', 404);
  const connector = connectorFor(connection.provider as MailboxProvider);
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - SYNC_WINDOW_DAYS * 86400_000);
  const result: SyncResult = { threads: 0, newThreads: 0, auto: 0, pending: 0, calendarEvents: 0, integrationEvents: 0 };
  try {
    let tokens = JSON.parse(decryptSecret(connection.secret)) as TokenSet;
    if (tokens.expiresAt && new Date(tokens.expiresAt).getTime() < now.getTime() + 60_000) {
      tokens = await connector.refresh(tokens);
      await db.mailboxSecret.update({ where: { connectionId }, data: encryptSecret(JSON.stringify(tokens)) });
    }
    const folders = await withTenant({ userId: connection.userId }, (tx) => loadFolders(tx, connection.userId));
    let cursor: string | null = null;
    if (connection.kind === 'mail') {
      do {
        const page = await connector.listThreads(tokens, cursor, since);
        for (const t of page.items) await withTenant({ userId: connection.userId }, (tx) => upsertThread(tx, connection, t, folders, result));
        cursor = page.cursor;
      } while (cursor);
    } else {
      do {
        const page = await connector.listEvents(tokens, cursor, since);
        for (const e of page.items) await withTenant({ userId: connection.userId }, (tx) => upsertEvent(tx, connection, e, folders, result));
        cursor = page.cursor;
      } while (cursor);
    }
    await db.mailboxConnection.update({ where: { id: connectionId }, data: { lastSyncAt: now, errorCode: null } });
  } catch (error) {
    await db.mailboxConnection.update({ where: { id: connectionId }, data: { errorCode: error instanceof MailboxError ? 'refused' : 'provider_error' } }).catch(() => undefined);
    throw error;
  }
  await recordSecurityEvent({ event: 'mailbox.synced', actor: { type: 'system' }, entityType: 'MailboxConnection', entityId: connectionId, summary: `${connection.provider} ${connection.kind} synced.`, detail: { ...result, userId: connection.userId } });
  return result;
}

/** Drop references older than the window — the retention limit, applied on every sync of the account and by the operator's sweep. */
export async function pruneReferences(userId: string, now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() - SYNC_WINDOW_DAYS * 86400_000);
  const threads = await db.emailThread.deleteMany({ where: { userId, lastMessageAt: { lt: horizon }, associationStatus: { in: ['none', 'rejected', 'pending'] } } });
  const events = await db.calendarEventRef.deleteMany({ where: { userId, startsAt: { lt: horizon }, associationStatus: { in: ['none', 'rejected', 'pending'] } } });
  return threads.count + events.count;
}

// --- the applicant's decision -----------------------------------------------------

/** Confirm (into a folder) or reject a thread's association. The decision sticks across re-syncs. */
export async function decideThreadAssociation(user: MailboxUser, threadId: string, decision: 'confirm' | 'reject', applicationId: string | null = null, meta?: RequestMeta): Promise<EmailThread> {
  const row = await withTenant({ userId: user.id }, async (tx) => {
    const thread = await tx.emailThread.findFirst({ where: { id: threadId, userId: user.id } });
    if (!thread) throw new MailboxError('Thread not found.', 404);
    if (decision === 'reject') {
      return tx.emailThread.update({ where: { id: thread.id }, data: { applicationId: null, rivalApplicationId: null, associationStatus: 'rejected', associatedBy: 'applicant' } });
    }
    const target = applicationId ?? thread.applicationId;
    if (!target) throw new MailboxError('Choose the application this thread belongs to.');
    const application = await tx.application.findFirst({ where: { id: target, userId: user.id }, select: { id: true } });
    if (!application) throw new MailboxError('Application not found.', 404);
    const updated = await tx.emailThread.update({ where: { id: thread.id }, data: { applicationId: target, rivalApplicationId: null, associationStatus: 'confirmed', associatedBy: 'applicant' } });
    // A confirmation files the thread: its detections now count.
    if (!filed(thread.associationStatus)) {
      if (updated.interviewDetected) await emit(tx, user.id, thread.connectionId, 'INTERVIEW_DETECTED', { threadId: updated.id, applicationId: target });
      if (updated.offerDetected) await emit(tx, user.id, thread.connectionId, 'OFFER_RECEIVED', { threadId: updated.id, applicationId: target });
    }
    return updated;
  });
  await recordSecurityEvent({ event: decision === 'confirm' ? 'mailbox.thread.confirmed' : 'mailbox.thread.rejected', user, entityType: 'EmailThread', entityId: row.id, summary: decision === 'confirm' ? 'Thread filed by the applicant.' : 'Thread association rejected by the applicant.', detail: { applicationId: row.applicationId }, meta });
  return row;
}

/** Confirm (into a folder) or reject a calendar event's association — the same rules as a thread. A confirmation files the invite, so it fires INTERVIEW_DETECTED once. */
export async function decideEventAssociation(user: MailboxUser, eventId: string, decision: 'confirm' | 'reject', applicationId: string | null = null, meta?: RequestMeta): Promise<CalendarEventRef> {
  const row = await withTenant({ userId: user.id }, async (tx) => {
    const event = await tx.calendarEventRef.findFirst({ where: { id: eventId, userId: user.id } });
    if (!event) throw new MailboxError('Event not found.', 404);
    if (decision === 'reject') {
      return tx.calendarEventRef.update({ where: { id: event.id }, data: { applicationId: null, associationStatus: 'rejected' } });
    }
    const target = applicationId ?? event.applicationId;
    if (!target) throw new MailboxError('Choose the application this event belongs to.');
    const application = await tx.application.findFirst({ where: { id: target, userId: user.id }, select: { id: true } });
    if (!application) throw new MailboxError('Application not found.', 404);
    const updated = await tx.calendarEventRef.update({ where: { id: event.id }, data: { applicationId: target, associationStatus: 'confirmed' } });
    if (!filed(event.associationStatus)) await emit(tx, user.id, event.connectionId, 'INTERVIEW_DETECTED', { calendarEventId: updated.id, applicationId: target });
    return updated;
  });
  await recordSecurityEvent({ event: decision === 'confirm' ? 'mailbox.event.confirmed' : 'mailbox.event.rejected', user, entityType: 'CalendarEventRef', entityId: row.id, summary: decision === 'confirm' ? 'Calendar event filed by the applicant.' : 'Calendar event association rejected by the applicant.', detail: { applicationId: row.applicationId }, meta });
  return row;
}

// --- revoke -----------------------------------------------------------------------

export interface PurgeCounts {
  threads: number;
  messages: number;
  calendarEvents: number;
  integrationEvents: number;
  secret: number;
}

/**
 * Revoke a connection: ask the provider to invalidate the grant (best
 * effort), then — in one transaction — delete the secret and every derived
 * row and mark the connection revoked. Nothing derived survives.
 */
export async function revokeConnection(user: MailboxUser, connectionId: string, meta?: RequestMeta): Promise<PurgeCounts> {
  const connection = await db.mailboxConnection.findFirst({ where: { id: connectionId, userId: user.id }, include: { secret: true } });
  if (!connection) throw new MailboxError('Connection not found.', 404);
  if (connection.secret) {
    try {
      const tokens = JSON.parse(decryptSecret(connection.secret)) as TokenSet;
      await connectorFor(connection.provider as MailboxProvider).revoke(tokens);
    } catch (error) {
      console.error(`[mailbox] provider revocation for ${connection.id} failed; purging anyway:`, error instanceof Error ? error.message : error);
    }
  }
  const counts = await db.$transaction(async (tx) => {
    const threadIds = (await tx.emailThread.findMany({ where: { connectionId: connection.id }, select: { id: true } })).map((t) => t.id);
    const messages = await tx.emailMessageRef.deleteMany({ where: { threadId: { in: threadIds } } });
    const integrationEvents = await tx.integrationEvent.deleteMany({ where: { connectionId: connection.id } });
    const threads = await tx.emailThread.deleteMany({ where: { connectionId: connection.id } });
    const calendarEvents = await tx.calendarEventRef.deleteMany({ where: { connectionId: connection.id } });
    const secret = await tx.mailboxSecret.deleteMany({ where: { connectionId: connection.id } });
    await tx.mailboxConnection.update({ where: { id: connection.id }, data: { status: 'revoked', revokedAt: new Date(), cursor: null, errorCode: null } });
    return { threads: threads.count, messages: messages.count, calendarEvents: calendarEvents.count, integrationEvents: integrationEvents.count, secret: secret.count };
  });
  await recordSecurityEvent({ event: 'mailbox.revoked', user, entityType: 'MailboxConnection', entityId: connection.id, summary: `${connection.provider} ${connection.kind} revoked; derived content purged.`, detail: { provider: connection.provider, kind: connection.kind, ...counts }, meta });
  return counts;
}

/** The applicant's connections, on the tenant path; the secret table has no tenant policy and is never included. */
export async function listConnections(tx: Tx, userId: string): Promise<MailboxConnection[]> {
  return tx.mailboxConnection.findMany({ where: { userId }, orderBy: [{ status: 'asc' }, { connectedAt: 'desc' }] });
}

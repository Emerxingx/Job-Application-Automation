/**
 * Stage 11 — connect, sync, associate, revoke against the database, with the
 * fixture-backed connector.
 *
 * Proves: a connection needs the consent and stores its tokens encrypted
 * (the row is unreadable without the key and unreadable on the tenant path
 * at all); a grant carrying a content scope is refused and nothing is
 * saved; without an encryption key nothing is saved; a sync files the corpus
 * as labelled, emits EMAIL_RECEIVED per thread and detections only for filed
 * threads, and is idempotent; the applicant's decision sticks across
 * re-syncs and fires the detections it unlocks; another tenant sees nothing;
 * revocation purges every derived row and the secret and says how many;
 * audit rows carry digests and counts, never a subject or an address.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Service = typeof import('../src/lib/mailbox/service');
type Registry = typeof import('../src/lib/mailbox/providers');
type Mock = typeof import('../src/lib/mailbox/providers/mock');
type State = typeof import('../src/lib/mailbox/state');
type Crypto = typeof import('../src/lib/mailbox/crypto');
type Consent = typeof import('../src/lib/consent');
type Ctx = typeof import('../src/lib/tenancy/context');
type ThreadSummary = import('../src/lib/mailbox/providers/types').ThreadSummary;
type EventSummary = import('../src/lib/mailbox/providers/types').EventSummary;

interface Corpus {
  applicant: string;
  folders: { applicationId: string; company: string; normalizedCompany: string; jobTitle: string; contactEmails: string[]; appliedAt: string | null; atsVendor: string | null }[];
  threads: { id: string; subject: string; from: string; participants: string[]; lastMessageAt: string; hasCalendarInvite: boolean; expected: string | null; status: 'auto' | 'pending' | 'none'; interview: boolean; offer: boolean }[];
}
const corpus = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'mailbox-corpus.json'), 'utf8')) as Corpus;
const KEY = Buffer.alloc(32, 42).toString('base64');
const S = randomBytes(4).toString('hex');
const A = { id: `mb_a_${S}`, email: corpus.applicant.replace('@', `+${S}@`) };
const B = { id: `mb_b_${S}`, email: `mb-b-${S}@mail.test` };
let db: Db;
let service: Service;
let registry: Registry;
let mock: Mock;
let state: State;
let crypto: Crypto;
let consent: Consent;
let ctx: Ctx;
const appIds = new Map<string, string>();
let connectionId: string;
let calendarConnectionId: string | undefined;
let threads: ThreadSummary[] = [];

describe('Stage 11 — mailbox intelligence against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    process.env.MAILBOX_ENCRYPTION_KEY = KEY;
    ({ db } = await import('../src/lib/db'));
    service = await import('../src/lib/mailbox/service');
    registry = await import('../src/lib/mailbox/providers');
    mock = await import('../src/lib/mailbox/providers/mock');
    state = await import('../src/lib/mailbox/state');
    crypto = await import('../src/lib/mailbox/crypto');
    consent = await import('../src/lib/consent');
    ctx = await import('../src/lib/tenancy/context');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Mailbox', country: 'CA' } });
    // The corpus's three folders, as real applications with their contacts.
    for (const f of corpus.folders) {
      const job = await db.job.create({ data: { source: 'mock', externalId: `mb-${S}-${f.applicationId}`, title: f.jobTitle, company: f.company, normalizedCompany: f.normalizedCompany, location: 'Toronto, ON', description: 'x', postedAt: new Date('2026-08-01T00:00:00Z') } });
      const app = await db.application.create({ data: { userId: A.id, jobId: job.id, status: 'submitted', appliedAt: f.appliedAt ? new Date(f.appliedAt) : null, atsVendor: f.atsVendor } });
      for (const email of f.contactEmails) await db.applicationContact.create({ data: { userId: A.id, applicationId: app.id, role: 'recruiter', name: 'Contact', email } });
      appIds.set(f.applicationId, app.id);
    }
    threads = corpus.threads.map((t) => ({ providerThreadId: t.id, subject: t.subject, participants: t.participants, from: t.from, lastMessageAt: new Date(t.lastMessageAt), hasCalendarInvite: t.hasCalendarInvite, messages: [{ providerMessageId: `${t.id}-m1`, from: t.from, sentAt: new Date(t.lastMessageAt), direction: t.from === corpus.applicant ? 'outbound' : 'inbound' }] }));
    registry.setMailboxConnectorForTests('google', new mock.MockMailboxConnector('google', { accountEmail: corpus.applicant, threads, events: [] }));
  });
  after(async () => {
    registry.setMailboxConnectorForTests('google', null);
    delete process.env.MAILBOX_ENCRYPTION_KEY;
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: [A.id, B.id] } }, { entityType: 'MailboxConnection', entityId: { in: [connectionId ?? '', calendarConnectionId ?? ''] } }] } });
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.job.deleteMany({ where: { externalId: { startsWith: `mb-${S}` } } });
    await db.$disconnect();
  });

  const NOW = new Date('2026-09-03T12:00:00Z');

  it('refuses to start without consent; connects with metadata scopes; stores the tokens encrypted and unreadable on the tenant path', async () => {
    await assert.rejects(() => service.beginConnection(A, 'google', 'mail', 'https://app.test/api/mailbox/callback'), /Consent to mailbox access is required/);
    await consent.grantConsent(db, A, 'mailbox_sync', { source: 'test' });
    const { url } = await service.beginConnection(A, 'google', 'mail', 'https://app.test/api/mailbox/callback');
    assert.ok(url.includes('gmail.metadata') && !url.includes('readonly'), url);
    const signed = new URL(url).searchParams.get('state')!;
    // A state signed for someone else is refused.
    const foreign = state.signOAuthState({ userId: B.id, provider: 'google', kind: 'mail' });
    await assert.rejects(() => service.completeConnection(A, { code: 'mock-code:mail', state: foreign, redirectUri: 'x' }), /did not start from your account/);
    const connection = await service.completeConnection(A, { code: 'mock-code:mail', state: signed, redirectUri: 'x' });
    connectionId = connection.id;
    assert.equal(connection.status, 'connected');
    assert.deepEqual(JSON.parse(connection.scopes), ['https://www.googleapis.com/auth/gmail.metadata']);
    assert.ok(connection.consentId, 'bound to the consent that authorised it');
    const secret = await db.mailboxSecret.findUniqueOrThrow({ where: { connectionId: connection.id } });
    assert.ok(!secret.ciphertext.includes('mock-access') && !secret.ciphertext.includes('mock-refresh'), 'not in the clear');
    assert.ok(crypto.decryptSecret(secret).includes('mock-refresh-google'), 'decryptable with the key');
    assert.deepEqual(await ctx.withTenant({ userId: A.id }, (tx) => tx.mailboxSecret.findMany()), [], 'the tenant role cannot read secrets at all');
    const audit = await db.auditLog.findFirst({ where: { action: 'mailbox.connected', entityId: connection.id } });
    assert.ok(audit && !audit.after.includes(corpus.applicant) && audit.after.includes('gmail.metadata'), 'the audit carries scopes and a digest, not the address');
  });

  it('refuses a grant that carries a content scope, and refuses to store anything without an encryption key', async () => {
    const greedy = new mock.MockMailboxConnector('google', { accountEmail: 'greedy@example.test', threads: [], events: [] });
    greedy.exchangeCode = async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: null, scopes: ['Mail.ReadBasic', 'Mail.Read', 'offline_access'], accountEmail: 'greedy@example.test' });
    registry.setMailboxConnectorForTests('microsoft', greedy);
    await consent.grantConsent(db, A, 'calendar_sync', { source: 'test' });
    const s1 = state.signOAuthState({ userId: A.id, provider: 'microsoft', kind: 'mail' });
    await assert.rejects(() => service.completeConnection(A, { code: 'mock-code:mail', state: s1, redirectUri: 'x' }), /message content access/);
    assert.equal(greedy.revoked, 1, 'the over-broad grant is revoked at the provider');
    assert.equal(await db.mailboxConnection.count({ where: { userId: A.id, provider: 'microsoft' } }), 0);
    registry.setMailboxConnectorForTests('microsoft', new mock.MockMailboxConnector('microsoft', { accountEmail: 'k@example.test', threads: [], events: [] }));
    const saved = process.env.MAILBOX_ENCRYPTION_KEY;
    delete process.env.MAILBOX_ENCRYPTION_KEY;
    try {
      const s2 = state.signOAuthState({ userId: A.id, provider: 'microsoft', kind: 'mail' });
      await assert.rejects(() => service.completeConnection(A, { code: 'mock-code:mail', state: s2, redirectUri: 'x' }), /no encryption key/);
      assert.equal(await db.mailboxConnection.count({ where: { userId: A.id, provider: 'microsoft' } }), 0, 'nothing saved');
    } finally {
      process.env.MAILBOX_ENCRYPTION_KEY = saved;
      registry.setMailboxConnectorForTests('microsoft', null);
    }
  });

  it('a sync files the corpus as labelled, emits events only as promised, and is idempotent', async () => {
    const first = await service.syncConnection(connectionId, { now: NOW });
    assert.equal(first.threads, corpus.threads.length);
    assert.equal(first.newThreads, corpus.threads.length);
    const rows = await db.emailThread.findMany({ where: { connectionId } });
    for (const t of corpus.threads) {
      const row = rows.find((r) => r.providerThreadId === t.id)!;
      const expectedApp = t.status === 'none' ? null : appIds.get(t.expected!)!;
      assert.equal(row.associationStatus, t.status, `${t.id} status`);
      assert.equal(row.applicationId, expectedApp, `${t.id} folder`);
      assert.equal(row.interviewDetected, t.interview, `${t.id} interview`);
      assert.equal(row.offerDetected, t.offer, `${t.id} offer`);
      assert.equal(row.userId, A.id);
    }
    assert.equal(first.auto, corpus.threads.filter((t) => t.status === 'auto').length);
    assert.equal(first.pending, corpus.threads.filter((t) => t.status === 'pending').length);
    const events = await db.integrationEvent.findMany({ where: { connectionId } });
    assert.equal(events.filter((e) => e.type === 'EMAIL_RECEIVED').length, corpus.threads.length);
    const filedInterviews = corpus.threads.filter((t) => t.status === 'auto' && t.interview).length;
    const filedOffers = corpus.threads.filter((t) => t.status === 'auto' && t.offer).length;
    assert.equal(events.filter((e) => e.type === 'INTERVIEW_DETECTED').length, filedInterviews, 'detections fire only for filed threads (a dentist invite files nowhere)');
    assert.equal(events.filter((e) => e.type === 'OFFER_RECEIVED').length, filedOffers);
    assert.ok(events.every((e) => !e.payload.includes('@') && !/offer letter/i.test(e.payload)), 'events carry ids only');
    // Idempotent: a second sync adds nothing.
    const second = await service.syncConnection(connectionId, { now: NOW });
    assert.equal(second.newThreads, 0);
    assert.equal(await db.integrationEvent.count({ where: { connectionId } }), events.length);
    assert.equal(await db.emailMessageRef.count({ where: { userId: A.id } }), corpus.threads.length);
  });

  it('the applicant\'s decision sticks across re-syncs and unlocks the detections it files', async () => {
    const pending = await db.emailThread.findFirst({ where: { connectionId, providerThreadId: 't13' } });
    assert.ok(pending && pending.associationStatus === 'pending' && pending.rivalApplicationId);
    const before = await db.integrationEvent.count({ where: { connectionId, type: 'INTERVIEW_DETECTED' } });
    const confirmed = await service.decideThreadAssociation(A, pending.id, 'confirm', appIds.get('app_birch')!);
    assert.equal(confirmed.associationStatus, 'confirmed');
    assert.equal(confirmed.rivalApplicationId, null);
    const rejectedRow = await db.emailThread.findFirst({ where: { connectionId, providerThreadId: 't12' } });
    await service.decideThreadAssociation(A, rejectedRow!.id, 'reject');
    // t25 — "Interview request" from the employer's domain, nothing else: pending, so its detection waited. Confirming files it and fires INTERVIEW_DETECTED once.
    const t25 = await db.emailThread.findFirst({ where: { connectionId, providerThreadId: 't25' } });
    assert.ok(t25 && t25.associationStatus === 'pending' && t25.interviewDetected, 'the corpus carries a pending thread with an interview subject');
    assert.equal(await db.integrationEvent.count({ where: { connectionId, type: 'INTERVIEW_DETECTED', threadId: t25.id } }), 0, 'nothing fired while pending');
    await service.decideThreadAssociation(A, t25.id, 'confirm', appIds.get('app_birch')!);
    assert.equal(await db.integrationEvent.count({ where: { connectionId, type: 'INTERVIEW_DETECTED', threadId: t25.id } }), 1, 'confirmation unlocked the detection');
    // A pending thread with an interview subject fires INTERVIEW_DETECTED only once confirmed.
    const t02 = await db.emailThread.findFirst({ where: { connectionId, providerThreadId: 't02' } });
    assert.equal(t02!.associationStatus, 'auto');
    await service.syncConnection(connectionId, { now: NOW });
    const after = await db.emailThread.findFirst({ where: { id: pending.id } });
    assert.equal(after!.associationStatus, 'confirmed', 'the decision survives a re-sync');
    assert.equal((await db.emailThread.findFirst({ where: { id: rejectedRow!.id } }))!.associationStatus, 'rejected');
    assert.equal(await db.integrationEvent.count({ where: { connectionId, type: 'INTERVIEW_DETECTED' } }), before + 1, 't13 has no interview subject and t25 fired exactly once; the re-sync added nothing');
    await assert.rejects(() => service.decideThreadAssociation(B, pending.id, 'reject'), /not found/, 'another tenant cannot decide');
    await assert.rejects(() => service.decideThreadAssociation(A, pending.id, 'confirm', 'not-mine'), /Application not found/);
  });

  it('calendar events file above the threshold, surface as suggestions below it, and fire INTERVIEW_DETECTED once — when filed, whenever that is', async () => {
    const at = (iso: string) => new Date(iso);
    const events: EventSummary[] = [
      // A known recruiter's invite naming the role: filed on its first sync.
      { providerEventId: 'e1', title: 'Interview — Senior Data Analyst', organiser: 'riley@mapleanalytics.ca', startsAt: at('2026-08-26T15:00:00Z'), endsAt: at('2026-08-26T15:45:00Z'), attendees: ['riley@mapleanalytics.ca', corpus.applicant] },
      // The employer's domain and nothing else: a suggestion, never filed by itself.
      { providerEventId: 'e2', title: 'Quick chat', organiser: 'hr@birchfinancial.com', startsAt: at('2026-08-27T16:00:00Z'), endsAt: at('2026-08-27T16:30:00Z'), attendees: ['hr@birchfinancial.com', corpus.applicant] },
      // An agency's invite naming the role: too weak today; filed once the agency contact is on the folder.
      { providerEventId: 'e3', title: 'Reporting Analyst — screening call', organiser: 'sam@talentbridge.io', startsAt: at('2026-08-30T14:00:00Z'), endsAt: at('2026-08-30T14:30:00Z'), attendees: ['sam@talentbridge.io', corpus.applicant] },
      { providerEventId: 'e4', title: 'Dental cleaning', organiser: 'front@smiledental.ca', startsAt: at('2026-08-31T09:00:00Z'), endsAt: at('2026-08-31T09:30:00Z'), attendees: [corpus.applicant] },
    ];
    registry.setMailboxConnectorForTests('google', new mock.MockMailboxConnector('google', { accountEmail: corpus.applicant, threads, events }));
    const { url } = await service.beginConnection(A, 'google', 'calendar', 'https://app.test/api/mailbox/callback');
    assert.ok(url.includes('calendar.events.readonly'));
    const signed = new URL(url).searchParams.get('state')!;
    const cal = await service.completeConnection(A, { code: 'mock-code:calendar', state: signed, redirectUri: 'x' });
    calendarConnectionId = cal.id;
    const first = await service.syncConnection(cal.id, { now: NOW });
    assert.equal(first.calendarEvents, 4);
    const rows = await db.calendarEventRef.findMany({ where: { connectionId: cal.id } });
    const row = (id: string) => rows.find((r) => r.providerEventId === id)!;
    assert.equal(row('e1').associationStatus, 'auto');
    assert.equal(row('e1').applicationId, appIds.get('app_maple'));
    assert.equal(row('e2').associationStatus, 'pending');
    assert.equal(row('e2').applicationId, appIds.get('app_birch'));
    assert.equal(row('e3').associationStatus, 'none');
    assert.equal(row('e4').associationStatus, 'none');
    const detected = () => db.integrationEvent.count({ where: { connectionId: cal.id, type: 'INTERVIEW_DETECTED' } });
    assert.equal(await detected(), 1, 'only the filed invite fires');
    // The pending invite is a suggestion on the folder — visible on the tenant path, decided by the applicant.
    const suggestions = await ctx.withTenant({ userId: A.id }, (tx) => tx.calendarEventRef.findMany({ where: { userId: A.id, associationStatus: 'pending', applicationId: appIds.get('app_birch') } }));
    assert.deepEqual(suggestions.map((s) => s.providerEventId), ['e2']);
    const confirmed = await service.decideEventAssociation(A, row('e2').id, 'confirm', appIds.get('app_birch')!);
    assert.equal(confirmed.associationStatus, 'confirmed');
    assert.equal(await detected(), 2, 'the confirmation fires the detection once');
    await service.syncConnection(cal.id, { now: NOW });
    assert.equal(await detected(), 2, 'a re-sync fires nothing again');
    assert.equal((await db.calendarEventRef.findUniqueOrThrow({ where: { id: row('e2').id } })).associationStatus, 'confirmed', 'the decision survives a re-sync');
    await assert.rejects(() => service.decideEventAssociation(B, row('e2').id, 'reject'), /not found/, 'another tenant cannot decide');
    await assert.rejects(() => service.decideEventAssociation(A, row('e4').id, 'confirm', 'not-mine'), /Application not found/);
    // An invite that only becomes filable later — the agency contact is added to the Cedar folder — fires on the sync that files it, not never.
    await db.applicationContact.create({ data: { userId: A.id, applicationId: appIds.get('app_cedar')!, role: 'recruiter', name: 'Contact', email: 'sam@talentbridge.io' } });
    await service.syncConnection(cal.id, { now: NOW });
    const e3 = await db.calendarEventRef.findUniqueOrThrow({ where: { id: row('e3').id } });
    assert.equal(e3.associationStatus, 'auto');
    assert.equal(e3.applicationId, appIds.get('app_cedar'));
    assert.equal(await detected(), 3, 'filed on a later sync — fired then');
    const audit = await db.auditLog.findFirst({ where: { action: 'mailbox.event.confirmed', entityId: row('e2').id } });
    assert.ok(audit && !audit.after.includes('Quick chat') && !audit.after.includes('@'), 'the audit carries ids, never a title or an address');
  });

  it('another tenant sees nothing on the tenant path', async () => {
    assert.deepEqual(await ctx.withTenant({ userId: B.id }, (tx) => tx.emailThread.findMany({ where: { userId: A.id } })), []);
    assert.deepEqual(await ctx.withTenant({ userId: B.id }, (tx) => tx.mailboxConnection.findMany({ where: { userId: A.id } })), []);
    assert.deepEqual(await ctx.withTenant({ userId: B.id }, (tx) => tx.integrationEvent.findMany({ where: { userId: A.id } })), []);
    const mine = await ctx.withTenant({ userId: A.id }, (tx) => service.listConnections(tx, A.id));
    assert.equal(mine.length, 2, 'the mail and the calendar connection');
    assert.ok(mine.every((c) => !('secret' in c)), 'a listing never carries the secret');
  });

  it('revocation purges every derived row and the secret, marks the connection revoked, and audits the counts without content', async () => {
    const threads = await db.emailThread.count({ where: { connectionId } });
    const messages = await db.emailMessageRef.count({ where: { userId: A.id } });
    const events = await db.integrationEvent.count({ where: { connectionId } });
    assert.ok(threads > 0 && messages > 0 && events > 0);
    const purged = await service.revokeConnection(A, connectionId);
    assert.deepEqual(purged, { threads, messages, calendarEvents: 0, integrationEvents: events, secret: 1 });
    assert.equal(await db.emailThread.count({ where: { connectionId } }), 0);
    assert.equal(await db.emailMessageRef.count({ where: { userId: A.id } }), 0);
    assert.equal(await db.integrationEvent.count({ where: { connectionId } }), 0);
    assert.equal(await db.mailboxSecret.count({ where: { connectionId } }), 0);
    const connection = await db.mailboxConnection.findUniqueOrThrow({ where: { id: connectionId } });
    assert.equal(connection.status, 'revoked');
    assert.ok(connection.revokedAt);
    await assert.rejects(() => service.syncConnection(connectionId, { now: NOW }), /not active/);
    const audit = await db.auditLog.findMany({ where: { entityType: { in: ['MailboxConnection', 'EmailThread'] }, entityId: { in: [connectionId] } } });
    const blob = audit.map((a) => `${a.summary} ${a.after}`).join('\n');
    assert.ok(audit.some((a) => a.action === 'mailbox.revoked' && a.after.includes(`"threads":${threads}`)));
    for (const secret of [corpus.applicant, 'Offer letter', 'mapleanalytics', 'mock-refresh']) assert.ok(!blob.includes(secret), `audit carries content: ${secret}`);
  });
});

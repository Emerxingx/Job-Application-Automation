/**
 * Stage 11 — association and detection on the labelled corpus, the scope
 * inventory, and token encryption. Pure: no database, no network, no bodies.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AMBIGUITY_MARGIN, associateThread, AUTO_THRESHOLD, detectSignals, PENDING_THRESHOLD, type FolderCandidate, type ThreadFacts } from '../src/lib/mailbox/associate';
import { decryptSecret, encryptSecret, mailboxKey, MailboxKeyMissingError } from '../src/lib/mailbox/crypto';
import { requestedScopes, SCOPE_INVENTORY } from '../src/lib/mailbox/providers/types';
import { MockMailboxConnector } from '../src/lib/mailbox/providers/mock';

interface Corpus {
  applicant: string;
  folders: (Omit<FolderCandidate, 'appliedAt'> & { appliedAt: string | null })[];
  threads: (Omit<ThreadFacts, 'lastMessageAt'> & { id: string; lastMessageAt: string; expected: string | null; status: 'auto' | 'pending' | 'none'; interview: boolean; offer: boolean })[];
}
const corpus = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'mailbox-corpus.json'), 'utf8')) as Corpus;
const folders: FolderCandidate[] = corpus.folders.map((f) => ({ ...f, appliedAt: f.appliedAt ? new Date(f.appliedAt) : null }));

describe('mailbox — association on the labelled corpus', () => {
  it('files every thread as labelled: auto only above the threshold with no rival, pending when unsure, none otherwise', () => {
    let autoTp = 0;
    let autoFp = 0;
    let autoFn = 0;
    const failures: string[] = [];
    for (const t of corpus.threads) {
      const thread: ThreadFacts = { subject: t.subject, participants: t.participants, from: t.from, lastMessageAt: new Date(t.lastMessageAt), hasCalendarInvite: t.hasCalendarInvite };
      const a = associateThread(thread, folders);
      const got = `${a.status}:${a.applicationId ?? '-'}`;
      const want = `${t.status}:${t.status === 'none' ? '-' : t.expected}`;
      if (got !== want) failures.push(`${t.id} "${t.subject}" → ${got} (${a.confidence}, ${a.signals.map((s) => s.name).join('+')}) expected ${want}`);
      if (a.status === 'auto') {
        assert.ok(a.confidence >= AUTO_THRESHOLD && !a.rivalApplicationId, t.id);
        if (a.applicationId === t.expected) autoTp += 1;
        else autoFp += 1;
      } else if (t.expected && t.status === 'auto') autoFn += 1;
      if (a.status === 'pending') assert.ok(a.confidence >= PENDING_THRESHOLD, t.id);
      if (a.status === 'none') assert.ok(a.applicationId === null);
    }
    assert.deepEqual(failures, []);
    const precision = autoTp / (autoTp + autoFp);
    const recall = autoTp / (autoTp + autoFn);
    assert.equal(precision, 1, `auto-filing precision ${precision}`);
    assert.equal(recall, 1, `auto-filing recall ${recall}`);
    assert.ok(corpus.threads.filter((t) => t.status === 'auto').length >= 12 && corpus.threads.filter((t) => t.status === 'none').length >= 8, 'the corpus carries both kinds');
  });
  it('a low-confidence match is never auto-filed, a near-tie is pending with its rival named, and a pre-application thread is penalised', () => {
    const tie = associateThread({ subject: 'Data Analyst opportunity', from: 'no-reply@hire.lever.co', participants: ['no-reply@hire.lever.co', corpus.applicant], lastMessageAt: new Date('2026-08-27T08:00:00Z'), hasCalendarInvite: false }, folders);
    assert.equal(tie.status, 'pending');
    assert.ok(tie.rivalApplicationId, 'two folders scored within the margin');
    assert.ok(tie.confidence >= PENDING_THRESHOLD && tie.confidence < AUTO_THRESHOLD + AMBIGUITY_MARGIN);
    const lookalike = associateThread({ subject: 'Open house this weekend', from: 'sales@maplewoodcondos.ca', participants: ['sales@maplewoodcondos.ca', corpus.applicant], lastMessageAt: new Date('2026-08-29T08:00:00Z'), hasCalendarInvite: false }, folders);
    assert.equal(lookalike.status, 'none', 'a domain that merely starts with the company token is not the company');
    const early = associateThread({ subject: 'Maple Analytics newsletter', from: 'news@mapleanalytics.ca', participants: ['news@mapleanalytics.ca', corpus.applicant], lastMessageAt: new Date('2026-08-01T08:00:00Z'), hasCalendarInvite: false }, folders);
    assert.ok(early.signals.some((s) => s.name === 'before_application' && s.weight < 0));
    assert.equal(early.status, 'none');
  });
  it('a job title with no distinctive word ("PM") is never counted as named by a subject', () => {
    const folder: FolderCandidate = { applicationId: 'a', company: 'Acme', normalizedCompany: 'acme', jobTitle: 'PM', contactEmails: ['riley@gmail.com'], appliedAt: new Date('2026-08-01T00:00:00Z'), atsVendor: null };
    const thread: ThreadFacts = { subject: 'Lunch?', participants: ['riley@gmail.com', 'pat@gmail.com'], from: 'riley@gmail.com', lastMessageAt: new Date('2026-08-10T00:00:00Z'), hasCalendarInvite: false };
    const a = associateThread(thread, [folder]);
    assert.ok(!a.signals.some((s) => s.name === 'subject_title'), 'an empty word list must not satisfy "every word is in the subject"');
    assert.equal(a.status, 'pending', `contact address alone is a suggestion, not a filing (${a.confidence})`);
  });

  it('detects interviews and offers from the subject and an invite — never from a body, which it does not receive', () => {
    for (const t of corpus.threads) {
      const d = detectSignals({ subject: t.subject, participants: t.participants, from: t.from, lastMessageAt: new Date(t.lastMessageAt), hasCalendarInvite: t.hasCalendarInvite });
      assert.equal(d.interview, t.interview, `${t.id} interview`);
      assert.equal(d.offer, t.offer, `${t.id} offer`);
    }
    assert.equal(detectSignals({ subject: 'Special offer: 20% off', participants: [], from: 'promo@x.com', lastMessageAt: new Date(), hasCalendarInvite: false }).offer, false);
  });
});

describe('mailbox — scope inventory', () => {
  it('a connection requests metadata scopes only; content scopes are listed but never requested', () => {
    assert.deepEqual([...requestedScopes('google', 'mail')], ['https://www.googleapis.com/auth/gmail.metadata']);
    assert.deepEqual([...requestedScopes('microsoft', 'mail')], ['Mail.ReadBasic', 'offline_access']);
    assert.deepEqual([...requestedScopes('google', 'calendar')], ['https://www.googleapis.com/auth/calendar.events.readonly']);
    assert.deepEqual([...requestedScopes('microsoft', 'calendar')], ['Calendars.Read', 'offline_access']);
    for (const provider of ['google', 'microsoft'] as const) {
      for (const kind of ['mail', 'calendar'] as const) {
        const { metadata, content } = SCOPE_INVENTORY[provider][kind];
        for (const c of content) assert.ok(!metadata.includes(c), `${provider} ${kind}: ${c} must not be requested`);
      }
    }
    const url = new MockMailboxConnector('google').authorizeUrl('mail', 'state-1', 'https://app.test/cb');
    assert.ok(url.includes(encodeURIComponent('gmail.metadata')) && !url.includes('readonly'));
  });
});

describe('mailbox — token encryption at rest', () => {
  it('accepts a 32-byte key as base64 or as 64 hex characters, and nothing else', () => {
    assert.equal(mailboxKey({ MAILBOX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') })?.length, 32);
    assert.equal(mailboxKey({ MAILBOX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('hex') })?.length, 32);
    assert.equal(mailboxKey({ MAILBOX_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('hex') }), null);
    assert.equal(mailboxKey({ MAILBOX_ENCRYPTION_KEY: 'not-a-key' }), null);
    assert.equal(mailboxKey({}), null);
  });

  const key = Buffer.alloc(32, 7);
  it('round-trips under AES-256-GCM, refuses a tampered ciphertext, and refuses to store anything without a key', () => {
    const secret = encryptSecret('{"accessToken":"a","refreshToken":"r"}', key);
    assert.equal(decryptSecret(secret, key), '{"accessToken":"a","refreshToken":"r"}');
    assert.equal(secret.keyVersion, 1);
    assert.notEqual(encryptSecret('x', key).iv, encryptSecret('x', key).iv, 'a fresh IV every time');
    const flipped = Buffer.from(secret.ciphertext, 'base64');
    flipped[0] ^= 0xff;
    assert.throws(() => decryptSecret({ ...secret, ciphertext: flipped.toString('base64') }, key));
    assert.throws(() => decryptSecret(secret, Buffer.alloc(32, 8)));
    assert.throws(() => encryptSecret('x', null), MailboxKeyMissingError);
    const env = (v: Record<string, string>) => v as NodeJS.ProcessEnv;
    assert.equal(mailboxKey(env({})), null);
    assert.equal(mailboxKey(env({ MAILBOX_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })), null, 'a short key is no key');
    assert.equal(mailboxKey(env({ MAILBOX_ENCRYPTION_KEY: key.toString('base64') }))?.length, 32);
  });
});

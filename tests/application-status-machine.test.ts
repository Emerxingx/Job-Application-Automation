/**
 * Stage 10 — the application status machine and the folder completeness
 * checklist, pure parts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPLICATION_STATUSES, APPLICANT_STATUSES, canTransition, describeRefusal, isTerminal, outcomeFor, TRANSITIONS } from '../src/lib/applications/status-machine';
import { folderCompleteness, type FolderFacts } from '../src/lib/applications/folder';
import type { ApplicationStatus } from '../src/lib/types';
import { offerSchema } from '../src/lib/applications/schemas';

describe('application status machine', () => {
  it('lists every status exactly once and every target is a known status', () => {
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...APPLICATION_STATUSES].sort());
    for (const targets of Object.values(TRANSITIONS)) for (const t of targets) assert.ok(APPLICATION_STATUSES.includes(t), t);
  });
  it('allows the honest moves and refuses the rest', () => {
    const allowed: [ApplicationStatus, ApplicationStatus][] = [
      ['queued', 'applying'], ['queued', 'failed'], ['queued', 'withdrawn'],
      ['applying', 'submitted'], ['applying', 'ready_to_submit'], ['applying', 'failed'],
      ['ready_to_submit', 'submitted'], ['ready_to_submit', 'withdrawn'],
      ['submitted', 'interviewing'], ['submitted', 'offer'], ['submitted', 'rejected'], ['submitted', 'withdrawn'],
      ['failed', 'queued'], ['failed', 'withdrawn'],
      ['interviewing', 'offer'], ['interviewing', 'rejected'], ['interviewing', 'withdrawn'],
      ['offer', 'interviewing'], ['offer', 'rejected'], ['offer', 'withdrawn'],
    ];
    for (const [from, to] of allowed) assert.ok(canTransition(from, to), `${from} → ${to}`);
    const refused: [ApplicationStatus, ApplicationStatus][] = [
      ['queued', 'interviewing'], ['queued', 'submitted'], ['applying', 'interviewing'], ['ready_to_submit', 'interviewing'], ['ready_to_submit', 'rejected'],
      ['failed', 'submitted'], ['failed', 'interviewing'], ['rejected', 'interviewing'], ['rejected', 'submitted'], ['withdrawn', 'submitted'], ['withdrawn', 'queued'],
      ['submitted', 'queued'], ['interviewing', 'submitted'], ['offer', 'submitted'],
    ];
    for (const [from, to] of refused) assert.ok(!canTransition(from, to), `${from} → ${to} must be refused`);
    // Every allowed pair is in the table and nothing else is.
    const total = Object.values(TRANSITIONS).reduce((n, t) => n + t.length, 0);
    assert.equal(total, allowed.length);
  });
  it('terminal statuses never move; the applicant records only post-submission statuses; outcomes settle on rejected and withdrawn', () => {
    assert.ok(isTerminal('rejected') && isTerminal('withdrawn'));
    assert.deepEqual(TRANSITIONS.rejected, []);
    assert.deepEqual(TRANSITIONS.withdrawn, []);
    assert.deepEqual([...APPLICANT_STATUSES], ['interviewing', 'offer', 'rejected', 'withdrawn']);
    assert.equal(outcomeFor('rejected'), 'rejected');
    assert.equal(outcomeFor('withdrawn'), 'withdrawn');
    assert.equal(outcomeFor('interviewing'), null);
  });
  it('explains a refusal in words', () => {
    assert.match(describeRefusal('queued', 'interviewing'), /has not reached the employer/);
    assert.match(describeRefusal('ready_to_submit', 'interviewing'), /confirm it first/);
    assert.match(describeRefusal('rejected', 'interviewing'), /cannot change again/);
    assert.match(describeRefusal('offer', 'offer'), /already at offer/);
  });
});

describe('folder completeness', () => {
  const base: FolderFacts = { status: 'submitted', appliedAt: new Date('2026-09-01T10:00:00Z'), applyChannel: 'assisted', confirmation: null, company: 'Maple Analytics', sealedDocuments: 6, hasTextCopies: true, contacts: 1, historyEntries: 2, interviews: 0, assessments: 0, followUps: 0, outcome: 'pending', respondedAt: null };
  it('a submitted folder with sealed files, a known employer, a date and a channel answers four of five; a response answers the fifth', () => {
    const c = folderCompleteness(base);
    assert.equal(c.answered, 4);
    assert.equal(c.complete, false);
    assert.deepEqual(c.answers.filter((a) => !a.ok).map((a) => a.question), ['what_happened']);
    assert.match(c.answers.find((a) => a.question === 'what_happened')!.detail, /no response recorded yet/);
    const done = folderCompleteness({ ...base, status: 'interviewing', interviews: 1, historyEntries: 3, respondedAt: new Date() });
    assert.equal(done.complete, true);
    assert.match(done.answers.find((a) => a.question === 'what_happened')!.detail, /1 interview, outcome pending, 3 status changes/);
  });
  it('an unsent folder says so rather than claiming a sent record; an undisclosed employer is not "to whom"', () => {
    const c = folderCompleteness({ ...base, status: 'ready_to_submit', appliedAt: null, sealedDocuments: 0, historyEntries: 1 });
    assert.equal(c.answers.find((a) => a.question === 'what_was_sent')!.ok, false);
    assert.match(c.answers.find((a) => a.question === 'what_was_sent')!.detail, /prepared, not sent yet/);
    assert.match(c.answers.find((a) => a.question === 'when')!.detail, /not sent yet/);
    assert.equal(c.answers.find((a) => a.question === 'how')!.ok, false, 'assisted without confirmation is not a sent channel');
    const u = folderCompleteness({ ...base, company: 'Undisclosed employer' });
    assert.equal(u.answers.find((a) => a.question === 'to_whom')!.ok, false);
    const noDocs = folderCompleteness({ ...base, sealedDocuments: 0, hasTextCopies: true });
    assert.equal(noDocs.answers.find((a) => a.question === 'what_was_sent')!.ok, true, 'the database copies still answer it for a sent application');
    assert.match(noDocs.answers.find((a) => a.question === 'what_was_sent')!.detail, /no sealed files/);
  });
});

describe('offer input', () => {
  it('bounds the salary to the column and orders the range', () => {
    assert.ok(offerSchema.safeParse({ salaryMin: 110000, salaryMax: 120000, decision: 'pending' }).success);
    // The columns are PostgreSQL integers: an overflow is refused at the edge as a 400, never a 500 from the database.
    assert.ok(!offerSchema.safeParse({ salaryMin: 99_999_999_999, decision: 'pending' }).success, 'an integer overflow must be refused');
    assert.ok(!offerSchema.safeParse({ salaryMin: 120000, salaryMax: 110000 }).success, 'a minimum above the maximum must be refused');
    assert.ok(offerSchema.safeParse({ salaryMin: 120000, salaryMax: null }).success, 'an open-ended range is fine');
    assert.ok(!offerSchema.safeParse({ salaryMin: -1 }).success);
  });
});

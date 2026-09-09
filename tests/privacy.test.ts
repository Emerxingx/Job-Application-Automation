/**
 * Stage 23 (ADR-0037) - erasure, retention and the health check against the
 * database: a scheduled erasure waits out its grace period and can be
 * cancelled; execution deletes the person's own tables and files, scrubs the
 * person in place, revokes sessions and keys, leaves the statutory and other
 * parties' records with the identity removed, refuses to run twice, and
 * writes an audit row with counts only; the retention sweep removes exactly
 * what the matrix expires and nothing newer; the health check answers
 * without a session and names no host.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Erasure = typeof import('../src/lib/privacy/erasure');
type Retention = typeof import('../src/lib/privacy/retention');
type Storage = typeof import('../src/lib/storage');
type Health = typeof import('../src/app/(app)/api/health/route');

const S = randomBytes(4).toString('hex');
const d = (s: string) => new Date(s);
const E = { id: `pv_e_${S}`, email: `pv-e-${S}@pv.test` };
const K = { id: `pv_k_${S}`, email: `pv-k-${S}@pv.test` }; // a person who is NOT erased: nothing of theirs may move
const ORG = `pv_org_${S}`;
const PERSONAL = `pv_personal_${S}`;
let db: Db;
let erasure: Erasure;
let retention: Retention;
let storage: Storage;
let health: Health;
let root = '';
let planId = '';
let invoiceId = '';
let paymentId = '';
let placementId = '';
let caseId = '';
let submittedKey = '';

describe('Stage 23 - erasure, retention and health against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    root = mkdtempSync(path.join(os.tmpdir(), 'jp-privacy-'));
    process.env.STORAGE_ROOT = root;
    process.env.STORAGE_PROVIDER = 'local';
    ({ db } = await import('../src/lib/db'));
    storage = await import('../src/lib/storage');
    storage.resetStorageProviderForTests();
    erasure = await import('../src/lib/privacy/erasure');
    retention = await import('../src/lib/privacy/retention');
    health = await import('../src/app/(app)/api/health/route');

    for (const u of [E, K]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u === E ? 'Erased Person' : 'Kept Person', phone: '+1 604 555 0100', city: 'Vancouver', country: 'CA', headline: 'Analyst' } });
    await db.organization.create({ data: { id: PERSONAL, name: 'Erased Person', slug: `pv-personal-${S}`, type: 'personal', billingEmail: E.email, memberships: { create: [{ userId: E.id, role: 'owner', acceptedAt: d('2026-01-01T00:00:00Z') }] } } });
    await db.organization.create({ data: { id: ORG, name: 'Provider', slug: `pv-org-${S}`, type: 'service_provider', billingEmail: K.email, memberships: { create: [{ userId: K.id, role: 'owner', acceptedAt: d('2026-01-01T00:00:00Z') }] } } });

    for (const u of [E, K]) {
      await db.session.create({ data: { userId: u.id, expiresAt: d('2027-01-01T00:00:00Z') } });
      await db.apiKey.create({ data: { userId: u.id, prefix: `jp_${S}_${u === E ? 'e' : 'k'}`, keyHash: `h_${S}_${u.id}`, kind: 'device' } });
      await db.userIdentity.create({ data: { userId: u.id, provider: 'supabase', subject: `sub_${S}_${u.id}`, email: u.email } });
      await db.resume.create({ data: { userId: u.id, content: '{}', rawText: 'Jane Doe, 604 555 0100' } });
      await db.candidateProfile.create({ data: { userId: u.id } });
      await db.careerEvidence.create({ data: { userId: u.id, kind: 'achievement', sourceType: 'self', claim: 'Led a team' } });
      await db.agent.create({ data: { userId: u.id, name: 'a', keywords: '[]', locations: '[]' } });
      await db.notification.create({ data: { userId: u.id, type: 'info', title: 'hello' } });
      await db.consentRecord.create({ data: { userId: u.id, purpose: 'terms_of_service', version: '1' } });
      await db.aiRun.create({ data: { userId: u.id, task: 'tailor', policyState: 'EXTERNAL_AI_PROHIBITED', route: 'deterministic', provider: 'deterministic' } });
    }
    // The erased person's application with a SUBMITTED document version and its file.
    const job = await db.job.create({ data: { source: 'mock', externalId: `pv-${S}`, title: 'Analyst', company: 'Acme', location: 'Vancouver, BC', country: 'CA', description: 'x', postedAt: d('2026-08-01T00:00:00Z') } });
    const app = await db.application.create({ data: { userId: E.id, jobId: job.id, status: 'submitted', folderPath: `${E.id}/applications/2026-08/acme` } });
    await db.applicationNote.create({ data: { userId: E.id, applicationId: app.id, body: 'called the recruiter' } });
    submittedKey = `${E.id}/documents/resume-v1.txt`;
    mkdirSync(path.join(root, E.id, 'documents'), { recursive: true });
    mkdirSync(path.join(root, E.id, 'applications', '2026-08', 'acme'), { recursive: true });
    writeFileSync(path.join(root, submittedKey), 'Jane Doe resume');
    writeFileSync(path.join(root, E.id, 'applications', '2026-08', 'acme', 'cover.txt'), 'cover');
    await db.documentVersion.create({ data: { userId: E.id, applicationId: app.id, scopeKey: app.id, kind: 'resume', format: 'txt', version: 1, contentHash: 'h', sizeBytes: 15, storageKey: submittedKey, status: 'submitted' } });
    // Statutory: an invoice and a payment (RESTRICT).
    const plan = await db.plan.create({ data: { code: `pv-${S}`, name: 'PV', tagline: 't', monthlyPriceCents: 2900, quarterlyPriceCents: 7800, annualPriceCents: 29000, applicationsPerMonth: 10, maxAgents: 1 } });
    planId = plan.id;
    invoiceId = (await db.invoice.create({ data: { userId: E.id, status: 'paid', currency: 'CAD', totalCents: 2900, amountPaidCents: 2900, billToSnapshot: JSON.stringify({ name: 'Erased Person' }), planCode: plan.code, planName: 'PV', issuedAt: d('2026-07-05T00:00:00Z'), paidAt: d('2026-07-05T00:00:00Z') } })).id;
    paymentId = (await db.payment.create({ data: { userId: E.id, provider: 'manual', externalId: `pv-pay-${S}`, status: 'succeeded', amountCents: 2900, currency: 'CAD', succeededAt: d('2026-07-05T00:00:00Z') } })).id;
    await db.billingProfile.create({ data: { userId: E.id, legalName: 'Erased Person', billingEmail: E.email, line1: '1 Main St' } });
    const ticket = await db.supportTicket.create({ data: { number: `TKT-PV-${S}`, userId: E.id, email: E.email, subject: 'help', contextSnapshot: JSON.stringify({ email: E.email }), satisfactionComment: 'thanks, Erased Person' } });
    // Stage 23 review (H3): the tables the first version never touched.
    await db.supportMessage.create({ data: { ticketId: ticket.id, authorType: 'customer', authorUserId: E.id, authorName: E.email, body: 'my salary expectation is 90k, call me at 604 555 0100', attachments: JSON.stringify([{ name: 'payslip.pdf', path: `${E.id}/uploads/payslip.pdf`, bytes: 10 }]) } });
    await db.applicationQuestion.create({ data: { userId: E.id, key: 'salary', question: 'Salary expectation?', category: 'compensation', answer: '90,000 CAD' } });
    await db.webhookEndpoint.create({ data: { userId: E.id, url: 'https://hooks.example/erased', secret: 'enc:x', events: '["*"]' } });
    await db.outboundEvent.create({ data: { userId: E.id, type: 'application.submitted', payload: JSON.stringify({ applicant: 'Erased Person' }) } });
    await db.apiIdempotencyRecord.create({ data: { userId: E.id, key: `idem-${S}`, method: 'POST', path: '/api/apply', requestHash: 'h', status: 'completed', responseBody: JSON.stringify({ name: 'Erased Person' }), expiresAt: d('2027-01-01T00:00:00Z') } });
    const code = await db.referralCode.create({ data: { userId: K.id, code: `PV${S.toUpperCase()}` } });
    await db.referral.create({ data: { codeId: code.id, referrerUserId: K.id, refereeUserId: E.id, refereeEmail: E.email, ip: '203.0.113.5', status: 'signed_up' } });
    await db.auditLog.create({ data: { actorType: 'user', actorId: E.id, actorEmail: E.email, action: 'auth.login.succeeded', entityType: 'User', entityId: E.id, summary: 'Signed in.', ip: '203.0.113.5', userAgent: 'pv-test' } });
    // Another party's records: a service provider's case, an agency's representation and a placement (RESTRICT).
    caseId = (await db.case.create({ data: { organizationId: ORG, invitedEmail: E.email, invitedName: 'Erased Person', clientUserId: E.id, status: 'open', openedAt: d('2026-08-01T00:00:00Z'), createdById: K.id } })).id;
    const contract = await db.clientContract.create({ data: { organizationId: ORG, clientName: 'Acme', jurisdiction: 'CA-BC', status: 'active', createdById: K.id } });
    const fee = await db.feeStructure.create({ data: { organizationId: ORG, contractId: contract.id, name: '20%', kind: 'percent', percentBps: 2000, createdById: K.id } });
    const eng = await db.engagement.create({ data: { organizationId: ORG, contractId: contract.id, feeStructureId: fee.id, title: 'Ops', jurisdiction: 'CA-BC', status: 'open', createdById: K.id } });
    const rc = await db.representationConsent.create({ data: { organizationId: ORG, engagementId: eng.id, invitedEmail: E.email, invitedName: 'Erased Person', candidateUserId: E.id, status: 'granted', requestedById: K.id } });
    placementId = (await db.placement.create({ data: { organizationId: ORG, engagementId: eng.id, candidateUserId: E.id, representationConsentId: rc.id, startDate: d('2026-09-01T00:00:00Z'), salaryCents: 9_000_000, feeCents: 1_800_000, guaranteeDays: 90, guaranteeEndsAt: d('2026-11-30T00:00:00Z'), status: 'started', createdById: K.id } })).id;
  });

  after(async () => {
    await db.organization.deleteMany({ where: { id: { in: [ORG, PERSONAL] } } });
    await db.payment.deleteMany({ where: { userId: { in: [E.id, K.id] } } });
    await db.invoice.deleteMany({ where: { userId: { in: [E.id, K.id] } } });
    if (planId) await db.plan.deleteMany({ where: { id: planId } });
    await db.supportTicket.deleteMany({ where: { number: `TKT-PV-${S}` } });
    await db.job.deleteMany({ where: { externalId: `pv-${S}` } });
    await db.user.deleteMany({ where: { id: { in: [E.id, K.id] } } });
    await db.$disconnect();
  });

  it('a request is scheduled fourteen days out, is idempotent, can be cancelled, and refuses to run before the grace period ends', async () => {
    const now = d('2026-09-05T12:00:00Z');
    const first = await erasure.requestErasure(E, { now, reason: 'leaving' });
    assert.equal(first.status, 'scheduled');
    assert.equal(first.scheduledFor?.toISOString(), '2026-09-19T12:00:00.000Z');
    const again = await erasure.requestErasure(E, { now: d('2026-09-06T12:00:00Z') });
    assert.equal(again.scheduledFor?.toISOString(), '2026-09-19T12:00:00.000Z', 'a second request does not move the date');
    await assert.rejects(erasure.executeErasure(E.id, { now: d('2026-09-10T00:00:00Z') }), /grace period has not ended/);
    assert.deepEqual(await erasure.dueErasures(d('2026-09-10T00:00:00Z')), []);
    const cancelled = await erasure.cancelErasure(E, { now: d('2026-09-07T00:00:00Z') });
    assert.equal(cancelled.status, 'canceled');
    await assert.rejects(erasure.cancelErasure(E), /No erasure is scheduled/);
    await assert.rejects(erasure.executeErasure(E.id, { now: d('2026-10-01T00:00:00Z') }), /No erasure is scheduled/);
    // Nothing happened to the person meanwhile.
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: E.id } })).fullName, 'Erased Person');
    assert.ok((await db.auditLog.count({ where: { action: 'privacy.erasure.requested', entityType: 'DeletionRequest', actorId: E.id } })) >= 1, 'the request is audited for THIS person');
  });

  it('the only owner of a non-personal organisation cannot request erasure until it is handed over (review L10)', async () => {
    const sole = await db.organization.create({ data: { id: `pv_sole_${S}`, name: 'Sole', slug: `pv-sole-${S}`, type: 'employer', billingEmail: E.email, memberships: { create: [{ userId: E.id, role: 'owner', acceptedAt: d('2026-01-01T00:00:00Z') }] } } });
    await assert.rejects(erasure.requestErasure(E), /Transfer ownership of 1 organisation/);
    await db.membership.create({ data: { organizationId: sole.id, userId: K.id, role: 'owner', acceptedAt: d('2026-01-01T00:00:00Z') } });
    await assert.doesNotReject(async () => {
      await erasure.requestErasure(E, { now: d('2026-09-05T12:00:00Z') });
      await erasure.cancelErasure(E, { now: d('2026-09-05T12:01:00Z') });
    }, 'a second owner lifts the blocker');
    await db.organization.delete({ where: { id: sole.id } });
  });

  it('a live subscription blocks the request', async () => {
    await db.subscription.create({ data: { userId: E.id, planId, status: 'active', currency: 'CAD', mrrCents: 2900, renewsAt: d('2026-10-05T00:00:00Z'), periodEnd: d('2026-10-05T00:00:00Z') } });
    await assert.rejects(erasure.requestErasure(E), /Cancel your subscription/);
    await db.subscription.deleteMany({ where: { userId: E.id } });
  });

  it('executing the erasure deletes the person\'s own tables and files, scrubs the person, and leaves statutory and other parties\' records with the identity removed', async () => {
    const requested = d('2026-09-05T12:00:00Z');
    await erasure.requestErasure(E, { now: requested });
    const due = d('2026-09-20T00:00:00Z');
    assert.deepEqual(await erasure.dueErasures(due), [E.id]);
    // Stage 23 review (M1): a subscription taken out during the grace period defers the execution; the request stays scheduled.
    await db.subscription.create({ data: { userId: E.id, planId, status: 'active', currency: 'CAD', mrrCents: 2900, renewsAt: d('2026-10-05T00:00:00Z'), periodEnd: d('2026-10-05T00:00:00Z') } });
    await assert.rejects(erasure.executeErasure(E.id, { now: due }), /Cancel your subscription/);
    assert.equal((await erasure.erasureStatus(E.id)).status, 'scheduled');
    assert.ok(await db.auditLog.findFirst({ where: { action: 'privacy.erasure.deferred' } }), 'the deferral is audited');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: E.id } })).fullName, 'Erased Person', 'nothing was erased');
    await db.subscription.deleteMany({ where: { userId: E.id } });
    const report = await erasure.executeErasure(E.id, { now: due });
    assert.equal(report.deleted.applications, 1);
    assert.equal(report.deleted.applicationQuestions, 1);
    assert.equal(report.deleted.webhookEndpoints, 1);
    assert.equal(report.deleted.outboundEvents, 1);
    assert.equal(report.deleted.idempotencyRecords, 1);
    assert.equal(report.scrubbed.supportMessages, 1);
    assert.equal(report.scrubbed.referrals, 1);
    assert.ok(report.scrubbed.auditRows! >= 1);
    assert.equal(report.filesRetained, 0);
    assert.equal(report.deleted.sessions, 1);
    assert.equal(report.deleted.apiKeys, 1);
    assert.equal(report.deleted.resumes, 1);
    assert.equal(report.deleted.careerEvidence, 1);
    assert.equal(report.deleted.aiRuns, 1);
    assert.equal(report.scrubbed.cases, 1);
    assert.equal(report.scrubbed.representations, 1);
    assert.equal(report.scrubbed.supportTickets, 1);
    assert.equal(report.scrubbed.memberships, 1);
    assert.ok(report.filesRemoved >= 2, 'the submitted document and the application folder file');

    const user = await db.user.findUniqueOrThrow({ where: { id: E.id } });
    assert.equal(user.email, `erased-${E.id}@erased.invalid`);
    assert.equal(user.fullName, 'Erased user');
    assert.equal(user.phone, null);
    assert.equal(user.city, null);
    assert.equal(user.headline, null);
    assert.ok(user.passwordHash.startsWith('!erased:'));
    assert.ok(user.anonymizedAt);
    for (const [table, count] of [
      ['session', await db.session.count({ where: { userId: E.id } })],
      ['apiKey', await db.apiKey.count({ where: { userId: E.id } })],
      ['userIdentity', await db.userIdentity.count({ where: { userId: E.id } })],
      ['resume', await db.resume.count({ where: { userId: E.id } })],
      ['candidateProfile', await db.candidateProfile.count({ where: { userId: E.id } })],
      ['careerEvidence', await db.careerEvidence.count({ where: { userId: E.id } })],
      ['agent', await db.agent.count({ where: { userId: E.id } })],
      ['application', await db.application.count({ where: { userId: E.id } })],
      ['applicationNote', await db.applicationNote.count({ where: { userId: E.id } })],
      ['documentVersion (submitted, through the cascade)', await db.documentVersion.count({ where: { userId: E.id } })],
      ['notification', await db.notification.count({ where: { userId: E.id } })],
      ['aiRun', await db.aiRun.count({ where: { userId: E.id } })],
      ['billingProfile', await db.billingProfile.count({ where: { userId: E.id } })],
      ['applicationQuestion', await db.applicationQuestion.count({ where: { userId: E.id } })],
      ['webhookEndpoint', await db.webhookEndpoint.count({ where: { userId: E.id } })],
      ['outboundEvent', await db.outboundEvent.count({ where: { userId: E.id } })],
      ['apiIdempotencyRecord', await db.apiIdempotencyRecord.count({ where: { userId: E.id } })],
    ] as const) assert.equal(count, 0, `${table} rows of the erased person remain`);
    assert.ok(!existsSync(path.join(root, submittedKey)), 'the submitted résumé file is gone');
    assert.ok(!existsSync(path.join(root, E.id)), 'the person\'s storage prefix is gone');

    // Statutory and evidentiary rows stay, pointing at the scrubbed row.
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).userId, E.id);
    assert.equal((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).userId, E.id);
    assert.equal(await db.consentRecord.count({ where: { userId: E.id } }), 1, 'the consent record is evidence');
    // Other parties' records keep their ids only.
    const kase = await db.case.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(kase.invitedEmail, `erased-${E.id}@erased.invalid`);
    assert.equal(kase.invitedName, '');
    assert.equal(kase.clientUserId, E.id);
    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } });
    assert.equal(placement.candidateUserId, E.id);
    const rep = await db.representationConsent.findFirstOrThrow({ where: { candidateUserId: E.id } });
    assert.equal(rep.invitedName, '');
    const ticket = await db.supportTicket.findUniqueOrThrow({ where: { number: `TKT-PV-${S}` } });
    assert.equal(ticket.email, `erased-${E.id}@erased.invalid`);
    assert.equal(ticket.contextSnapshot, '{}');
    assert.equal(ticket.satisfactionComment, null);
    const message = await db.supportMessage.findFirstOrThrow({ where: { ticketId: ticket.id } });
    assert.equal(message.authorUserId, E.id, 'the message row stays for the support record');
    assert.ok(!message.body.includes('90k') && !message.authorName.includes('@') && message.attachments === '[]', 'its content is gone');
    const referral = await db.referral.findFirstOrThrow({ where: { refereeUserId: E.id } });
    assert.equal(referral.refereeEmail, null);
    assert.equal(referral.ip, null);
    const ownRows = await db.auditLog.findMany({ where: { actorId: E.id } });
    assert.ok(ownRows.length >= 1, 'the audit rows stay');
    for (const row of ownRows) {
      assert.equal(row.actorEmail, `erased-${E.id}@erased.invalid`, 'the actor address is scrubbed');
      assert.equal(row.ip, null);
      assert.equal(row.userAgent, null);
    }
    assert.equal(await db.auditLog.count({ where: { actorId: E.id, action: 'auth.login.succeeded' } }), 1, 'no audit row is deleted');
    const membership = await db.membership.findFirstOrThrow({ where: { userId: E.id, organizationId: PERSONAL } });
    assert.ok(membership.removedAt);
    assert.equal((await db.organization.findUniqueOrThrow({ where: { id: PERSONAL } })).name, 'Erased workspace');
    const request = await db.deletionRequest.findUniqueOrThrow({ where: { userId: E.id } });
    assert.equal(request.status, 'completed');
    assert.ok(request.anonymizedAt && request.purgedFolders);
    const audit = await db.auditLog.findFirst({ where: { action: 'privacy.erased', entityId: E.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit, 'the erasure is audited');
    assert.ok(!audit.summary.includes(E.email) && !(audit.after ?? '').includes('Erased Person') && !(audit.after ?? '').includes(E.email), 'the audit row carries counts, never the person');

    // The other person is untouched.
    const kept = await db.user.findUniqueOrThrow({ where: { id: K.id } });
    assert.equal(kept.fullName, 'Kept Person');
    assert.equal(await db.session.count({ where: { userId: K.id } }), 1);
    assert.equal(await db.resume.count({ where: { userId: K.id } }), 1);
    assert.equal(await db.careerEvidence.count({ where: { userId: K.id } }), 1);

    await assert.rejects(erasure.executeErasure(E.id, { now: due, force: true }), /already been erased/);
    await assert.rejects(erasure.requestErasure(E, { now: due }), /already been erased/);
  });

  it('a database restored to before the erasure ran is repaired by the sweep: the completed request is re-executed (review M4)', async () => {
    // Simulate the restore: the person is back, the request still says completed.
    await db.user.update({ where: { id: E.id }, data: { anonymizedAt: null, fullName: 'Erased Person', email: E.email, passwordHash: 'x' } });
    await db.resume.create({ data: { userId: E.id, content: '{}', rawText: 'restored resume' } });
    assert.deepEqual(await erasure.unfinishedErasures(), [E.id]);
    const report = await retention.sweepRetention(d('2026-09-21T00:00:00Z'));
    assert.equal(report.erasuresResumed, 1);
    assert.equal(report.erasureErrors, 0);
    assert.equal(typeof report.erasuresDue, 'number');
    assert.equal(typeof report.workerRuns, 'number');
    const user = await db.user.findUniqueOrThrow({ where: { id: E.id } });
    assert.equal(user.fullName, 'Erased user');
    assert.ok(user.anonymizedAt);
    assert.equal(await db.resume.count({ where: { userId: E.id } }), 0);
    assert.deepEqual(await erasure.unfinishedErasures(), []);
  });

  it('the retention sweep removes exactly what the matrix expires and nothing newer', async () => {
    const now = d('2026-09-05T12:00:00Z');
    const old = await db.session.create({ data: { userId: K.id, expiresAt: d('2026-07-01T00:00:00Z') } });
    const revokedRecently = await db.session.create({ data: { userId: K.id, expiresAt: d('2027-01-01T00:00:00Z'), revokedAt: d('2026-09-01T00:00:00Z') } });
    const oldRun = await db.aiRun.create({ data: { userId: K.id, task: 'tailor', policyState: 'EXTERNAL_AI_PROHIBITED', route: 'deterministic', provider: 'deterministic', createdAt: d('2024-01-01T00:00:00Z') } });
    const oldRollup = await db.rollupRun.create({ data: { job: `pv_${S}`, windowStart: d('2025-01-01T00:00:00Z'), windowEnd: d('2025-01-02T00:00:00Z'), status: 'succeeded', startedAt: d('2025-01-01T00:00:00Z') } });
    const newRollup = await db.rollupRun.create({ data: { job: `pv_${S}`, windowStart: d('2026-09-01T00:00:00Z'), windowEnd: d('2026-09-02T00:00:00Z'), status: 'succeeded', startedAt: d('2026-09-01T00:00:00Z') } });
    await db.dailyMetric.create({ data: { day: '2020-01-01', metric: `pv_${S}`, dimension: 'all', valueInt: 1 } });
    await db.dailyMetric.create({ data: { day: '2026-09-01', metric: `pv_${S}`, dimension: 'all', valueInt: 1 } });

    const report = await retention.sweepRetention(now);
    assert.ok(report.sessions >= 1);
    assert.equal(await db.session.count({ where: { id: old.id } }), 0, 'expired more than thirty days ago');
    assert.equal(await db.session.count({ where: { id: revokedRecently.id } }), 1, 'revoked four days ago: the row is the revocation record until thirty days pass');
    assert.equal(await db.aiRun.count({ where: { id: oldRun.id } }), 0);
    assert.equal(await db.aiRun.count({ where: { userId: K.id } }), 1, 'the recent run stays');
    assert.equal(await db.rollupRun.count({ where: { id: oldRollup.id } }), 0);
    assert.equal(await db.rollupRun.count({ where: { id: newRollup.id } }), 1);
    assert.equal(await db.dailyMetric.count({ where: { metric: `pv_${S}` } }), 1);
    assert.equal(await db.consentRecord.count({ where: { userId: K.id } }), 1, 'consent is never swept');
    assert.equal(await db.invoice.count({ where: { id: invoiceId } }), 1, 'an invoice is never swept');
    assert.ok(await db.auditLog.findFirst({ where: { action: 'retention.swept' } }), 'the sweep is audited');
    await db.rollupRun.deleteMany({ where: { job: `pv_${S}` } });
    await db.dailyMetric.deleteMany({ where: { metric: `pv_${S}` } });
  });

  it('the health check answers without a session, names no host, and reports the database as reachable', async () => {
    const res = await health.GET(new Request('http://localhost/api/health', { headers: { 'x-forwarded-for': '203.0.113.9' } }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; checks: Record<string, { ok: boolean; detail: string }> };
    assert.ok(['ok', 'degraded'].includes(body.status));
    assert.equal(body.checks.database!.ok, true);
    assert.equal(body.checks.migrations!.ok, true);
    assert.equal(body.checks.migrations!.detail, 'applied', 'a fixed word, never a count (review M3)');
    const text = JSON.stringify(body);
    assert.ok(!/127\.0\.0\.1|localhost|postgres:|5433|DATABASE_URL|local\b.*provider|redis|memory|\d+ (applied|enabled|stale)/.test(text), 'nothing that locates the database or names a backend leaks');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('the health check is memoised per instance and refuses a burst from one address (review M3)', async () => {
    health.resetHealthMemo();
    const first = await health.healthBody(1_000_000);
    const second = await health.healthBody(1_000_000 + health.MEMO_MS - 1);
    assert.equal(first, second, 'the same computed answer inside the window');
    const third = await health.healthBody(1_000_000 + health.MEMO_MS + 1);
    assert.notEqual(first, third, 'recomputed after the window');
    health.resetHealthMemo();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await health.GET(new Request('http://localhost/api/health', { headers: { 'x-forwarded-for': '203.0.113.77' } }))).status;
    assert.equal(last, 429, 'the sixty-first request from one address is refused');
  });
});

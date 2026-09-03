/**
 * Stage 10 — the application folder against the database.
 *
 * Proves: a status move writes the row, the history row and the audit row
 * together (and rolls back together); refusals are the machine's; the
 * first interview moves a submitted application to interviewing; children
 * are written on the tenant path and audited without content; the offer
 * settles the outcome; the confirmation path goes through the machine;
 * another tenant sees and touches nothing; erasure cascades; the folder
 * completeness checklist and the export read the real rows.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Service = typeof import('../src/lib/applications/service');
type Ctx = typeof import('../src/lib/tenancy/context');
type Applicator = typeof import('../src/lib/services/applicator');
type Folder = typeof import('../src/lib/applications/folder');
type Builders = typeof import('../src/lib/exports/builders');

const S = randomBytes(4).toString('hex');
const A = { id: `af_a_${S}`, email: `af-a-${S}@folder.test` };
const B = { id: `af_b_${S}`, email: `af-b-${S}@folder.test` };
let db: Db;
let service: Service;
let ctx: Ctx;
let applicator: Applicator;
let folder: Folder;
let builders: Builders;
let jobId: string;

describe('Stage 10 — application folder against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    service = await import('../src/lib/applications/service');
    ctx = await import('../src/lib/tenancy/context');
    applicator = await import('../src/lib/services/applicator');
    folder = await import('../src/lib/applications/folder');
    builders = await import('../src/lib/exports/builders');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Folder', country: 'CA' } });
    jobId = (await db.job.create({ data: { source: 'mock', externalId: `af-${S}`, title: 'Data Analyst', company: `Maple ${S}`, location: 'Toronto, ON', description: 'SQL.', postedAt: new Date() } })).id;
  });
  after(async () => {
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id] } } });
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.job.deleteMany({ where: { externalId: { startsWith: `af-${S}` } } });
    await db.$disconnect();
  });

  // The routes' shape: the tenant transaction, then the buffered audit flushed on the system client; nothing flushed on failure.
  const actor = { id: A.id, email: A.email, audit: [] as Service extends { folderActor: (u: never) => infer R } ? (R extends { audit: infer E } ? E : never) : never };
  const actorB = { id: B.id, email: B.email, audit: [] as typeof actor.audit };
  const asA = async <T,>(fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => {
    try {
      const result = await ctx.withTenant({ userId: A.id }, fn);
      await service.flushAudit(actor);
      return result;
    } catch (error) {
      actor.audit.length = 0;
      throw error;
    }
  };
  const asB = <T,>(fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId: B.id }, fn);

  // One application per user per job: each fixture gets its own posting.
  async function newJob() {
    return (await db.job.create({ data: { source: 'mock', externalId: `af-${S}-${randomBytes(3).toString('hex')}`, title: 'Data Analyst', company: `Maple ${S}`, location: 'Toronto, ON', description: 'SQL.', postedAt: new Date() } })).id;
  }
  async function submittedApplication() {
    const application = await db.application.create({ data: { userId: A.id, jobId: await newJob(), status: 'submitted', appliedAt: new Date('2026-09-01T10:00:00Z'), applyChannel: 'ats_api', confirmation: `C-${S}`, tailoredResume: 'r', coverLetter: 'c' } });
    await service.recordInitialStatus(db, A.id, application.id, 'submitted', 'applicator', new Date('2026-09-01T10:00:00Z'));
    return application;
  }

  it('a status move writes the row, the history row and the audit row together; the machine refuses dishonest moves; a repeat is a no-op', async () => {
    const app = await submittedApplication();
    const moved = await asA((tx) => service.transitionApplication(tx, actor, app.id, 'interviewing', { actor: 'applicant', source: 'ui', reason: 'phone screen booked' }));
    assert.equal(moved.status, 'interviewing');
    assert.ok(moved.respondedAt, 'the first response is stamped');
    const history = await db.applicationStatusHistory.findMany({ where: { applicationId: app.id }, orderBy: { at: 'asc' } });
    assert.deepEqual(history.map((h) => [h.fromStatus, h.toStatus, h.actor, h.source]), [['', 'submitted', 'system', 'applicator'], ['submitted', 'interviewing', 'applicant', 'ui']]);
    assert.equal(history[1].reason, 'phone screen booked');
    const audit = await db.auditLog.findMany({ where: { entityType: 'Application', entityId: app.id, action: 'application.status' } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorId, A.id);
    // Dishonest moves are refused with a reason.
    await assert.rejects(() => asA((tx) => service.transitionApplication(tx, actor, app.id, 'submitted', { actor: 'applicant', source: 'ui' })), /cannot become submitted/);
    // A repeat is idempotent: no second history row.
    await asA((tx) => service.transitionApplication(tx, actor, app.id, 'interviewing', { actor: 'applicant', source: 'ui' }));
    assert.equal(await db.applicationStatusHistory.count({ where: { applicationId: app.id } }), 2);
    // Rejection settles the outcome and is terminal.
    const rejected = await asA((tx) => service.transitionApplication(tx, actor, app.id, 'rejected', { actor: 'applicant', source: 'ui', rejectionReason: 'position_filled' }));
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.rejectionReason, 'position_filled');
    assert.ok(rejected.rejectedAt && rejected.outcomeAt);
    await assert.rejects(() => asA((tx) => service.transitionApplication(tx, actor, app.id, 'interviewing', { actor: 'applicant', source: 'ui' })), /cannot change again/);
  });

  it('a move that fails later in the transaction leaves no trace', async () => {
    const app = await submittedApplication();
    await assert.rejects(() =>
      asA(async (tx) => {
        await service.transitionApplication(tx, actor, app.id, 'interviewing', { actor: 'applicant', source: 'ui' });
        throw new Error('boom');
      }),
    );
    const row = await db.application.findUniqueOrThrow({ where: { id: app.id } });
    assert.equal(row.status, 'submitted');
    assert.equal(await db.applicationStatusHistory.count({ where: { applicationId: app.id, toStatus: 'interviewing' } }), 0);
    assert.equal(await db.auditLog.count({ where: { entityId: app.id, action: 'application.status' } }), 0);
  });

  it('children are written on the tenant path and audited without content; the first interview moves the application; the offer settles the outcome', async () => {
    const app = await submittedApplication();
    const contact = await asA((tx) => service.addContact(tx, actor, app.id, { role: 'recruiter', name: 'Riley Recruiter', email: `riley-${S}@agency.test`, organisation: 'Agency' }));
    const interview = await asA((tx) => service.addInterview(tx, actor, app.id, { kind: 'video', scheduledAt: new Date('2026-09-10T15:00:00Z'), interviewers: ['Sam'], notes: 'Bring the portfolio' }));
    const assessment = await asA((tx) => service.addAssessment(tx, actor, app.id, { kind: 'take_home', dueAt: new Date('2026-09-12T00:00:00Z') }));
    const followUp = await asA((tx) => service.addFollowUp(tx, actor, app.id, { dueAt: new Date('2026-09-15T00:00:00Z'), channel: 'email', note: 'Ask about timeline' }));
    const note = await asA((tx) => service.addNote(tx, actor, app.id, 'Secret salary expectation: 120k'));
    assert.equal((await db.application.findUniqueOrThrow({ where: { id: app.id } })).status, 'interviewing', 'the first interview moves a submitted application');
    const history = await db.applicationStatusHistory.findMany({ where: { applicationId: app.id }, orderBy: { at: 'asc' } });
    assert.equal(history[history.length - 1].reason, 'interview scheduled');
    // Audit: kinds and ids, never names, emails or bodies.
    const audit = await db.auditLog.findMany({ where: { entityType: 'Application', entityId: app.id } });
    const blob = audit.map((a) => `${a.summary} ${a.before} ${a.after}`).join('\n');
    assert.ok(audit.some((a) => a.action === 'application.contact.added'));
    assert.ok(audit.some((a) => a.action === 'application.note.added'));
    for (const secret of ['Riley', 'riley-', 'Agency', 'portfolio', 'timeline', 'Secret salary', '120k', 'Sam']) assert.ok(!blob.includes(secret), `audit carries content: ${secret}`);
    assert.ok(blob.includes(contact.id) && blob.includes(interview.id) && blob.includes(assessment.id) && blob.includes(followUp.id) && blob.includes(note.id));
    // Updates and completion.
    await asA((tx) => service.updateInterview(tx, actor, app.id, interview.id, { outcome: 'completed', result: 'advanced' }));
    await asA((tx) => service.updateAssessment(tx, actor, app.id, assessment.id, { submittedAt: new Date(), result: 'passed' }));
    const done = await asA((tx) => service.completeFollowUp(tx, actor, app.id, followUp.id));
    assert.ok(done.doneAt);
    // A drafted message from another application cannot be linked.
    await assert.rejects(() => asA((tx) => service.addFollowUp(tx, actor, app.id, { dueAt: new Date(), channel: 'email', documentVersionId: 'not-mine' })), /does not belong/);
    // The offer.
    await assert.rejects(() => asA((tx) => service.recordOffer(tx, actor, app.id, { decision: 'accepted' })), /once the application is at offer/);
    await asA((tx) => service.transitionApplication(tx, actor, app.id, 'offer', { actor: 'applicant', source: 'ui' }));
    const hired = await asA((tx) => service.recordOffer(tx, actor, app.id, { salaryMin: 110000, salaryMax: 120000, currency: 'CAD', decision: 'accepted' }));
    assert.equal(hired.outcome, 'hired');
    assert.equal(hired.offerDecision, 'accepted');
    assert.ok(hired.offerReceivedAt && hired.offerDecidedAt && hired.outcomeAt);
    const offerAudit = await db.auditLog.findFirst({ where: { entityId: app.id, action: 'application.offer' } });
    assert.ok(offerAudit && !offerAudit.after.includes('110000'), 'the salary never reaches the audit');
    // Completeness from the real rows.
    const full = await db.application.findUniqueOrThrow({ where: { id: app.id }, include: service.folderInclude() });
    const c = folder.folderCompleteness({ status: full.status as 'offer', appliedAt: full.appliedAt, applyChannel: full.applyChannel, confirmation: full.confirmation, company: full.job.company, sealedDocuments: full.documents.filter((d) => d.status === 'submitted').length, hasTextCopies: true, contacts: full.contacts.length, historyEntries: full.statusHistory.length, interviews: full.interviews.length, assessments: full.assessments.length, followUps: full.followUps.length, outcome: full.outcome, respondedAt: full.respondedAt });
    assert.equal(c.complete, true, JSON.stringify(c.answers));
    // The export carries the structured outcome.
    const dataset = await builders.buildApplicationsExport(A.id);
    const row = dataset.rows.find((r) => r.confirmation === `C-${S}` && r.outcome === 'Hired');
    assert.ok(row, JSON.stringify(dataset.rows.map((r) => [r.confirmation, r.outcome])));
    assert.equal(row!.interviews, 1);
    assert.equal(row!.offerDecision, 'Accepted');
  });

  it('an interview cannot be attached to an application the employer does not have', async () => {
    const app = await db.application.create({ data: { userId: A.id, jobId: await newJob(), status: 'queued' } });
    await assert.rejects(() => asA((tx) => service.addInterview(tx, actor, app.id, { kind: 'phone', scheduledAt: new Date() })), /employer has/);
    await assert.rejects(() => asA((tx) => service.transitionApplication(tx, actor, app.id, 'interviewing', { actor: 'applicant', source: 'ui' })), /has not reached the employer/);
  });

  it('confirming an assisted application goes through the machine and records its history', async () => {
    const app = await db.application.create({ data: { userId: A.id, jobId: await newJob(), status: 'ready_to_submit', applyChannel: 'assisted' } });
    await service.recordInitialStatus(db, A.id, app.id, 'ready_to_submit', 'applicator');
    assert.deepEqual(await applicator.confirmAssistedSubmission(A.id, app.id), { ok: true });
    const row = await db.application.findUniqueOrThrow({ where: { id: app.id } });
    assert.equal(row.status, 'submitted');
    assert.ok(row.appliedAt, 'stamped by the move');
    const history = await db.applicationStatusHistory.findMany({ where: { applicationId: app.id }, orderBy: { at: 'asc' } });
    assert.deepEqual(history.map((h) => [h.fromStatus, h.toStatus, h.source]), [['', 'ready_to_submit', 'applicator'], ['ready_to_submit', 'submitted', 'confirm']]);
    assert.deepEqual(await applicator.confirmAssistedSubmission(A.id, app.id), { ok: false, reason: 'This application is not awaiting confirmation.' });
  });

  it('another tenant sees none of the folder and cannot touch it; erasure removes everything', async () => {
    const app = await submittedApplication();
    await asA((tx) => service.addNote(tx, actor, app.id, 'mine'));
    assert.deepEqual(await asB((tx) => tx.applicationNote.findMany({ where: { applicationId: app.id } })), []);
    assert.deepEqual(await asB((tx) => tx.applicationStatusHistory.findMany({ where: { applicationId: app.id } })), []);
    await assert.rejects(() => asB((tx) => service.transitionApplication(tx, actorB, app.id, 'interviewing', { actor: 'applicant', source: 'ui' })), /not found/);
    await assert.rejects(() => asB((tx) => service.addNote(tx, actorB, app.id, 'theirs')), /not found/);
    // Erasure: a third user's folder disappears with them.
    const C = { id: `af_c_${S}`, email: `af-c-${S}@folder.test` };
    await db.user.create({ data: { id: C.id, email: C.email, passwordHash: 'x', fullName: 'Gone', country: 'CA' } });
    const theirs = await db.application.create({ data: { userId: C.id, jobId, status: 'submitted', appliedAt: new Date() } });
    await service.recordInitialStatus(db, C.id, theirs.id, 'submitted', 'applicator');
    const actorC = service.folderActor(C);
    await ctx.withTenant({ userId: C.id }, (tx) => service.addContact(tx, actorC, theirs.id, { role: 'other', name: 'X' }));
    await service.flushAudit(actorC);
    await db.user.delete({ where: { id: C.id } });
    assert.equal(await db.applicationStatusHistory.count({ where: { userId: C.id } }), 0);
    assert.equal(await db.applicationContact.count({ where: { userId: C.id } }), 0);
    await db.auditLog.deleteMany({ where: { actorId: C.id } });
  });
});

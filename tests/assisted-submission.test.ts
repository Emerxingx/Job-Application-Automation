/**
 * Stage 12 — the instructed ATS submission, end to end against the database
 * with the deterministic mock engine: prepare-shaped record → the applicant's
 * click → `applying` (the claim) → `submitted` with a confirmation, the
 * status history through the machine (source ats_api), the documents sealed,
 * the match marked applied; a second click refused; another user refused; a
 * mode that does not permit it refused; a record not awaiting review refused;
 * an unauthorised board refused; an engine refusal releases the claim with
 * the reason and nothing is sent twice.
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
type Applicator = typeof import('../src/lib/services/applicator');
type Apply = typeof import('../src/lib/providers/apply');
const S = randomBytes(4).toString('hex');
const A = { id: `sub_a_${S}`, email: `sub-a-${S}@sub.test` };
const B = { id: `sub_b_${S}`, email: `sub-b-${S}@sub.test` };
let db: Db;
let applicator: Applicator;
let apply: Apply;

/** The mock engine refuses when its seed of `${company}:${title}` is divisible by 12 — find titles on both sides of that line. */
function seedOf(company: string, title: string): number {
  const key = `${company}:${title}`;
  let seed = 0;
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
  return seed;
}
function titleWhere(company: string, refuses: boolean): string {
  for (let n = 0; n < 10000; n += 1) {
    const title = `Analyst ${n}`;
    if ((seedOf(company, title) % 12 === 0) === refuses) return title;
  }
  throw new Error('no title found');
}

describe('Stage 12 — instructed ATS submission against the database', { skip: SKIP }, () => {
  const saved = { JOB_PROVIDER: process.env.JOB_PROVIDER, APPLY_MODE: process.env.APPLY_MODE };
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    process.env.JOB_PROVIDER = 'mock';
    delete process.env.APPLY_MODE;
    ({ db } = await import('../src/lib/db'));
    applicator = await import('../src/lib/services/applicator');
    apply = await import('../src/lib/providers/apply');
    apply.resetApplyProvider();
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Sub Tester', country: 'CA', applicationMode: 'review_submit' } });
  });
  after(async () => {
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id] } } });
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.job.deleteMany({ where: { externalId: { startsWith: `sub-${S}` } } });
    if (saved.JOB_PROVIDER === undefined) delete process.env.JOB_PROVIDER;
    else process.env.JOB_PROVIDER = saved.JOB_PROVIDER;
    if (saved.APPLY_MODE !== undefined) process.env.APPLY_MODE = saved.APPLY_MODE;
    apply.resetApplyProvider();
    await db.$disconnect();
  });

  let n = 0;
  async function prepared(owner: { id: string }, title: string, over: { atsSubmittable?: boolean; status?: string } = {}) {
    n += 1;
    const job = await db.job.create({ data: { source: 'mock', externalId: `sub-${S}-${n}`, title, company: 'Acme Robotics', location: 'Toronto, ON', description: 'x', applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345', postedAt: new Date() } });
    const application = await db.application.create({ data: { userId: owner.id, jobId: job.id, status: over.status ?? 'ready_to_submit', atsSubmittable: over.atsSubmittable ?? true, atsVendor: 'greenhouse', tailoredResume: 'RESUME', coverLetter: 'LETTER', applicationMode: 'review_submit' } });
    await db.applicationStatusHistory.create({ data: { userId: owner.id, applicationId: application.id, fromStatus: '', toStatus: application.status, actor: 'system', source: 'applicator' } });
    await db.documentVersion.create({ data: { userId: owner.id, applicationId: application.id, scopeKey: application.id, kind: 'resume', format: 'txt', contentHash: 'h', sizeBytes: 6, storageKey: `sub-${S}/${application.id}/resume.txt` } });
    return { job, application };
  }

  it('prepare → the applicant’s click → applying (the claim) → submitted with a confirmation; history, seal and match follow; a second click is refused', async () => {
    const { job, application } = await prepared(A, titleWhere('Acme Robotics', false));
    const agent = await db.agent.create({ data: { userId: A.id, name: 'a', keywords: '[]', locations: '[]' } });
    const match = await db.jobMatch.create({ data: { agentId: agent.id, jobId: job.id, matchScore: 80, status: 'reviewed' } });
    const result = await applicator.submitThroughAts(A.id, application.id);
    assert.equal(result.ok, true, result.reason);
    assert.match(result.confirmation ?? '', /^JP-/);
    const row = await db.application.findUniqueOrThrow({ where: { id: application.id } });
    assert.equal(row.status, 'submitted');
    assert.equal(row.applyChannel, 'ats_api');
    assert.equal(row.confirmation, result.confirmation);
    assert.ok(row.appliedAt, 'appliedAt stamped by the move');
    const history = await db.applicationStatusHistory.findMany({ where: { applicationId: application.id }, orderBy: { at: 'asc' } });
    assert.deepEqual(history.map((h) => `${h.fromStatus}>${h.toStatus}:${h.source}`), ['>ready_to_submit:applicator', 'ready_to_submit>applying:ats_api', 'applying>submitted:ats_api'], 'the claim and the submission both went through the machine');
    assert.match(history[2].reason ?? '', /on the applicant's instruction after review/);
    const doc = await db.documentVersion.findFirstOrThrow({ where: { applicationId: application.id } });
    assert.equal(doc.status, 'submitted', 'the reviewed document is sealed');
    assert.equal((await db.jobMatch.findUniqueOrThrow({ where: { id: match.id } })).status, 'applied', 'only now is the match applied');
    const again = await applicator.submitThroughAts(A.id, application.id);
    assert.equal(again.ok, false);
    assert.match(again.reason ?? '', /not awaiting your review/, 'a second click cannot submit twice');
    const audits = await db.auditLog.findMany({ where: { entityId: application.id, action: 'application.status' } });
    assert.equal(audits.length, 2);
  });

  it('refuses another user, a mode that does not permit it, a record not awaiting review, and an unauthorised board — without touching the engine', async () => {
    const { application } = await prepared(A, titleWhere('Acme Robotics', false));
    assert.equal((await applicator.submitThroughAts(B.id, application.id)).reason, 'Application not found.');
    await db.user.update({ where: { id: A.id }, data: { applicationMode: 'prepare' } });
    await assert.rejects(() => applicator.submitThroughAts(A.id, application.id), /does not submit on your behalf/);
    await db.user.update({ where: { id: A.id }, data: { applicationMode: 'review_submit' } });
    const notReady = await prepared(A, titleWhere('Acme Robotics', false) + ' x', { status: 'submitted' });
    assert.match((await applicator.submitThroughAts(A.id, notReady.application.id)).reason ?? '', /not awaiting your review/);
    const unauthorised = await prepared(A, titleWhere('Acme Robotics', false) + ' y', { atsSubmittable: false });
    assert.match((await applicator.submitThroughAts(A.id, unauthorised.application.id)).reason ?? '', /not authorised JobPilot/);
    for (const id of [application.id, notReady.application.id, unauthorised.application.id]) {
      const row = await db.application.findUniqueOrThrow({ where: { id } });
      assert.ok(row.status === 'ready_to_submit' || row.status === 'submitted');
      assert.equal(await db.applicationStatusHistory.count({ where: { applicationId: id, source: 'ats_api' } }), 0, 'no claim was taken');
    }
  });

  it('an engine refusal releases the claim with the reason, leaves the record ready for the form, and sends nothing twice', async () => {
    const { application } = await prepared(A, titleWhere('Acme Robotics', true));
    const result = await applicator.submitThroughAts(A.id, application.id);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /manual assessment step/);
    const row = await db.application.findUniqueOrThrow({ where: { id: application.id } });
    assert.equal(row.status, 'ready_to_submit', 'the claim is released');
    assert.match(row.failureReason ?? '', /manual assessment/);
    assert.equal(row.confirmation, null);
    const history = await db.applicationStatusHistory.findMany({ where: { applicationId: application.id }, orderBy: { at: 'asc' } });
    assert.deepEqual(history.map((h) => `${h.fromStatus}>${h.toStatus}`), ['>ready_to_submit', 'ready_to_submit>applying', 'applying>ready_to_submit']);
    const doc = await db.documentVersion.findFirstOrThrow({ where: { applicationId: application.id } });
    assert.equal(doc.status, 'draft', 'nothing sealed');
  });

  it('two simultaneous clicks: exactly one reaches the engine', async () => {
    const { application } = await prepared(A, titleWhere('Acme Robotics', false) + ' z');
    const results = await Promise.all([applicator.submitThroughAts(A.id, application.id), applicator.submitThroughAts(A.id, application.id)]);
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    assert.ok(results.some((r) => !r.ok && /already being submitted|not awaiting your review/.test(r.reason ?? '')));
    assert.equal(await db.applicationStatusHistory.count({ where: { applicationId: application.id, toStatus: 'submitted' } }), 1);
  });
});

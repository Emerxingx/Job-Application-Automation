/**
 * Stage 18 (ADR-0033) - talent acquisition against PostgreSQL: who may act,
 * a requisition published as a first-party posting through the connector
 * gate, sourcing that never shows a hidden candidate and never a name
 * without consent, the disclosure the CANDIDATE grants (one employer, one
 * consent record) and can revoke, the pipeline that cannot pass consent
 * without it, interviews, notes, offers and a hire, applying through the
 * platform, talent pools, reporting, and isolation between employers and
 * from the candidate's own tenant path.
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
type Svc = typeof import('../src/lib/employer/service');
type View = typeof import('../src/lib/employer/candidate-view');
type Orgs = typeof import('../src/lib/tenancy/organizations');
type Ctx = typeof import('../src/lib/tenancy/context');
type Registry = typeof import('../src/lib/connectors/registry');

const S = randomBytes(4).toString('hex');
const mk = (tag: string, name: string) => ({ id: `em_${tag}_${S}`, email: `em-${tag}-${S}@employer.test`, fullName: name });
const OE = mk('oe', 'Owner E');
const REC = mk('rec', 'Recruiter E');
const HM = mk('hm', 'Hiring Manager E');
const INT = mk('int', 'Interviewer E');
const VW = mk('vw', 'Viewer E');
const OF = mk('of', 'Owner F');
const HID = mk('hid', 'Hidden Candidate');
const ANON = mk('anon', 'Anonymous Candidate');
const VIS = mk('vis', 'Visible Candidate');
const ALL = [OE, REC, HM, INT, VW, OF, HID, ANON, VIS];
const CANDIDATES = [HID, ANON, VIS] as const;

let db: Db;
let svc: Svc;
let view: View;
let orgs: Orgs;
let ctx: Ctx;
let registry: Registry;
let orgE = '';
let orgF = '';
let reqId = '';
let jobId = '';
let anonSubmissionId = '';

describe('employer - roles, requisitions, sourcing, disclosure, pipeline, pools, reporting, isolation', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    svc = await import('../src/lib/employer/service');
    view = await import('../src/lib/employer/candidate-view');
    orgs = await import('../src/lib/tenancy/organizations');
    ctx = await import('../src/lib/tenancy/context');
    registry = await import('../src/lib/connectors/registry');
    await registry.ensureSourceRegistry();
    for (const u of ALL) {
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName, country: 'CA', city: 'Toronto', headline: `${u.fullName} headline`, onboardedAt: new Date() } });
      await orgs.ensurePersonalWorkspace(db, u);
    }
    for (const [c, visibility] of [
      [HID, 'hidden'],
      [ANON, 'anonymous'],
      [VIS, 'visible'],
    ] as const) {
      const profile = await db.candidateProfile.create({ data: { userId: c.id } });
      await db.careerPreferences.create({ data: { profileId: profile.id, userId: c.id, recruiterVisibility: visibility } });
      await db.resume.create({ data: { userId: c.id, content: JSON.stringify({ fullName: c.fullName, headline: 'Data analyst', email: c.email, summary: 'Analyst with SQL and Python.', skills: ['SQL', 'Python', 'Excel'], experience: [{ company: 'Co', title: 'Data Analyst', startDate: '2021-01', endDate: 'Present', bullets: ['Built SQL reports'] }], education: [{ institution: 'U of T', credential: 'BSc', year: '2020' }], certifications: [], projects: [] }) } });
    }
    orgE = (await orgs.createOrganization(OE.id, { name: `Employer E ${S}`, type: 'employer', billingEmail: OE.email })).id;
    orgF = (await orgs.createOrganization(OF.id, { name: `Employer F ${S}`, type: 'employer', billingEmail: OF.email })).id;
    for (const [u, serviceRole] of [
      [REC, 'recruiter'],
      [HM, 'hiring_manager'],
      [INT, 'interviewer'],
      [VW, null],
    ] as const) {
      await orgs.inviteMember(OE.id, orgE, { userId: u.id, role: 'member' });
      await orgs.acceptInvitation(u.id, orgE);
      if (serviceRole) await svc.setEmployerRole({ user: OE, organizationId: orgE, role: 'admin' }, u.id, serviceRole);
    }
  });
  after(async () => {
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ALL.map((u) => u.id) } }, { entityId: { in: [orgE, orgF] } }] } });
    if (jobId) await db.job.deleteMany({ where: { id: jobId } });
    await db.job.deleteMany({ where: { externalId: { startsWith: `em_${S}` } } });
    await db.organization.deleteMany({ where: { id: { in: [orgE, orgF] } } });
    await db.user.deleteMany({ where: { id: { in: ALL.map((u) => u.id) } } });
    await db.$disconnect();
  });

  const tenant = <T,>(userId: string, organizationId: string | undefined, fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId, organizationId }, fn);
  const actorOf = (u: { id: string; email: string }, org = orgE) => svc.requireEmployerActor(u, org);
  const status = (p: Promise<unknown>, code: number, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof svc.EmployerError && e.status === code && (!re || re.test(e.message)));
  const auditCount = (action: string, entityId?: string) => db.auditLog.count({ where: { action, ...(entityId ? { entityId } : {}) } });
  const rec = () => ({ user: REC, organizationId: orgE, role: 'recruiter' as const });
  const adminF = () => ({ user: OF, organizationId: orgF, role: 'admin' as const });

  it('the actor resolves from an accepted membership of an EMPLOYER organisation; the role is the named set; a viewer cannot set roles', async () => {
    await status(svc.requireEmployerActor(OF, orgE), 404);
    assert.equal((await actorOf(OE)).role, 'admin');
    assert.equal((await actorOf(REC)).role, 'recruiter');
    assert.equal((await actorOf(HM)).role, 'hiring_manager');
    assert.equal((await actorOf(INT)).role, 'interviewer');
    assert.equal((await actorOf(VW)).role, 'viewer');
    assert.deepEqual((await svc.employerMemberships(REC.id)).map((m) => m.organizationId), [orgE]);
    await status(svc.setEmployerRole({ user: VW, organizationId: orgE, role: 'viewer' }, REC.id, 'viewer'), 403);
  });

  it('a requisition is a draft until opened; opening publishes it as a first-party posting through the connector gate', async () => {
    await status(tenant(VW.id, orgE, (tx) => svc.createRequisition(tx, { user: VW, organizationId: orgE, role: 'viewer' }, { title: 'x', location: 'Toronto, ON' })), 403);
    await status(tenant(INT.id, orgE, (tx) => svc.createRequisition(tx, { user: INT, organizationId: orgE, role: 'interviewer' }, { title: 'x', location: 'Toronto, ON' })), 403);
    await status(tenant(REC.id, orgE, (tx) => svc.createRequisition(tx, rec(), { title: 'Data Analyst', location: 'Toronto, ON', salaryMin: 90_000, salaryMax: 80_000 })), 422, /inverted/);
    const r = await tenant(REC.id, orgE, (tx) => svc.createRequisition(tx, rec(), { title: `Data Analyst ${S}`, location: 'Toronto, ON', description: 'Analyse data with SQL and Python for the reporting team.', requiredSkills: ['SQL', 'Python'], preferredSkills: ['Excel'], salaryMin: 80_000, salaryMax: 100_000, hiringManagerId: HM.id }));
    reqId = r.id;
    assert.equal(r.status, 'draft');
    assert.equal(r.recruiterId, REC.id);
    assert.equal(r.jobId, null, 'nothing is published as a draft');
    // a hiring manager writes their own requisition; another member's is not theirs
    await tenant(HM.id, orgE, (tx) => svc.updateRequisition(tx, { user: HM, organizationId: orgE, role: 'hiring_manager' }, r.id, { department: 'Reporting' }));
    await status(tenant(REC.id, orgE, (tx) => svc.setRequisitionStatus(tx, rec(), r.id, 'filled')), 409);
    const opened = await tenant(REC.id, orgE, (tx) => svc.setRequisitionStatus(tx, rec(), r.id, 'open'));
    assert.equal(opened.status, 'open');
    const row = await db.requisition.findUniqueOrThrow({ where: { id: r.id } });
    assert.ok(row.jobId);
    jobId = row.jobId!;
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.source, 'employer');
    assert.equal(job.company, `Employer E ${S}`);
    assert.equal(job.activeState, 'active');
    assert.equal(await db.jobSnapshot.count({ where: { jobId } }), 1, 'captured like any posting');
    // editing an open requisition re-publishes to the SAME job
    await tenant(REC.id, orgE, (tx) => svc.updateRequisition(tx, rec(), r.id, { description: 'Analyse data with SQL and Python for the reporting team. Updated.' }));
    assert.equal((await db.requisition.findUniqueOrThrow({ where: { id: r.id } })).jobId, jobId);
    assert.equal((await tenant(REC.id, orgE, (tx) => svc.listRequisitions(tx, rec()))).length, 1);
    assert.equal(await tenant(OF.id, orgF, (tx) => tx.requisition.count({ where: { id: r.id } })), 0, 'another employer sees nothing under RLS');
  });

  it('sourcing: a hidden candidate never appears; an anonymous one has no name; a visible one has name and headline; audited; a viewer cannot search', async () => {
    await status(view.sourceCandidates({ user: VW, organizationId: orgE, role: 'viewer' }, reqId), 403);
    const { cards } = await view.sourceCandidates(rec(), reqId);
    const ids = cards.map((c) => c.candidateUserId);
    assert.ok(!ids.includes(HID.id), 'hidden is never sourced');
    const anon = cards.find((c) => c.candidateUserId === ANON.id)!;
    const vis = cards.find((c) => c.candidateUserId === VIS.id)!;
    assert.ok(anon && vis);
    assert.equal(anon.name, null);
    assert.equal(anon.headline, null);
    assert.equal(anon.region, 'CA', 'country only');
    assert.equal(vis.name, VIS.fullName);
    assert.equal(vis.headline, `${VIS.fullName} headline`);
    assert.ok(anon.score > 0 && vis.score > 0);
    assert.ok(anon.matched.some((m) => /sql/i.test(m)));
    assert.equal(anon.disclosure, 'none');
    assert.ok(!JSON.stringify(cards).includes(ANON.email) && !JSON.stringify(cards).includes(ANON.fullName), 'no identity for an anonymous candidate');
    assert.equal(await auditCount('employer.sourcing.run', reqId), 1);
    // the hiring manager reads sourcing; the hidden candidate cannot even be asked
    await view.sourceCandidates({ user: HM, organizationId: orgE, role: 'hiring_manager' }, reqId);
    await status(svc.requestDisclosure(rec(), { candidateUserId: HID.id, requisitionId: reqId }), 404);
  });

  it('disclosure is the candidate\'s: requested by a recruiter, listed on the candidate\'s own tenant path (read-only), refused for another employer, granted with ONE consent record; nothing past consent before it', async () => {
    await status(svc.requestDisclosure({ user: INT, organizationId: orgE, role: 'interviewer' }, { candidateUserId: ANON.id }), 403);
    const d = await svc.requestDisclosure(rec(), { candidateUserId: ANON.id, requisitionId: reqId, message: 'We have a Data Analyst opening.' });
    assert.equal(d.status, 'requested');
    await status(svc.requestDisclosure(rec(), { candidateUserId: ANON.id }), 409, /already waiting/);
    const sub = await db.submission.findUniqueOrThrow({ where: { requisitionId_candidateUserId: { requisitionId: reqId, candidateUserId: ANON.id } } });
    anonSubmissionId = sub.id;
    assert.equal(sub.stage, 'consent_requested');
    assert.equal(await auditCount('disclosure.requested', d.id), 1);
    // the candidate sees the request on their own tenant path and can neither edit nor delete it there
    const mine = await tenant(ANON.id, undefined, (tx) => svc.listCandidateDisclosures(tx, ANON.id));
    assert.deepEqual(mine.map((x) => [x.id, x.organization.name, x.requisitionTitle]), [[d.id, `Employer E ${S}`, `Data Analyst ${S}`]]);
    assert.equal((await tenant(VIS.id, undefined, (tx) => svc.listCandidateDisclosures(tx, VIS.id))).length, 0);
    await assert.rejects(() => tenant(ANON.id, undefined, (tx) => tx.disclosure.update({ where: { id: d.id }, data: { status: 'granted' } })));
    assert.equal((await tenant(ANON.id, undefined, (tx) => tx.disclosure.deleteMany({ where: { id: d.id } }))).count, 0);
    assert.equal(await tenant(ANON.id, undefined, (tx) => tx.submission.count({ where: { id: sub.id } })), 0, 'the pipeline is the employer\'s; the candidate never sees it');
    // before the grant: no identity, no stage past consent
    await status(view.readDisclosedCandidate(rec(), ANON.id), 403, /not granted/);
    await status(tenant(REC.id, orgE, (tx) => svc.moveSubmission(tx, rec(), sub.id, 'screening')), 409, /cannot move/);
    await status(tenant(REC.id, orgE, (tx) => svc.moveSubmission(tx, rec(), sub.id, 'consented')), 409, /candidate's to give/);
    await status(svc.respondToDisclosure(VIS, d.id, true), 404, undefined);
    const before = await db.consentRecord.count({ where: { userId: ANON.id, purpose: 'employer_disclosure' } });
    const granted = await svc.respondToDisclosure(ANON, d.id, true);
    assert.equal(granted.status, 'granted');
    assert.equal(await db.consentRecord.count({ where: { userId: ANON.id, purpose: 'employer_disclosure' } }), before + 1);
    const dRow = await db.disclosure.findUniqueOrThrow({ where: { id: d.id } });
    assert.ok(dRow.consentRecordId);
    assert.equal((await db.submission.findUniqueOrThrow({ where: { id: sub.id } })).stage, 'consented');
    await status(svc.respondToDisclosure(ANON, d.id, true), 409);
    assert.equal(await auditCount('disclosure.granted', d.id), 1);
    // now the identity is readable by E (audited) and by nobody else
    const profile = await view.readDisclosedCandidate(rec(), ANON.id);
    assert.equal(profile.fullName, ANON.fullName);
    assert.equal(profile.email, ANON.email);
    assert.ok(profile.skills.includes('SQL'));
    assert.equal(profile.experience[0]?.highlights[0], 'Built SQL reports');
    assert.equal(profile.education[0]?.school, 'U of T');
    assert.equal(await auditCount('employer.candidate.read', d.id), 1);
    await status(view.readDisclosedCandidate(adminF(), ANON.id), 403);
    await status(svc.requestDisclosure(rec(), { candidateUserId: ANON.id }), 409, /already granted/);
    const loaded = await tenant(REC.id, orgE, (tx) => svc.loadRequisition(tx, rec(), reqId));
    assert.equal(loaded.submissions.find((s) => s.id === sub.id)?.candidate.name, ANON.fullName, 'the pipeline shows the name once disclosed');
  });

  it('a candidate applying through the platform grants disclosure by their own act; a pool holds consented candidates only; revocation withdraws everything', async () => {
    const mock = await db.job.create({ data: { title: `Other ${S}`, company: 'Co', location: 'Toronto, ON', description: '', externalId: `em_${S}_mock`, source: 'mock', postedAt: new Date() } });
    await status(svc.applyThroughPlatform(VIS, mock.id), 404, /not an employer requisition/);
    const s = await svc.applyThroughPlatform(VIS, jobId);
    assert.equal(s.stage, 'consented');
    assert.equal(s.source, 'applied');
    await status(svc.applyThroughPlatform(VIS, jobId), 409, /already applied/);
    const d = await db.disclosure.findUniqueOrThrow({ where: { organizationId_candidateUserId: { organizationId: orgE, candidateUserId: VIS.id } } });
    assert.equal(d.status, 'granted');
    assert.ok(d.consentRecordId);
    assert.equal((await view.readDisclosedCandidate(rec(), VIS.id)).fullName, VIS.fullName);
    // pools
    await status(tenant(INT.id, orgE, (tx) => svc.createPool(tx, { user: INT, organizationId: orgE, role: 'interviewer' }, { name: 'x' })), 403);
    const pool = await tenant(REC.id, orgE, (tx) => svc.createPool(tx, rec(), { name: `Analysts ${S}` }));
    await tenant(REC.id, orgE, (tx) => svc.addToPool(tx, rec(), pool.id, VIS.id));
    await status(tenant(REC.id, orgE, (tx) => svc.addToPool(tx, rec(), pool.id, HID.id)), 403, /granted disclosure/);
    assert.equal((await tenant(REC.id, orgE, (tx) => svc.listPools(tx, rec())))[0]?._count.members, 1);
    await tenant(REC.id, orgE, (tx) => svc.moveSubmission(tx, rec(), s.id, 'screening'));
    // the candidate takes it back
    await status(svc.revokeDisclosure(ANON, d.id), 404);
    await svc.revokeDisclosure(VIS, d.id);
    assert.equal((await db.disclosure.findUniqueOrThrow({ where: { id: d.id } })).status, 'revoked');
    assert.ok((await db.consentRecord.findUniqueOrThrow({ where: { id: d.consentRecordId! } })).revokedAt);
    assert.equal((await db.submission.findUniqueOrThrow({ where: { id: s.id } })).stage, 'withdrawn');
    assert.equal(await db.talentPoolMember.count({ where: { poolId: pool.id } }), 0, 'the pool membership went with the disclosure');
    await status(view.readDisclosedCandidate(rec(), VIS.id), 403);
    await status(tenant(REC.id, orgE, (tx) => svc.moveSubmission(tx, rec(), s.id, 'screening')), 409, /cannot move/); // withdrawn is terminal
    assert.equal(await auditCount('disclosure.revoked', d.id), 1);
    const loaded = await tenant(REC.id, orgE, (tx) => svc.loadRequisition(tx, rec(), reqId));
    assert.equal(loaded.submissions.find((x) => x.id === s.id)?.candidate.name, null, 'the name is gone with the consent');
    // the employer may ask again after a revocation - and the candidate declines this time, which is final
    const again = await svc.requestDisclosure(rec(), { candidateUserId: VIS.id });
    assert.equal(again.id, d.id);
    assert.equal((await svc.respondToDisclosure(VIS, again.id, false)).status, 'declined');
    await status(svc.requestDisclosure(rec(), { candidateUserId: VIS.id }), 409, /declined/);
    assert.equal(await auditCount('disclosure.declined', d.id), 1);
  });

  it('the pipeline: screening, an interview only a named interviewer or the owner records, a note, an offer, a hire that fills the requisition and closes the posting', async () => {
    const sub = anonSubmissionId;
    await status(tenant(VW.id, orgE, (tx) => svc.moveSubmission(tx, { user: VW, organizationId: orgE, role: 'viewer' }, sub, 'screening')), 403);
    await tenant(REC.id, orgE, (tx) => svc.moveSubmission(tx, rec(), sub, 'screening'));
    await status(tenant(INT.id, orgE, (tx) => svc.scheduleInterview(tx, { user: INT, organizationId: orgE, role: 'interviewer' }, sub, { scheduledAt: new Date() })), 403);
    const interview = await tenant(HM.id, orgE, (tx) => svc.scheduleInterview(tx, { user: HM, organizationId: orgE, role: 'hiring_manager' }, sub, { kind: 'technical', scheduledAt: new Date(Date.now() + 86_400_000), interviewerIds: [INT.id] }));
    assert.equal((await db.submission.findUniqueOrThrow({ where: { id: sub } })).stage, 'interviewing');
    await status(tenant(VW.id, orgE, (tx) => svc.recordInterview(tx, { user: VW, organizationId: orgE, role: 'viewer' }, interview.id, { outcome: 'completed' })), 403);
    const done = await tenant(INT.id, orgE, (tx) => svc.recordInterview(tx, { user: INT, organizationId: orgE, role: 'interviewer' }, interview.id, { outcome: 'completed', feedback: 'Strong SQL.' }));
    assert.equal(done.outcome, 'completed');
    await status(tenant(INT.id, orgE, (tx) => svc.addEmployerNote(tx, { user: INT, organizationId: orgE, role: 'interviewer' }, sub, 'x')), 403);
    await tenant(REC.id, orgE, (tx) => svc.addEmployerNote(tx, rec(), sub, 'Good communicator.'));
    await status(tenant(INT.id, orgE, (tx) => svc.extendOffer(tx, { user: INT, organizationId: orgE, role: 'interviewer' }, sub, { salaryCents: 9_000_000 })), 403);
    await status(tenant(REC.id, orgE, (tx) => svc.extendOffer(tx, rec(), sub, { salaryCents: 9_000_000 })), 403, /hiring manager or an administrator/);
    const offer = await tenant(HM.id, orgE, (tx) => svc.extendOffer(tx, { user: HM, organizationId: orgE, role: 'hiring_manager' }, sub, { salaryCents: 9_000_000, startDate: new Date('2026-10-01T00:00:00Z') }));
    assert.equal(offer.status, 'extended');
    assert.equal((await db.submission.findUniqueOrThrow({ where: { id: sub } })).stage, 'offered');
    await status(tenant(OF.id, orgF, (tx) => svc.decideOffer(tx, adminF(), offer.id, { status: 'accepted' })), 404, undefined);
    await status(tenant(REC.id, orgE, (tx) => svc.decideOffer(tx, rec(), offer.id, { status: 'accepted' })), 403);
    const hm = { user: HM, organizationId: orgE, role: 'hiring_manager' as const };
    const decided = await tenant(HM.id, orgE, (tx) => svc.decideOffer(tx, hm, offer.id, { status: 'accepted', fillRequisition: true }));
    assert.equal(decided.status, 'accepted');
    const hired = await db.submission.findUniqueOrThrow({ where: { id: sub } });
    assert.equal(hired.stage, 'hired');
    assert.ok(hired.hiredAt);
    assert.equal((await db.requisition.findUniqueOrThrow({ where: { id: reqId } })).status, 'filled');
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: jobId } })).activeState, 'closed', 'the posting closes with the requisition, stated by its source');
    await status(tenant(HM.id, orgE, (tx) => svc.decideOffer(tx, hm, offer.id, { status: 'declined' })), 409);
    assert.equal(await auditCount('employer.offer.decided', offer.id), 1);
    assert.equal(await auditCount('employer.submission.moved', sub), 4, 'screening, interviewing, offered, hired');
    const detail = await tenant(REC.id, orgE, (tx) => svc.loadSubmission(tx, rec(), sub));
    assert.equal(detail.events.map((e) => e.toStage).join(' '), 'consent_requested consented screening interviewing offered hired');
    assert.equal(detail.interviews.length, 1);
    assert.equal(detail.notes.length, 1);
    assert.equal(detail.offers.length, 1);
  });

  it('reporting counts the organisation\'s own funnel, sources and activity, with no identity', async () => {
    const r = await tenant(REC.id, orgE, (tx) => svc.reporting(tx, rec(), { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }));
    assert.equal(r.funnel.submissions, 2);
    assert.equal(r.funnel.consented, 2);
    assert.equal(r.funnel.hired, 1);
    assert.equal(r.funnel.withdrawn, 1);
    assert.deepEqual(r.sources.sourced, { submissions: 1, hires: 1 });
    assert.deepEqual(r.sources.applied, { submissions: 1, hires: 0 });
    assert.equal(r.daysTo.hire, 0);
    assert.ok(!JSON.stringify(r).includes(ANON.fullName) && !JSON.stringify(r).includes(ANON.email));
    const empty = await tenant(OF.id, orgF, (tx) => svc.reporting(tx, adminF(), { from: new Date(0), to: new Date() }));
    assert.equal(empty.funnel.submissions, 0, 'another employer sees its own nothing');
    await status(tenant(INT.id, orgE, (tx) => svc.reporting(tx, { user: INT, organizationId: orgE, role: 'interviewer' }, { from: new Date(0), to: new Date() })), 403);
  });

  it('isolation: another employer cannot load, move or read anything of E\'s; the candidates see none of the pipeline; the audit trail carries ids and kinds only', async () => {
    await status(tenant(OF.id, orgF, (tx) => svc.loadRequisition(tx, adminF(), reqId)), 404);
    await status(tenant(OF.id, orgF, (tx) => svc.loadSubmission(tx, adminF(), anonSubmissionId)), 404);
    await status(tenant(OF.id, orgF, (tx) => svc.moveSubmission(tx, adminF(), anonSubmissionId, 'rejected')), 404);
    for (const model of ['submission', 'employerNote', 'employerInterview', 'offer'] as const) {
      assert.equal(await tenant(OF.id, orgF, (tx) => (tx[model] as unknown as { count: (a: { where: { organizationId: string } }) => Promise<number> }).count({ where: { organizationId: orgE } })), 0, `${model}: F sees nothing of E under RLS`);
      assert.equal(await tenant(ANON.id, undefined, (tx) => (tx[model] as unknown as { count: (a: { where: { organizationId: string } }) => Promise<number> }).count({ where: { organizationId: orgE } })), 0, `${model}: the candidate sees none of it`);
    }
    assert.equal(await tenant(VW.id, orgE, (tx) => tx.submission.count({ where: { organizationId: orgE } })), 2, 'RLS is organisational; the service, not the policy, keeps a viewer read-only');
    const audits = await db.auditLog.findMany({ where: { action: { startsWith: 'employer.' } } });
    assert.ok(audits.every((a) => !JSON.stringify(a).includes(ANON.email) && !JSON.stringify(a).includes('Strong SQL')), 'ids and kinds in the audit trail, never a name, an email or feedback');
    assert.equal(CANDIDATES.length, 3);
  });
});

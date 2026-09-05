/**
 * Stage 17 (ADR-0032) - case management against PostgreSQL: who may act,
 * the client's consent as the gate on every read about them, assignment
 * gating inside the organisation and strict isolation between
 * organisations (RLS), the RESTRICTED rows audited on every read and write
 * and invisible to the client, the action plan, outcomes with retention
 * follow-ups, the copilot writing recommendations and NOTHING else, the
 * case manager deciding, withdrawal, and the per-organisation retention
 * purge that touches no organisation without a policy.
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
type Svc = typeof import('../src/lib/cases/service');
type View = typeof import('../src/lib/cases/client-view');
type Run = typeof import('../src/lib/cases/copilot-run');
type Orgs = typeof import('../src/lib/tenancy/organizations');
type Ctx = typeof import('../src/lib/tenancy/context');

const S = randomBytes(4).toString('hex');
const mk = (tag: string, name: string) => ({ id: `cs_${tag}_${S}`, email: `cs-${tag}-${S}@cases.test`, fullName: name });
const OA = mk('oa', 'Owner A');
const SUP = mk('sup', 'Supervisor A');
const CM1 = mk('cm1', 'Case Manager One');
const CM2 = mk('cm2', 'Case Manager Two');
const VIEW = mk('view', 'Viewer A');
const OB = mk('ob', 'Owner B');
const OE = mk('oe', 'Owner Employer');
const CL = mk('cl', 'Client One');
const CL2 = mk('cl2', 'Client Two');
/** Invited before any account exists with the address; signs up later. */
const LATE = mk('late', 'Late Signup');
const ALL = [OA, SUP, CM1, CM2, VIEW, OB, OE, CL, CL2, LATE];

let db: Db;
let svc: Svc;
let view: View;
let copilot: Run;
let orgs: Orgs;
let ctx: Ctx;
let orgA = '';
let orgB = '';
let orgE = '';
let caseId = '';
let lateCaseId = '';
let secondCaseId = '';
let bCaseId = '';
const noteBody = `Client disclosed a private matter ${S}`;

describe('cases - roles, consent, isolation, restricted rows, plan, outcomes, copilot, retention', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    svc = await import('../src/lib/cases/service');
    view = await import('../src/lib/cases/client-view');
    copilot = await import('../src/lib/cases/copilot-run');
    orgs = await import('../src/lib/tenancy/organizations');
    ctx = await import('../src/lib/tenancy/context');
    for (const u of ALL) {
      if (u === LATE) continue; // signs up after being invited
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName, country: 'CA' } });
      await orgs.ensurePersonalWorkspace(db, u);
    }
    // a service-provider organisation is not self-serve (Stage 17 review): the service refuses without the staff verification flag
    await assert.rejects(() => orgs.createOrganization(OA.id, { name: `Provider A ${S}`, type: 'service_provider', billingEmail: OA.email }), (e: unknown) => e instanceof orgs.OrganizationAccessError && e.status === 403);
    orgA = (await orgs.createOrganization(OA.id, { name: `Provider A ${S}`, type: 'service_provider', billingEmail: OA.email }, { verifiedOrganization: true })).id;
    orgB = (await orgs.createOrganization(OB.id, { name: `Provider B ${S}`, type: 'service_provider', billingEmail: OB.email }, { verifiedOrganization: true })).id;
    orgE = (await orgs.createOrganization(OE.id, { name: `Employer ${S}`, type: 'employer', billingEmail: OE.email }, { verifiedOrganization: true })).id;
    for (const [u, serviceRole] of [
      [SUP, 'supervisor'],
      [CM1, 'case_manager'],
      [CM2, 'case_manager'],
      [VIEW, null],
    ] as const) {
      await orgs.inviteMember(OA.id, orgA, { userId: u.id, role: 'member' });
      await orgs.acceptInvitation(u.id, orgA);
      if (serviceRole) await db.membership.update({ where: { organizationId_userId: { organizationId: orgA, userId: u.id } }, data: { serviceRole } });
    }
    // CM1 is also a member of the employer organisation - the wrong type for case work
    await orgs.inviteMember(OE.id, orgE, { userId: CM1.id, role: 'admin' });
    await orgs.acceptInvitation(CM1.id, orgE);
  });
  after(async () => {
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ALL.map((u) => u.id) } }, { entityId: { in: [orgA, orgB] } }] } });
    await db.organization.deleteMany({ where: { id: { in: [orgA, orgB, orgE] } } });
    await db.user.deleteMany({ where: { id: { in: ALL.map((u) => u.id) } } });
    await db.$disconnect();
  });

  const tenant = <T,>(userId: string, organizationId: string | undefined, fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId, organizationId }, fn);
  const actorOf = (u: { id: string; email: string }, org = orgA) => svc.requireCaseActor(u, org);
  const status = (p: Promise<unknown>, code: number, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof svc.CaseError && e.status === code && (!re || re.test(e.message)));
  const auditCount = (action: string, entityId?: string) => db.auditLog.count({ where: { action, ...(entityId ? { entityId } : {}) } });

  it('the actor resolves from an accepted membership of a SERVICE-PROVIDER organisation; anything else is 404; the role is the named set', async () => {
    await status(svc.requireCaseActor(OB, orgA), 404);
    await status(svc.requireCaseActor(CM1, orgE), 404, /not found/);
    assert.equal((await actorOf(OA)).role, 'admin');
    assert.equal((await actorOf(SUP)).role, 'supervisor');
    assert.equal((await actorOf(CM1)).role, 'case_manager');
    assert.equal((await actorOf(VIEW)).role, 'viewer');
    const mine = await svc.serviceProviderMemberships(CM1.id);
    assert.deepEqual(mine.map((m) => m.organizationId), [orgA], 'the employer membership is not a case membership');
  });

  it('a supervisor invites by email and the accounts table is never consulted: the answer is the same with or without an account; the audit row carries a digest, never the address; a case manager cannot invite', async () => {
    await status(svc.inviteClient(await actorOf(CM1), { email: CL.email }), 403);
    await status(svc.inviteClient(await actorOf(SUP), { email: CL.email, caseManagerId: VIEW.id }), 422, /cannot be assigned/);
    // no account exists with LATE's address yet - the invitation is recorded all the same
    const late = await svc.inviteClient(await actorOf(SUP), { email: LATE.email.toUpperCase() });
    lateCaseId = late.id;
    assert.equal(late.status, 'invited');
    assert.equal(late.clientUserId, null);
    assert.equal(late.invitedEmail, LATE.email, 'normalised');
    const c = await svc.inviteClient(await actorOf(SUP), { email: CL.email, caseManagerId: CM1.id, employmentGoal: 'Return to office work' });
    caseId = c.id;
    assert.equal(c.status, 'invited');
    assert.equal(c.clientUserId, null, 'nobody is linked until they accept');
    assert.equal(await auditCount('case.invited', c.id), 1);
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'case.invited', entityId: c.id } });
    assert.ok(!JSON.stringify(row).includes(CL.email), 'the address is not in the audit trail');
    assert.ok(row.after.includes('emailDigest'));
    await status(svc.inviteClient(await actorOf(SUP), { email: CL.email }), 409);
    await status(svc.inviteClient(await actorOf(SUP), { email: LATE.email }), 409, /already has a case/);
    // nothing is read about the client before consent
    await status(view.readClientSummary(await actorOf(CM1), c.id), 403, /not consented/);
    await status(copilot.runCopilot(await actorOf(CM1), c.id), 403);
    await status(tenant(CM1.id, orgA, (tx) => svc.addNote(tx, { user: CM1, organizationId: orgA, role: 'case_manager' }, c.id, 'x')), 409);
    // the caseload shows the addresses the supervisor typed, and no name
    const load = await tenant(SUP.id, orgA, (tx) => svc.listCaseload(tx, { user: SUP, organizationId: orgA, role: 'supervisor' }));
    assert.deepEqual(load.cases.map((x) => x.client).sort((a, b) => a.email!.localeCompare(b.email!)), [{ name: null, email: CL.email }, { name: null, email: LATE.email }]);
  });

  it('the client sees an invitation addressed to their account email and nobody else does; only the client answers; accepting links them and records consent in one transaction; the linked row is SELECT-only for them under RLS', async () => {
    assert.equal((await tenant(CL.id, undefined, (tx) => svc.listClientCases(tx, CL))).length, 1);
    assert.equal((await tenant(CL2.id, undefined, (tx) => svc.listClientCases(tx, CL2))).length, 0);
    assert.equal(await tenant(CL.id, undefined, (tx) => tx.case.count({ where: { id: caseId } })), 0, 'not on the tenant path until linked');
    assert.equal(await tenant(OB.id, orgB, (tx) => tx.case.count({ where: { id: caseId } })), 0, 'another provider sees nothing');
    await status(svc.respondToInvitation(CL2, caseId, true), 404);
    const consentsBefore = await db.consentRecord.count({ where: { userId: CL.id, purpose: 'employment_services_case' } });
    const opened = await svc.respondToInvitation(CL, caseId, true);
    assert.equal(opened.status, 'open');
    assert.equal(opened.clientUserId, CL.id);
    assert.equal(opened.invitedName, CL.fullName, 'the name is snapshotted at acceptance');
    assert.ok(opened.consentedAt && opened.consentRecordId);
    const consent = await db.consentRecord.findUniqueOrThrow({ where: { id: opened.consentRecordId! } });
    assert.equal(consent.purpose, 'employment_services_case');
    assert.equal(consent.source, 'settings');
    assert.equal(await db.consentRecord.count({ where: { userId: CL.id, purpose: 'employment_services_case' } }), consentsBefore + 1);
    assert.equal(await auditCount('case.consented', caseId), 1);
    await status(svc.respondToInvitation(CL, caseId, true), 409);
    // now the row is the client's to SEE on the tenant path - and only to see (M3)
    assert.equal(await tenant(CL.id, undefined, (tx) => tx.case.count({ where: { id: caseId } })), 1);
    await assert.rejects(() => tenant(CL.id, undefined, (tx) => tx.case.update({ where: { id: caseId }, data: { status: 'closed' } })), 'the client cannot write the case on the tenant path');
    assert.equal((await tenant(CL.id, undefined, (tx) => tx.case.deleteMany({ where: { id: caseId } }))).count, 0, 'the client cannot delete the case on the tenant path');
    assert.equal(await db.case.count({ where: { id: caseId } }), 1);
    assert.equal((await db.case.findUniqueOrThrow({ where: { id: caseId } })).status, 'open');
    // the case consent is not a self-service toggle: the candidate API neither lists nor sets it
    const api = await import('../src/lib/integrations/candidate-api');
    assert.ok(!(await api.listConsents(CL.id)).some((c) => c.purpose === 'employment_services_case'));
    await assert.rejects(() => api.setConsent(CL.id, 'employment_services_case', false, {}), /managed with the case/);
  });

  it('a person invited before signing up sees the invitation once their account exists; declining records nothing about them, and the platform does not re-invite a person who declined', async () => {
    await db.user.create({ data: { id: LATE.id, email: LATE.email, passwordHash: 'x', fullName: LATE.fullName, country: 'CA' } });
    await orgs.ensurePersonalWorkspace(db, LATE);
    const mine = await tenant(LATE.id, undefined, (tx) => svc.listClientCases(tx, LATE));
    assert.deepEqual(mine.map((c) => c.id), [lateCaseId]);
    assert.equal(mine[0]!.organization.name, `Provider A ${S}`);
    const declined = await svc.respondToInvitation(LATE, lateCaseId, false);
    assert.equal(declined.status, 'declined');
    assert.equal(declined.clientUserId, null, 'declining links nobody');
    assert.equal(declined.invitedName, '');
    assert.equal(await auditCount('case.declined', lateCaseId), 1);
    await status(svc.respondToInvitation(LATE, lateCaseId, true), 409);
    await status(svc.inviteClient(await actorOf(SUP), { email: LATE.email }), 409, /declined an earlier invitation/);
    const load = await tenant(SUP.id, orgA, (tx) => svc.listCaseload(tx, { user: SUP, organizationId: orgA, role: 'supervisor' }, { status: 'declined' }));
    assert.deepEqual(load.cases.map((x) => x.client), [{ name: null, email: LATE.email }], 'the address the supervisor typed, nothing more');
  });

  it('assignment gates the case manager; a supervisor reads everything and writes nothing; a viewer sees counts only; another provider sees nothing', async () => {
    const cm1 = { user: CM1, organizationId: orgA, role: 'case_manager' as const };
    const cm2 = { user: CM2, organizationId: orgA, role: 'case_manager' as const };
    const sup = { user: SUP, organizationId: orgA, role: 'supervisor' as const };
    assert.equal((await tenant(CM1.id, orgA, (tx) => svc.loadCase(tx, cm1, caseId))).canWrite, true);
    await status(tenant(CM2.id, orgA, (tx) => svc.loadCase(tx, cm2, caseId)), 404);
    assert.equal((await tenant(CM2.id, orgA, (tx) => svc.listCaseload(tx, cm2))).cases.length, 0);
    const s = await tenant(SUP.id, orgA, (tx) => svc.loadCase(tx, sup, caseId));
    assert.equal(s.canWrite, false);
    assert.equal(s.client.name, CL.fullName, 'after consent the name is shown');
    await status(tenant(SUP.id, orgA, (tx) => svc.addNote(tx, sup, caseId, 'no')), 403);
    const v = await tenant(VIEW.id, orgA, (tx) => svc.listCaseload(tx, { user: VIEW, organizationId: orgA, role: 'viewer' }));
    assert.deepEqual(v.cases, []);
    assert.equal(v.aggregate.open, 1);
    await status(tenant(OB.id, orgB, (tx) => svc.loadCase(tx, { user: OB, organizationId: orgB, role: 'admin' }, caseId)), 404);
    // re-assignment by a supervisor; the viewer cannot be assigned
    await status(tenant(SUP.id, orgA, (tx) => svc.assignCaseManager(tx, sup, caseId, VIEW.id)), 422);
    await status(tenant(CM1.id, orgA, (tx) => svc.assignCaseManager(tx, cm1, caseId, CM2.id)), 403);
    await tenant(SUP.id, orgA, (tx) => svc.assignCaseManager(tx, sup, caseId, CM2.id));
    await status(tenant(CM1.id, orgA, (tx) => svc.loadCase(tx, cm1, caseId)), 404, undefined);
    await tenant(SUP.id, orgA, (tx) => svc.assignCaseManager(tx, sup, caseId, CM1.id));
    assert.equal(await auditCount('case.assigned', caseId), 2);
  });

  it('a case note is RESTRICTED: written and read with an audit row first (never the body), invisible to the client and to another provider, readable by a supervisor', async () => {
    const cm1 = { user: CM1, organizationId: orgA, role: 'case_manager' as const };
    const before = await auditCount('case.note.written', caseId);
    const note = await tenant(CM1.id, orgA, (tx) => svc.addNote(tx, cm1, caseId, noteBody));
    assert.equal(await auditCount('case.note.written', caseId), before + 1);
    const rows = await db.auditLog.findMany({ where: { action: { startsWith: 'case.note' }, entityId: caseId } });
    assert.ok(rows.every((r) => !r.summary.includes(noteBody) && !r.after.includes(noteBody) && !JSON.stringify(r).includes('private matter')), 'no note text in the audit trail');
    const read = await tenant(SUP.id, orgA, (tx) => svc.listNotes(tx, { user: SUP, organizationId: orgA, role: 'supervisor' }, caseId));
    assert.equal(read[0]?.id, note.id);
    assert.equal(await auditCount('case.note.read', caseId), 1);
    await status(tenant(CM2.id, orgA, (tx) => svc.listNotes(tx, { user: CM2, organizationId: orgA, role: 'case_manager' }, caseId)), 404);
    assert.equal(await tenant(CL.id, undefined, (tx) => tx.caseNote.count({ where: { caseId } })), 0, 'the client cannot see the notes about them (RESTRICTED; they see the case row only)');
    assert.equal(await tenant(OB.id, orgB, (tx) => tx.caseNote.count({ where: { caseId } })), 0, 'another provider cannot');
    assert.equal(await tenant(VIEW.id, orgA, (tx) => tx.caseNote.count({ where: { caseId } })), 1, 'RLS is organisational: the service layer, not the policy, keeps the viewer out');
    await status(tenant(VIEW.id, orgA, (tx) => svc.listNotes(tx, { user: VIEW, organizationId: orgA, role: 'viewer' }, caseId)), 404);
    // an assessment likewise; the barrier text is not in the audit row
    await tenant(CM1.id, orgA, (tx) => svc.addAssessment(tx, cm1, caseId, { kind: 'intake', summary: 'Intake summary', barriers: ['transport', `health ${S}`], employmentGoal: 'Administrative work' }));
    assert.equal(await auditCount('case.assessment.written', caseId), 1);
    const aRows = await db.auditLog.findMany({ where: { action: 'case.assessment.written', entityId: caseId } });
    assert.ok(aRows.every((r) => !JSON.stringify(r).includes('transport') && !JSON.stringify(r).includes(`health ${S}`)));
    assert.equal((await db.case.findUniqueOrThrow({ where: { id: caseId } })).employmentGoal, 'Administrative work');
  });

  it('the action plan: a referral needs a licensed offering; tasks move; an employment outcome creates three retention follow-ups', async () => {
    const cm1 = { user: CM1, organizationId: orgA, role: 'case_manager' as const };
    await status(tenant(CM1.id, orgA, (tx) => svc.addTask(tx, cm1, caseId, { kind: 'referral', title: 'Course' })), 422);
    await status(tenant(CM1.id, orgA, (tx) => svc.addTask(tx, cm1, caseId, { kind: 'referral', title: 'Course', offeringId: 'nope' })), 422);
    const t = await tenant(CM1.id, orgA, (tx) => svc.addTask(tx, cm1, caseId, { kind: 'task', title: 'Update the résumé' }));
    const done = await tenant(CM1.id, orgA, (tx) => svc.updateTask(tx, cm1, t.id, { status: 'done' }));
    assert.ok(done.completedAt);
    await status(tenant(CM2.id, orgA, (tx) => svc.updateTask(tx, { user: CM2, organizationId: orgA, role: 'case_manager' }, t.id, { status: 'dropped' })), 404);
    const outcome = await tenant(CM1.id, orgA, (tx) => svc.recordOutcome(tx, cm1, caseId, { kind: 'employed', employerName: 'Acme', startDate: new Date('2026-09-01T00:00:00Z') }));
    const follow = await db.caseFollowUp.findMany({ where: { outcomeId: outcome.id }, orderBy: { dueAt: 'asc' } });
    assert.deepEqual(follow.map((f) => f.dueAt.toISOString().slice(0, 10)), ['2026-09-29', '2026-11-24', '2027-02-16']);
    const r = await tenant(CM1.id, orgA, (tx) => svc.updateFollowUp(tx, cm1, follow[0]!.id, { status: 'retained' }));
    assert.equal(r.status, 'retained');
    // another provider's admin cannot touch A's follow-up or task by id
    await status(tenant(OB.id, orgB, (tx) => svc.updateFollowUp(tx, { user: OB, organizationId: orgB, role: 'admin' }, follow[1]!.id, { status: 'not_retained' })), 404);
    await status(tenant(OB.id, orgB, (tx) => svc.updateTask(tx, { user: OB, organizationId: orgB, role: 'admin' }, t.id, { status: 'dropped' })), 404);
    const none = await tenant(CM1.id, orgA, (tx) => svc.recordOutcome(tx, cm1, caseId, { kind: 'not_employed' }));
    assert.equal(await db.caseFollowUp.count({ where: { outcomeId: none.id } }), 0);
  });

  it('the copilot reads only non-restricted signals, writes recommendations and nothing else (audited), refreshes without duplicates, and the case manager decides', async () => {
    const cm1 = { user: CM1, organizationId: orgA, role: 'case_manager' as const };
    // the client's job search: 10 submissions with no response, three location exclusions, five weak-seniority matches
    const job = await db.job.create({ data: { title: `Analyst ${S}`, company: 'Co', location: 'Toronto, ON', description: '', externalId: `cs_${S}`, source: 'mock', postedAt: new Date() } });
    const jobs: { id: string }[] = [];
    for (let i = 0; i < 10; i += 1) {
      // one application per posting (unique on user + job)
      const j = i === 0 ? job : await db.job.create({ data: { title: `Analyst ${i} ${S}`, company: 'Co', location: 'Toronto, ON', description: '', externalId: `cs_${i}_${S}`, source: 'mock', postedAt: new Date() } });
      jobs.push(j);
      const a = await db.application.create({ data: { userId: CL.id, jobId: j.id, status: 'submitted' } });
      await db.applicationStatusHistory.create({ data: { userId: CL.id, applicationId: a.id, fromStatus: 'applying', toStatus: 'submitted', actor: 'user', source: 'test' } });
    }
    for (let i = 0; i < 3; i += 1) {
      const j = await db.job.create({ data: { title: `Far ${i} ${S}`, company: 'Co', location: 'Calgary, AB', description: '', externalId: `cs_far_${i}_${S}`, source: 'mock', postedAt: new Date() } });
      await db.eligibilityResult.create({ data: { userId: CL.id, jobId: j.id, outcome: 'ineligible', rules: JSON.stringify([{ rule: 'location', status: 'fail', reason: 'Calgary is not among your locations.', hard: true }]), rulesVersion: 'test' } });
    }
    const agent = await db.agent.create({ data: { userId: CL.id, name: `Agent ${S}` } });
    for (let i = 0; i < 5; i += 1) {
      const m = await db.jobMatch.create({ data: { agentId: agent.id, jobId: jobs[i]!.id, matchScore: 40 } });
      await db.matchDimension.create({ data: { jobMatchId: m.id, userId: CL.id, dimension: 'seniority', score: 20, weight: 1, contribution: 0 } });
    }
    const snapshot = async () => ({
      applications: await db.application.count({ where: { userId: CL.id } }),
      history: await db.applicationStatusHistory.count({ where: { userId: CL.id } }),
      skills: await db.candidateSkill.count({ where: { userId: CL.id } }),
      notes: await db.caseNote.count({ where: { caseId } }),
      assessments: await db.caseAssessment.count({ where: { caseId } }),
      tasks: await db.caseTask.count({ where: { caseId } }),
      caseRow: JSON.stringify(await db.case.findUnique({ where: { id: caseId } })),
    });
    const before = await snapshot();
    await status(copilot.runCopilot({ user: SUP, organizationId: orgA, role: 'supervisor' }, caseId), 403, /assigned case manager/);
    const run1 = await copilot.runCopilot(cm1, caseId);
    assert.ok(run1.patterns.includes('poor_response_rate'));
    assert.ok(run1.patterns.includes('geographic_constraints'));
    assert.ok(run1.patterns.includes('unrealistic_seniority'));
    assert.ok(run1.patterns.includes('resume_problems'), 'no résumé on the platform');
    assert.deepEqual(await snapshot(), before, 'nothing but recommendations changed');
    assert.equal(await auditCount('case.copilot.run', caseId), 1);
    assert.equal(await auditCount('case.client.read', caseId), 1, 'the delegated read was audited');
    const { signals } = await view.clientSignalsFor(cm1, caseId);
    assert.ok(!JSON.stringify(signals).includes('private matter') && !JSON.stringify(signals).includes('transport'), 'no note or barrier in the signals');
    const open = await db.caseRecommendation.findMany({ where: { caseId, status: 'open' } });
    assert.equal(open.length, run1.patterns.length);
    const run2 = await copilot.runCopilot(cm1, caseId);
    assert.equal(run2.added, 0);
    assert.equal(run2.refreshed, run1.patterns.length);
    assert.equal(await db.caseRecommendation.count({ where: { caseId, status: 'open' } }), open.length, 'no duplicates');
    // the case manager decides: accepting with a task creates the task citing the recommendation; dismissing creates nothing
    const rec = open.find((r) => r.pattern === 'poor_response_rate')!;
    await status(tenant(OB.id, orgB, (tx) => svc.decideRecommendation(tx, { user: OB, organizationId: orgB, role: 'admin' }, rec.id, { status: 'accepted' })), 404, undefined);
    const decided = await tenant(CM1.id, orgA, (tx) => svc.decideRecommendation(tx, cm1, rec.id, { status: 'accepted', createTask: { kind: 'intervention', title: 'Review targeting together' } }));
    assert.equal(decided.task?.recommendationId, rec.id);
    const rec2 = open.find((r) => r.pattern === 'geographic_constraints')!;
    const dismissed = await tenant(CM1.id, orgA, (tx) => svc.decideRecommendation(tx, cm1, rec2.id, { status: 'dismissed', note: 'Client cannot travel.' }));
    assert.equal(dismissed.task, null);
    await status(tenant(CM1.id, orgA, (tx) => svc.decideRecommendation(tx, cm1, rec2.id, { status: 'accepted' })), 409);
    assert.equal(await auditCount('case.recommendation.decided'), 2);
    // a decided recommendation is not reopened by the next run; a pattern that goes away is superseded
    await db.matchDimension.deleteMany({ where: { userId: CL.id } });
    const run3 = await copilot.runCopilot(cm1, caseId);
    assert.equal(run3.superseded, 1, 'unrealistic_seniority is gone');
    assert.equal((await db.caseRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status, 'accepted');
    // the summary a case manager sees
    const summary = await view.readClientSummary(cm1, caseId);
    assert.equal(summary.counts.submitted, 10);
    assert.equal(summary.client.name, CL.fullName);
    assert.ok(!JSON.stringify(summary).includes('private matter'));
  });

  it('consent is per case: a second provider gets its own consent record, and withdrawing from one closes exactly that one', async () => {
    const b = await svc.inviteClient(await actorOf(OB, orgB), { email: CL.email, caseManagerId: OB.id });
    bCaseId = b.id;
    const openedB = await svc.respondToInvitation(CL, b.id, true);
    assert.notEqual(openedB.consentRecordId, (await db.case.findUniqueOrThrow({ where: { id: caseId } })).consentRecordId, 'a record per case');
    const admB = { user: OB, organizationId: orgB, role: 'admin' as const };
    assert.equal((await view.readClientSummary(admB, b.id)).client.name, CL.fullName);
    await svc.withdrawFromCase(CL, b.id);
    await status(view.readClientSummary(admB, b.id), 403, /not open|withdrew/);
    // A's case is untouched: its own consent record is current
    assert.equal((await view.readClientSummary({ user: CM1, organizationId: orgA, role: 'case_manager' }, caseId)).client.name, CL.fullName);
    assert.equal((await db.case.findUniqueOrThrow({ where: { id: caseId } })).status, 'open');
  });

  it('the client withdraws: the case closes, the consent is revoked, nothing more is read; the closed case shows the snapshotted name; a close reason is one of the named set', async () => {
    await status(svc.withdrawFromCase(CL2, caseId), 404);
    await svc.withdrawFromCase(CL, caseId);
    const c = await db.case.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(c.status, 'closed');
    assert.equal(c.closedReason, 'client_withdrew');
    assert.ok((await db.consentRecord.findUniqueOrThrow({ where: { id: c.consentRecordId! } })).revokedAt);
    await status(view.readClientSummary({ user: CM1, organizationId: orgA, role: 'case_manager' }, caseId), 403);
    await status(tenant(CM1.id, orgA, (tx) => svc.addNote(tx, { user: CM1, organizationId: orgA, role: 'case_manager' }, caseId, 'x')), 409);
    assert.equal(await auditCount('case.closed', caseId), 1);
    const sup = { user: SUP, organizationId: orgA, role: 'supervisor' as const };
    assert.deepEqual((await tenant(SUP.id, orgA, (tx) => svc.loadCase(tx, sup, caseId))).client, { name: CL.fullName, email: CL.email }, 'from the snapshot');
    await status(tenant(SUP.id, orgA, (tx) => svc.closeCase(tx, sup, caseId, 'free text' as never)), 422);
    await status(tenant(SUP.id, orgA, (tx) => svc.closeCase(tx, sup, caseId, 'other')), 409, /already closed/);
  });

  it('a new engagement is a NEW case: re-inviting after closure never reopens the old row or its restricted rows', async () => {
    const again = await svc.inviteClient(await actorOf(SUP), { email: CL.email, caseManagerId: CM1.id });
    secondCaseId = again.id;
    assert.notEqual(again.id, caseId);
    assert.equal(again.status, 'invited');
    assert.equal(await db.caseNote.count({ where: { caseId } }), 1, 'the old case keeps its note');
    assert.equal(await db.caseNote.count({ where: { caseId: again.id } }), 0);
    const opened = await svc.respondToInvitation(CL, again.id, true);
    assert.equal(opened.status, 'open');
    await status(svc.inviteClient(await actorOf(SUP), { email: CL.email }), 409, /already has a case/);
    assert.equal((await db.case.findUniqueOrThrow({ where: { id: caseId } })).status, 'closed', 'the old case stays closed');
    const cm1 = { user: CM1, organizationId: orgA, role: 'case_manager' as const };
    assert.equal((await tenant(CM1.id, orgA, (tx) => svc.listNotes(tx, cm1, again.id))).length, 0, 'the earlier engagement is not readable through the new case');
    await tenant(CM1.id, orgA, (tx) => svc.addNote(tx, cm1, again.id, 'Second engagement note'));
  });

  it('retention: only an admin sets a policy, within bounds; the purge thins CLOSED cases only (from closure), removes old closed cases with everything under them (counted), and touches an organisation without a policy not at all', async () => {
    await status(svc.setRetentionPolicy({ user: CM1, organizationId: orgA, role: 'case_manager' }, { caseNoteDays: 365, closedCaseDays: 730 }), 403);
    await status(svc.setRetentionPolicy({ user: OA, organizationId: orgA, role: 'admin' }, { caseNoteDays: 5, closedCaseDays: 730 }), 422);
    await svc.setRetentionPolicy({ user: OA, organizationId: orgA, role: 'admin' }, { caseNoteDays: 365, closedCaseDays: 730, note: 'Programme rule X' });
    assert.equal(await auditCount('case.retention.set'), 1);
    const old = new Date(Date.now() - 400 * 86_400_000);
    // an OLD note on the OPEN second case: never thinned by age
    await db.caseNote.updateMany({ where: { caseId: secondCaseId }, data: { createdAt: old } });
    // the closed first case: closed today, so its old note and assessment stay for now
    await db.caseNote.updateMany({ where: { caseId }, data: { createdAt: old } });
    const r0 = await svc.purgeExpiredCaseRecords();
    assert.deepEqual([r0.notes, r0.assessments, r0.cases], [0, 0, 0], 'closed today: nothing expires yet');
    // closed 400 days ago: its RESTRICTED rows expire; the case itself (730) stays; B (no policy) is untouched
    await db.case.update({ where: { id: caseId }, data: { closedAt: old } });
    const bCase = await db.case.create({ data: { organizationId: orgB, invitedEmail: CL2.email, clientUserId: CL2.id, status: 'closed', closedAt: new Date(Date.now() - 3000 * 86_400_000), createdById: OB.id } });
    await db.caseNote.create({ data: { caseId: bCase.id, organizationId: orgB, authorId: OB.id, body: 'old', createdAt: old } });
    const r1 = await svc.purgeExpiredCaseRecords();
    assert.equal(r1.organizations, 1);
    assert.equal(r1.notes, 1);
    assert.equal(r1.assessments, 1);
    assert.equal(r1.cases, 0, 'closed 400 days ago, kept for 730');
    assert.equal(await db.caseNote.count({ where: { caseId } }), 0);
    assert.equal(await db.caseNote.count({ where: { caseId: secondCaseId } }), 1, 'the open case keeps its old note');
    assert.equal(await db.caseNote.count({ where: { caseId: bCase.id } }), 1, 'no policy, no purge');
    assert.equal(await db.case.count({ where: { id: bCaseId } }), 1);
    assert.equal(await auditCount('case.retention.purged', orgA), 1);
    // the closed case itself goes once it is older than the policy, with everything under it, and the audit row counts what went
    await db.case.update({ where: { id: caseId }, data: { closedAt: new Date(Date.now() - 800 * 86_400_000) } });
    const under = { caseId };
    const expectedChildren = (await db.caseTask.count({ where: under })) + (await db.caseOutcome.count({ where: under })) + (await db.caseFollowUp.count({ where: under })) + (await db.caseRecommendation.count({ where: under }));
    assert.ok(expectedChildren > 0);
    const r2 = await svc.purgeExpiredCaseRecords();
    assert.equal(r2.cases, 1);
    assert.equal(r2.children, expectedChildren);
    assert.equal(await db.case.count({ where: { id: caseId } }), 0);
    assert.equal(await db.caseTask.count({ where: { caseId } }), 0);
    assert.equal(await db.case.count({ where: { id: secondCaseId } }), 1);
    assert.equal(await db.case.count({ where: { id: bCase.id } }), 1);
    const purged = await db.auditLog.findFirst({ where: { action: 'case.retention.purged', entityId: orgA }, orderBy: { createdAt: 'desc' } });
    assert.ok(purged?.after.includes(`"children":${expectedChildren}`));
  });

  it('invitations are rate-limited per supervisor account', async () => {
    const admB = await actorOf(OB, orgB);
    // OB has sent one invitation in this run (to CL); the window allows thirty
    for (let i = 0; i < 29; i += 1) await svc.inviteClient(admB, { email: `bulk-${i}-${S}@cases.test` });
    await status(svc.inviteClient(admB, { email: `bulk-last-${S}@cases.test` }), 429);
  });
});

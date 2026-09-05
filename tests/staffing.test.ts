/**
 * Stage 19 (ADR-0034) - staffing against PostgreSQL: who may act, client
 * contracts and fee structures (the client pays, always), engagements with
 * recruiter ownership, representation as the candidate's consent (invited by
 * email, granted in one transaction, revocable, SELECT-only for them under
 * RLS), placements with a frozen fee and a stored jurisdiction evaluation,
 * invoicing refused under unrecorded rules and issued in the PL book once
 * counsel's answer is recorded, the guarantee credit, productivity, and the
 * separation proof: the candidate is never a party to any of it.
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
type Svc = typeof import('../src/lib/staffing/service');
type Orgs = typeof import('../src/lib/tenancy/organizations');
type Ctx = typeof import('../src/lib/tenancy/context');

const S = randomBytes(4).toString('hex');
const mk = (tag: string, name: string) => ({ id: `st_${tag}_${S}`, email: `st-${tag}-${S}@staffing.test`, fullName: name });
const OA = mk('oa', 'Owner Agency');
const REC = mk('rec', 'Recruiter A');
const DEL = mk('del', 'Delivery A');
const FIN = mk('fin', 'Finance A');
const VW = mk('vw', 'Viewer A');
const OB = mk('ob', 'Owner Other Agency');
const CAND = mk('cand', 'Placed Candidate');
const CAND2 = mk('cand2', 'Other Candidate');
const ALL = [OA, REC, DEL, FIN, VW, OB, CAND, CAND2];
const STAFF = { id: `st_staff_${S}`, email: `st-staff-${S}@staffing.test`, fullName: 'Staff Admin', role: 'admin' as const, storedRole: 'admin' };

let db: Db;
let svc: Svc;
let orgs: Orgs;
let ctx: Ctx;
let orgA = '';
let orgB = '';
let contractId = '';
let feeId = '';
let engagementId = '';
let repId = '';
let placementId = '';
let invoiceId = '';

describe('staffing - roles, contracts, fees, engagements, representation, placements, invoicing, separation', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    svc = await import('../src/lib/staffing/service');
    orgs = await import('../src/lib/tenancy/organizations');
    ctx = await import('../src/lib/tenancy/context');
    for (const u of ALL) {
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName, country: 'CA', onboardedAt: new Date() } });
      await orgs.ensurePersonalWorkspace(db, u);
    }
    // Stage 19 review (H1): an agency is a VERIFIED organisation - staff create it; self-serve is refused.
    await assert.rejects(orgs.createOrganization(OA.id, { name: `Agency A ${S}`, type: 'staffing_agency', billingEmail: OA.email }), (e: unknown) => e instanceof orgs.OrganizationAccessError && e.status === 403);
    orgA = (await orgs.createOrganization(OA.id, { name: `Agency A ${S}`, type: 'staffing_agency', billingEmail: OA.email }, { verifiedOrganization: true })).id;
    orgB = (await orgs.createOrganization(OB.id, { name: `Agency B ${S}`, type: 'staffing_agency', billingEmail: OB.email }, { verifiedOrganization: true })).id;
    for (const [u, serviceRole] of [
      [REC, 'recruiter'],
      [DEL, 'delivery'],
      [FIN, 'finance'],
      [VW, null],
    ] as const) {
      await orgs.inviteMember(OA.id, orgA, { userId: u.id, role: 'member' });
      await orgs.acceptInvitation(u.id, orgA);
      if (serviceRole) await svc.setStaffingRole({ user: OA, organizationId: orgA, role: 'admin' }, u.id, serviceRole);
    }
    // a clean jurisdiction registry for this run: every seeded row back to unrecorded
    await svc.ensureJurisdictionRegistry();
    await db.staffingJurisdictionRule.updateMany({ where: { jurisdiction: { in: ['CA-BC', 'CA', 'CA-ON'] } }, data: { status: 'unrecorded', licenceRequired: null, candidateFeesProhibited: null, maxGuaranteeDays: null, reference: '', recordedByEmail: '', recordedAt: null } });
  });
  after(async () => {
    await db.staffingJurisdictionRule.updateMany({ where: { jurisdiction: { in: ['CA-BC', 'CA', 'CA-ON'] } }, data: { status: 'unrecorded', licenceRequired: null, candidateFeesProhibited: null, maxGuaranteeDays: null, reference: '', recordedByEmail: '', recordedAt: null } });
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: [...ALL.map((u) => u.id), STAFF.id] } }, { entityId: { in: [orgA, orgB] } }] } });
    await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await db.user.deleteMany({ where: { id: { in: ALL.map((u) => u.id) } } });
    await db.$disconnect();
  });

  const tenant = <T,>(userId: string, organizationId: string | undefined, fn: (tx: Parameters<Parameters<Ctx['withTenant']>[1]>[0]) => Promise<T>) => ctx.withTenant({ userId, organizationId }, fn);
  const status = (p: Promise<unknown>, code: number, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof svc.StaffingError && e.status === code && (!re || re.test(e.message)));
  const auditCount = (action: string, entityId?: string) => db.auditLog.count({ where: { action, ...(entityId ? { entityId } : {}) } });
  const admin = () => ({ user: OA, organizationId: orgA, role: 'admin' as const });
  const rec = () => ({ user: REC, organizationId: orgA, role: 'recruiter' as const });
  const del = () => ({ user: DEL, organizationId: orgA, role: 'delivery' as const });
  const fin = () => ({ user: FIN, organizationId: orgA, role: 'finance' as const });
  const vw = () => ({ user: VW, organizationId: orgA, role: 'viewer' as const });
  const adminB = () => ({ user: OB, organizationId: orgB, role: 'admin' as const });
  const candidateBilling = async (userId: string) => ({ invoices: await db.invoice.count({ where: { userId } }), payments: await db.payment.count({ where: { userId } }), subscriptions: await db.subscription.count({ where: { userId } }), entitlements: await db.entitlement.count({ where: { userId } }) });

  it('the actor resolves from an accepted membership of a STAFFING organisation; the role is the named set; viewers see nothing commercial', async () => {
    await status(svc.requireStaffingActor(OB, orgA), 404);
    assert.equal((await svc.requireStaffingActor(OA, orgA)).role, 'admin');
    assert.equal((await svc.requireStaffingActor(REC, orgA)).role, 'recruiter');
    assert.equal((await svc.requireStaffingActor(FIN, orgA)).role, 'finance');
    assert.equal((await svc.requireStaffingActor(VW, orgA)).role, 'viewer');
    assert.deepEqual((await svc.agencyMemberships(REC.id)).map((m) => m.organizationId), [orgA]);
    assert.equal(await auditCount('staffing.role.set'), 3, 'every role assignment is audited (review L14)');
    await status(svc.setStaffingRole(rec(), VW.id, 'finance'), 403);
    await status(tenant(VW.id, orgA, (tx) => svc.listContracts(tx, vw())), 403);
    await status(tenant(VW.id, orgA, (tx) => svc.listEngagements(tx, vw())), 403);
  });

  it('contracts and fee structures: admin writes, the roles read as the matrix says, and a fee not paid by the client is refused before any row exists', async () => {
    await status(tenant(REC.id, orgA, (tx) => svc.createContract(tx, rec(), { clientName: 'Acme', jurisdiction: 'CA-BC' })), 403);
    await status(tenant(OA.id, orgA, (tx) => svc.createContract(tx, admin(), { clientName: 'Acme', jurisdiction: 'british columbia' })), 422);
    const c = await tenant(OA.id, orgA, (tx) => svc.createContract(tx, admin(), { clientName: `Acme ${S}`, jurisdiction: 'CA-BC', agencyLicenceRef: 'BC-EA-0001', terms: 'Net 30' }));
    contractId = c.id;
    assert.equal(c.status, 'draft');
    await status(tenant(OA.id, orgA, (tx) => svc.createFeeStructure(tx, admin(), { name: 'x', kind: 'contingency', percentBps: 2000, paidBy: 'candidate' })), 422, /No candidate is charged/);
    await status(tenant(OA.id, orgA, (tx) => svc.createFeeStructure(tx, admin(), { name: 'x', kind: 'contingency', percentBps: 20000 })), 422);
    await status(tenant(OA.id, orgA, (tx) => svc.createFeeStructure(tx, admin(), { name: 'x', kind: 'flat' })), 422);
    await status(tenant(FIN.id, orgA, (tx) => svc.createFeeStructure(tx, fin(), { name: 'x', kind: 'flat', flatCents: 100 })), 403);
    const f = await tenant(OA.id, orgA, (tx) => svc.createFeeStructure(tx, admin(), { name: '20% contingency, 90-day guarantee', kind: 'contingency', percentBps: 2000, guaranteeDays: 90, contractId: c.id }));
    feeId = f.id;
    assert.equal(f.paidBy, 'client');
    assert.equal((await tenant(FIN.id, orgA, (tx) => svc.listFeeStructures(tx, fin()))).length, 1, 'finance reads fees');
    await status(tenant(DEL.id, orgA, (tx) => svc.listFeeStructures(tx, del())), 403, undefined);
    assert.equal((await tenant(DEL.id, orgA, (tx) => svc.listContracts(tx, del()))).length, 1, 'delivery reads contracts');
    assert.equal(await tenant(OB.id, orgB, (tx) => tx.clientContract.count({ where: { id: c.id } })), 0, 'another agency sees nothing under RLS');
    assert.equal(await tenant(OB.id, orgB, (tx) => tx.feeStructure.count({ where: { organizationId: orgA } })), 0);
  });

  it('an engagement is a draft under a contract; activating needs an active contract; a recruiter owns theirs', async () => {
    await status(tenant(FIN.id, orgA, (tx) => svc.createEngagement(tx, fin(), { contractId, feeStructureId: feeId, title: 'x' })), 403);
    const e = await tenant(REC.id, orgA, (tx) => svc.createEngagement(tx, rec(), { contractId, feeStructureId: feeId, title: `Data Analyst ${S}` }));
    engagementId = e.id;
    assert.equal(e.ownerRecruiterId, REC.id);
    assert.equal(e.jurisdiction, 'CA-BC', 'from the contract');
    await status(tenant(REC.id, orgA, (tx) => svc.setEngagementStatus(tx, rec(), e.id, 'active')), 409, /contract is not active/);
    await tenant(OA.id, orgA, (tx) => svc.setContractStatus(tx, admin(), contractId, 'active'));
    const active = await tenant(REC.id, orgA, (tx) => svc.setEngagementStatus(tx, rec(), e.id, 'active'));
    assert.equal(active.status, 'active');
    // another recruiter does not own it; delivery may still write it; finance reads
    const REC2 = mk('rec2', 'Recruiter Two');
    await db.user.create({ data: { id: REC2.id, email: REC2.email, passwordHash: 'x', fullName: REC2.fullName, country: 'CA' } });
    ALL.push(REC2);
    await orgs.inviteMember(OA.id, orgA, { userId: REC2.id, role: 'member' });
    await orgs.acceptInvitation(REC2.id, orgA);
    await svc.setStaffingRole(admin(), REC2.id, 'recruiter');
    await status(tenant(REC2.id, orgA, (tx) => svc.setEngagementStatus(tx, { user: REC2, organizationId: orgA, role: 'recruiter' }, e.id, 'closed')), 403);
    const view = await tenant(FIN.id, orgA, (tx) => svc.loadEngagement(tx, fin(), e.id));
    assert.equal(view.canWrite, false);
    assert.equal(view.jurisdiction.verdict, 'unconfirmed', 'nothing recorded for CA-BC yet (L-4)');
    assert.deepEqual(view.representations, [], 'finance does not see representation');
    const asDelivery = await tenant(DEL.id, orgA, (tx) => svc.loadEngagement(tx, del(), e.id));
    assert.equal(asDelivery.fee, null, 'delivery does not see the fee row');
    assert.deepEqual(asDelivery.jurisdiction, view.jurisdiction, 'but sees the same verdict, evaluated from it (review M12)');
    await status(tenant(OB.id, orgB, (tx) => svc.loadEngagement(tx, adminB(), e.id)), 404);
  });

  it('representation is the candidate\'s: invited by email (accounts table never consulted; digest in the audit row), read-only on their tenant path, granted in one transaction with a consent record, declined is final, revocable', async () => {
    await status(svc.requestRepresentation(del(), { engagementId, email: CAND.email }), 403);
    await status(svc.requestRepresentation(fin(), { engagementId, email: CAND.email }), 403);
    const nobody = await svc.requestRepresentation(rec(), { engagementId, email: `nobody-${S}@staffing.test` });
    assert.equal(nobody.status, 'requested');
    assert.equal(nobody.candidateUserId, null);
    const r = await svc.requestRepresentation(rec(), { engagementId, email: CAND.email.toUpperCase(), message: 'May we represent you for the Acme role?' });
    repId = r.id;
    assert.equal(r.invitedEmail, CAND.email);
    await status(svc.requestRepresentation(rec(), { engagementId, email: CAND.email }), 409);
    const auditRow = await db.auditLog.findFirstOrThrow({ where: { action: 'representation.requested', entityId: r.id } });
    assert.ok(!JSON.stringify(auditRow).includes(CAND.email) && auditRow.after.includes('emailDigest'));
    const mine = await tenant(CAND.id, undefined, (tx) => svc.listCandidateRepresentations(tx, CAND));
    assert.deepEqual(mine.map((x) => [x.id, x.organization.name, x.engagement.clientName]), [[r.id, `Agency A ${S}`, `Acme ${S}`]]);
    assert.equal((await tenant(CAND2.id, undefined, (tx) => svc.listCandidateRepresentations(tx, CAND2))).length, 0);
    assert.equal(await tenant(CAND.id, undefined, (tx) => tx.representationConsent.count({ where: { id: r.id } })), 0, 'not on the tenant path until linked');
    await status(svc.respondToRepresentation(CAND2, r.id, true), 404);
    // no placement before consent
    await status(tenant(REC.id, orgA, (tx) => svc.createPlacement(tx, rec(), { engagementId, representationConsentId: r.id, startDate: new Date('2026-06-01T00:00:00Z'), salaryCents: 9_000_000 })), 403, /not consented/);
    const before = await db.consentRecord.count({ where: { userId: CAND.id, purpose: 'agency_representation' } });
    const granted = await svc.respondToRepresentation(CAND, r.id, true);
    assert.equal(granted.status, 'granted');
    assert.equal(granted.candidateUserId, CAND.id);
    assert.equal(granted.invitedName, CAND.fullName);
    assert.equal(await db.consentRecord.count({ where: { userId: CAND.id, purpose: 'agency_representation' } }), before + 1);
    await status(svc.respondToRepresentation(CAND, r.id, true), 409);
    assert.equal(await tenant(CAND.id, undefined, (tx) => tx.representationConsent.count({ where: { id: r.id } })), 1, 'linked: readable on their tenant path');
    await assert.rejects(() => tenant(CAND.id, undefined, (tx) => tx.representationConsent.update({ where: { id: r.id }, data: { status: 'revoked' } })));
    assert.equal((await tenant(CAND.id, undefined, (tx) => tx.representationConsent.deleteMany({ where: { id: r.id } }))).count, 0, 'SELECT-only for the candidate');
    assert.equal(await auditCount('representation.granted', r.id), 1);
    // the second person declines, which is final for this engagement
    const CAND3 = mk('cand3', 'Declining Candidate');
    await db.user.create({ data: { id: CAND3.id, email: `nobody-${S}@staffing.test`, passwordHash: 'x', fullName: CAND3.fullName, country: 'CA' } });
    ALL.push(CAND3);
    const declined = await svc.respondToRepresentation({ id: CAND3.id, email: `nobody-${S}@staffing.test` }, nobody.id, false);
    assert.equal(declined.status, 'declined');
    assert.equal(declined.candidateUserId, null, 'declining links nobody');
    await status(svc.requestRepresentation(rec(), { engagementId, email: `nobody-${S}@staffing.test` }), 409, /declined/);
    const asRecruiter = await tenant(REC.id, orgA, (tx) => svc.loadEngagement(tx, rec(), engagementId));
    assert.deepEqual(asRecruiter.representations.map((x) => [x.status, x.name]).sort(), [['declined', null], ['granted', CAND.fullName]], 'a name only for a granted representation');
  });

  it('a placement freezes the fee and the guarantee, stores the jurisdiction evaluation, and no invoice is issued while the rules are unrecorded (L-4); the candidate is never a party', async () => {
    const billingBefore = await candidateBilling(CAND.id);
    await status(tenant(FIN.id, orgA, (tx) => svc.createPlacement(tx, fin(), { engagementId, representationConsentId: repId, startDate: new Date('2026-06-01T00:00:00Z'), salaryCents: 9_000_000 })), 403);
    await status(tenant(DEL.id, orgA, (tx) => svc.createPlacement(tx, del(), { engagementId, representationConsentId: repId, startDate: new Date('2026-06-01T00:00:00Z'), salaryCents: 9_000_000, currency: 'USD' })), 422, /fee structure is in CAD/);
    await status(tenant(DEL.id, orgA, (tx) => svc.createPlacement(tx, del(), { engagementId, representationConsentId: repId, startDate: new Date('2026-06-01T00:00:00Z'), salaryCents: 9_000_000, recruiterId: VW.id })), 422, /is a recruiter of this organisation/);
    await status(tenant(DEL.id, orgA, (tx) => svc.createPlacement(tx, del(), { engagementId, representationConsentId: repId, startDate: new Date('2026-06-01T00:00:00Z'), salaryCents: 9_000_000, recruiterId: OB.id })), 422, /is a recruiter of this organisation/);
    await status(tenant(REC.id, orgA, (tx) => svc.createPlacement(tx, rec(), { engagementId, representationConsentId: repId, startDate: new Date('2026-06-01T00:00:00Z'), salaryCents: 9_000_000, recruiterId: OA.id })), 403, /their own placements only/);
    const p = await tenant(DEL.id, orgA, (tx) => svc.createPlacement(tx, del(), { engagementId, representationConsentId: repId, startDate: new Date('2026-06-01T00:00:00Z'), salaryCents: 9_000_000 }));
    placementId = p.id;
    assert.equal(p.currency, 'CAD', 'denominated as the fee structure is');
    assert.equal(p.feeCents, 1_800_000, '20% of 90,000.00');
    assert.equal(p.guaranteeDays, 90);
    assert.equal(p.guaranteeEndsAt.toISOString().slice(0, 10), '2026-08-30');
    assert.equal(p.recruiterId, REC.id, 'the engagement\'s owner');
    const check = JSON.parse(p.jurisdictionCheck) as { verdict: string; matched: string | null };
    assert.equal(check.verdict, 'unconfirmed');
    assert.equal(check.matched, 'CA-BC');
    assert.equal(await auditCount('staffing.placement.created', p.id), 1);
    await status(tenant(REC.id, orgA, (tx) => svc.issuePlacementInvoice(tx, rec(), p.id)), 403);
    await status(tenant(FIN.id, orgA, (tx) => svc.issuePlacementInvoice(tx, fin(), p.id)), 409, /pending placement is not invoiced/);
    await status(tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), p.id, { status: 'fell_off', fellOffReason: 'other' })), 409, /pending placement cannot become fell_off/);
    await tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), p.id, { status: 'started' }));
    await status(tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), p.id, { status: 'fell_off', fellOffReason: 'other', fellOffAt: new Date('2026-05-01T00:00:00Z') })), 422, /not before the start date/);
    await status(tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), p.id, { status: 'fell_off', fellOffReason: 'other', fellOffAt: new Date(Date.now() + 86_400_000) })), 422, /not in the future/);
    await status(tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), p.id, { status: 'cancelled' })), 409);
    await status(tenant(FIN.id, orgA, (tx) => svc.issuePlacementInvoice(tx, fin(), p.id)), 409, /until its rules are recorded/);
    assert.equal(await db.placementInvoice.count({ where: { placementId: p.id } }), 0);
    assert.deepEqual(await candidateBilling(CAND.id), billingBefore, 'nothing of the candidate\'s billing changed');
  });

  it('counsel\'s answer is recorded by an admin with a citation (audited) and evaluated as data: BC recorded allows the invoice, which is numbered in the PL book; another agency sees nothing; a prohibited jurisdiction blocks a new placement', async () => {
    await status(svc.recordJurisdictionRule(STAFF, 'CA-BC', { status: 'recorded', licenceRequired: true, candidateFeesProhibited: true, maxGuaranteeDays: null, reference: '' }, 'test'), 422, /cites/);
    await status(svc.recordJurisdictionRule(STAFF, 'ZZ-QQ', { status: 'recorded', licenceRequired: false, candidateFeesProhibited: true, maxGuaranteeDays: null, reference: 'x' }, 'test'), 422, /not a jurisdiction this product targets/);
    assert.equal(await db.staffingJurisdictionRule.count({ where: { jurisdiction: 'ZZ-QQ' } }), 0);
    await svc.recordJurisdictionRule(STAFF, 'CA-BC', { status: 'recorded', licenceRequired: true, candidateFeesProhibited: true, maxGuaranteeDays: 120, reference: 'Counsel memo (test fixture)' }, 'recording the test fixture');
    assert.equal(await auditCount('staffing.jurisdiction.recorded'), 1);
    const view = await tenant(REC.id, orgA, (tx) => svc.loadEngagement(tx, rec(), engagementId));
    assert.equal(view.jurisdiction.verdict, 'allowed', 'licence stated on the contract, 90 days within 120');
    assert.equal((await tenant(DEL.id, orgA, (tx) => svc.loadEngagement(tx, del(), engagementId))).jurisdiction.verdict, 'allowed', 'delivery sees the verdict evaluated from the fee row it cannot read');
    const billingBefore = await candidateBilling(CAND.id);
    // Two finance users issue at once: exactly one invoice exists afterwards (review H3 - the advisory lock and the re-check under it).
    const race = await Promise.allSettled([tenant(FIN.id, orgA, (tx) => svc.issuePlacementInvoice(tx, fin(), placementId)), tenant(OA.id, orgA, (tx) => svc.issuePlacementInvoice(tx, admin(), placementId))]);
    const won = race.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<Svc['issuePlacementInvoice']>>> => r.status === 'fulfilled');
    assert.equal(won.length, 1, 'one of the two won');
    assert.ok(race.some((r) => r.status === 'rejected' && r.reason instanceof svc.StaffingError && r.reason.status === 409 && /already invoiced/.test(r.reason.message)), 'the other was told');
    assert.equal(await db.placementInvoice.count({ where: { placementId } }), 1);
    const inv = won[0]!.value;
    invoiceId = inv.id;
    assert.match(inv.number!, /^PL-\d{4}-\d{6}$/);
    assert.equal(inv.status, 'issued');
    assert.equal(inv.amountCents, 1_800_000);
    assert.equal(inv.contractId, contractId);
    await status(tenant(FIN.id, orgA, (tx) => svc.issuePlacementInvoice(tx, fin(), placementId)), 409, /already invoiced/);
    assert.equal(await auditCount('staffing.invoice.issued', inv.id), 1);
    assert.deepEqual(await candidateBilling(CAND.id), billingBefore, 'the candidate is not a party to the invoice');
    assert.equal(await db.invoice.count({ where: { number: inv.number! } }), 0, 'not an Invoice row');
    assert.equal(await tenant(OB.id, orgB, (tx) => tx.placementInvoice.count({ where: { id: inv.id } })), 0);
    await status(tenant(REC.id, orgA, (tx) => svc.listPlacementInvoices(tx, rec())), 403);
    assert.equal((await tenant(FIN.id, orgA, (tx) => svc.listPlacementInvoices(tx, fin()))).length, 1);
    // a second contract in a prohibited jurisdiction cannot place at all
    await svc.recordJurisdictionRule(STAFF, 'CA-ON', { status: 'prohibited', licenceRequired: null, candidateFeesProhibited: null, maxGuaranteeDays: null, reference: 'Counsel memo (test fixture)' }, 'test');
    const on = await tenant(OA.id, orgA, (tx) => svc.createContract(tx, admin(), { clientName: `Ontario Client ${S}`, jurisdiction: 'CA-ON' }));
    await tenant(OA.id, orgA, (tx) => svc.setContractStatus(tx, admin(), on.id, 'active'));
    const flat = await tenant(OA.id, orgA, (tx) => svc.createFeeStructure(tx, admin(), { name: 'flat', kind: 'flat', flatCents: 500_000 }));
    const e2 = await tenant(OA.id, orgA, (tx) => svc.createEngagement(tx, admin(), { contractId: on.id, feeStructureId: flat.id, title: 'Ontario role', ownerRecruiterId: REC.id }));
    await tenant(OA.id, orgA, (tx) => svc.setEngagementStatus(tx, admin(), e2.id, 'active'));
    const r2 = await svc.requestRepresentation(rec(), { engagementId: e2.id, email: CAND.email });
    await svc.respondToRepresentation(CAND, r2.id, true);
    await status(tenant(REC.id, orgA, (tx) => svc.createPlacement(tx, rec(), { engagementId: e2.id, representationConsentId: r2.id, startDate: new Date(), salaryCents: 100 })), 422, /not allowed/);
    await status(tenant(REC.id, orgA, (tx) => svc.createPlacement(tx, rec(), { engagementId, representationConsentId: r2.id, startDate: new Date(), salaryCents: 100 })), 403, /not consented/); // a consent for another engagement is not this one's
  });

  it('a fall-off inside the guarantee credits the client\'s invoice; a revoked representation stops new placements but not the record; productivity counts per recruiter with fees for finance only', async () => {
    await status(tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), placementId, { status: 'fell_off' })), 422, /names its reason/);
    await status(tenant(FIN.id, orgA, (tx) => svc.updatePlacementInvoice(tx, fin(), invoiceId, { action: 'credit_guarantee' })), 409, /inside the guarantee/);
    await tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), placementId, { status: 'fell_off', fellOffReason: 'candidate_resigned', fellOffAt: new Date('2026-07-15T00:00:00Z') }));
    const credited = await tenant(FIN.id, orgA, (tx) => svc.updatePlacementInvoice(tx, fin(), invoiceId, { action: 'credit_guarantee' }));
    assert.equal(credited.creditedCents, 1_800_000);
    assert.equal(credited.creditReason, 'guarantee_fell_off');
    await status(tenant(FIN.id, orgA, (tx) => svc.updatePlacementInvoice(tx, fin(), invoiceId, { action: 'credit_guarantee' })), 409, /already credited/);
    await status(tenant(FIN.id, orgA, (tx) => svc.updatePlacementInvoice(tx, fin(), invoiceId, { action: 'void', reason: 'other' })), 409, undefined);
    await status(tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), placementId, { status: 'completed' })), 409);
    // the candidate revokes: no NEW placement cites the consent; the placement made stands
    await svc.revokeRepresentation(CAND, repId);
    assert.ok((await db.consentRecord.findFirstOrThrow({ where: { id: (await db.representationConsent.findUniqueOrThrow({ where: { id: repId } })).consentRecordId! } })).revokedAt);
    await status(tenant(DEL.id, orgA, (tx) => svc.createPlacement(tx, del(), { engagementId, representationConsentId: repId, startDate: new Date(), salaryCents: 100 })), 403, /withdrew/);
    assert.equal(await db.placement.count({ where: { id: placementId } }), 1);
    assert.equal(await auditCount('representation.revoked', repId), 1);
    await status(svc.requestRepresentation(rec(), { engagementId, email: CAND.email }), 409, /withdrew representation.*does not ask again/);
    assert.equal((await db.representationConsent.findUniqueOrThrow({ where: { id: repId } })).status, 'revoked', 'the cited row is never reset (review M5)');
    await assert.rejects(db.user.delete({ where: { id: CAND.id } }), 'a placed candidate\'s account cannot be hard-deleted from under the agency\'s record (review M11: RESTRICT)');
    // a second placement that never starts is CANCELLED, not a fall-off: no guarantee event, no credit
    const r3 = await svc.requestRepresentation(rec(), { engagementId, email: CAND2.email });
    await svc.respondToRepresentation(CAND2, r3.id, true);
    const p2 = await tenant(REC.id, orgA, (tx) => svc.createPlacement(tx, rec(), { engagementId, representationConsentId: r3.id, startDate: new Date('2026-08-01T00:00:00Z'), salaryCents: 5_000_000 }));
    assert.equal(p2.recruiterId, REC.id);
    const cancelled = await tenant(REC.id, orgA, (tx) => svc.updatePlacementStatus(tx, rec(), p2.id, { status: 'cancelled' }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.fellOffAt, null);
    assert.ok(!svc.withinGuarantee(cancelled));
    // Stage 21 (ADR-0036): productivity reads the organisation mart; the rollup is the one reader of the staffing tables.
    const { rollupOrganizations } = await import('../src/lib/analytics/organization/rollup');
    await rollupOrganizations({ start: new Date(Date.now() - 2 * 86_400_000), end: new Date(Date.now() + 2 * 86_400_000) }, { organizationId: orgA });
    const prodFin = await tenant(FIN.id, orgA, (tx) => svc.recruiterProductivity(tx, fin(), { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }));
    assert.equal(prodFin.invoices?.issued.count, 1, 'finance sees the invoice summary from the mart');
    assert.equal(prodFin.invoices?.credited.cents, 1_800_000);
    const recRow = prodFin.recruiters.find((r) => r.recruiterId === REC.id)!;
    assert.equal(recRow.placements, 2);
    assert.equal(recRow.fellOffInGuarantee, 1, 'the cancelled placement is not a fall-off');
    assert.equal(recRow.feeCents, 1_800_000 + 1_000_000);
    assert.equal(recRow.requested, 4, 'three people asked for the first engagement, one for the second');
    assert.equal(recRow.granted, 2, 'two grants stand; the other was revoked');
    const prodDel = await tenant(DEL.id, orgA, (tx) => svc.recruiterProductivity(tx, del(), { from: new Date(0), to: new Date() }));
    assert.equal(prodDel.recruiters.find((r) => r.recruiterId === REC.id)?.feeCents, null, 'delivery sees no fees');
    const prodRec = await tenant(REC.id, orgA, (tx) => svc.recruiterProductivity(tx, rec(), { from: new Date(0), to: new Date() }));
    assert.deepEqual(prodRec.recruiters.map((r) => r.recruiterId), [REC.id], 'a recruiter sees their own row only');
    assert.ok(!JSON.stringify(prodFin).includes(CAND.fullName) && !JSON.stringify(prodFin).includes(CAND.email));
    const audits = await db.auditLog.findMany({ where: { action: { startsWith: 'staffing.' } } });
    assert.ok(audits.every((a) => !JSON.stringify(a).includes(CAND.email) && !JSON.stringify(a).includes(CAND.fullName) && !JSON.stringify(a).includes(`Acme ${S}`)), 'ids, kinds and cents; no candidate or client identity');
  });
});

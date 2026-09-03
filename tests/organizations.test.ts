/**
 * Authorisation decisions of the membership service — the RBAC half of
 * ADR-0005 — as NEGATIVE tests. Each case is a way an actor might gain more
 * than their membership permits, and each must fail closed.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Orgs = typeof import('../src/lib/tenancy/organizations');
type Db = typeof import('../src/lib/db')['db'];

const S = randomBytes(4).toString('hex');
const owner = { id: `own_${S}`, email: `own-${S}@orgs.test`, fullName: 'Owner' };
const admin = { id: `adm_${S}`, email: `adm-${S}@orgs.test`, fullName: 'Admin' };
const member = { id: `mem_${S}`, email: `mem-${S}@orgs.test`, fullName: 'Member' };
const outsider = { id: `out_${S}`, email: `out-${S}@orgs.test`, fullName: 'Outsider' };
const invitee = { id: `inv_${S}`, email: `inv-${S}@orgs.test`, fullName: 'Invitee' };
let orgs: Orgs;
let db: Db;
let orgId: string;

describe('membership service — fails closed', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    orgs = await import('../src/lib/tenancy/organizations');
    for (const u of [owner, admin, member, outsider, invitee]) {
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName } });
      await orgs.ensurePersonalWorkspace(db, u);
    }
    const org = await orgs.createOrganization(owner.id, { name: `Org ${S}`, type: 'employer', billingEmail: owner.email });
    orgId = org.id;
    await orgs.inviteMember(owner.id, orgId, { userId: admin.id, role: 'admin' });
    await orgs.acceptInvitation(admin.id, orgId);
    await orgs.inviteMember(owner.id, orgId, { userId: member.id, role: 'member' });
    await orgs.acceptInvitation(member.id, orgId);
  });

  after(async () => {
    const ids = [owner, admin, member, outsider, invitee].map((u) => u.id);
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.organization.deleteMany({ where: { id: { in: [orgId, ...ids.map(orgs.personalOrganizationId)] } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const rejects = (p: Promise<unknown>, status: number, re?: RegExp) =>
    assert.rejects(p, (e: unknown) => e instanceof orgs.OrganizationAccessError && e.status === status && (!re || re.test(e.message)));

  it('a non-member gets 404, not 403: existence is not disclosed', async () => {
    await rejects(orgs.requireMembership(db, orgId, outsider.id), 404);
    await rejects(orgs.inviteMember(outsider.id, orgId, { userId: invitee.id, role: 'member' }), 404);
  });
  it('a pending invitation confers nothing', async () => {
    await orgs.inviteMember(owner.id, orgId, { userId: invitee.id, role: 'member' });
    await rejects(orgs.requireMembership(db, orgId, invitee.id), 404);
  });
  it('only the invitee can accept their invitation', async () => {
    await rejects(orgs.acceptInvitation(outsider.id, orgId), 404);
    await orgs.acceptInvitation(invitee.id, orgId);
    assert.ok(await orgs.findActiveMembership(db, orgId, invitee.id));
  });
  it('an invitation can never touch an ACTIVE membership (the review finding: admin demotes/locks out the owner)', async () => {
    await rejects(orgs.inviteMember(admin.id, orgId, { userId: owner.id, role: 'member' }), 409);
    await rejects(orgs.inviteMember(owner.id, orgId, { userId: admin.id, role: 'member' }), 409);
    const still = await orgs.findActiveMembership(db, orgId, owner.id);
    assert.equal(still?.role, 'owner');
    assert.ok(still?.acceptedAt, 'the owner is still accepted');
    await rejects(orgs.inviteMember(owner.id, orgId, { userId: `ghost_${S}`, role: 'member' }), 404);
  });
  it('a pending invitation can be withdrawn by an admin, and then confers nothing and cannot be accepted', async () => {
    await orgs.inviteMember(owner.id, orgId, { userId: outsider.id, role: 'member' });
    await rejects(orgs.withdrawInvitation(member.id, orgId, outsider.id), 403);
    await orgs.withdrawInvitation(admin.id, orgId, outsider.id);
    await rejects(orgs.acceptInvitation(outsider.id, orgId), 404);
    await rejects(orgs.requireMembership(db, orgId, outsider.id), 404);
    await rejects(orgs.withdrawInvitation(admin.id, orgId, outsider.id), 404, /No pending/);
  });
  it('a member cannot invite; an admin cannot grant above their own role (no self-escalation path)', async () => {
    await rejects(orgs.inviteMember(member.id, orgId, { userId: outsider.id, role: 'member' }), 403);
    await rejects(orgs.inviteMember(admin.id, orgId, { userId: outsider.id, role: 'owner' }), 403, /above your own/);
    await rejects(orgs.inviteMember(admin.id, orgId, { userId: admin.id, role: 'owner' }), 403);
  });
  it('only an owner changes roles, never their own', async () => {
    await rejects(orgs.changeRole(admin.id, orgId, { userId: member.id, role: 'admin' }), 403);
    await rejects(orgs.changeRole(member.id, orgId, { userId: member.id, role: 'owner' }), 403);
    await rejects(orgs.changeRole(owner.id, orgId, { userId: owner.id, role: 'member' }), 422);
    await orgs.changeRole(owner.id, orgId, { userId: member.id, role: 'admin' });
    await orgs.changeRole(owner.id, orgId, { userId: member.id, role: 'member' });
  });
  it('an unknown role is refused even from an owner', async () => {
    await rejects(orgs.changeRole(owner.id, orgId, { userId: member.id, role: 'superuser' as never }), 422);
    await rejects(orgs.inviteMember(owner.id, orgId, { userId: outsider.id, role: 'root' as never }), 422);
  });
  it('an admin cannot remove an admin or owner; the last owner cannot be removed', async () => {
    await rejects(orgs.removeMember(admin.id, orgId, owner.id), 403);
    await rejects(orgs.removeMember(member.id, orgId, admin.id), 403);
    await rejects(orgs.removeMember(owner.id, orgId, owner.id), 422, /at least one owner/);
  });
  it('a removed member loses access immediately and cannot act', async () => {
    await orgs.removeMember(admin.id, orgId, invitee.id);
    await rejects(orgs.requireMembership(db, orgId, invitee.id), 404);
    await rejects(orgs.inviteMember(invitee.id, orgId, { userId: outsider.id, role: 'member' }), 404);
  });
  it('a personal workspace cannot gain members or lose its owner', async () => {
    const personal = orgs.personalOrganizationId(owner.id);
    await rejects(orgs.inviteMember(owner.id, personal, { userId: admin.id, role: 'member' }), 422);
    await rejects(orgs.removeMember(owner.id, personal, owner.id), 422);
  });
  it('personal and platform organisations cannot be created through the API path', async () => {
    await rejects(orgs.createOrganization(owner.id, { name: 'x', type: 'personal', billingEmail: owner.email }), 422);
    await rejects(orgs.createOrganization(owner.id, { name: 'x', type: 'platform', billingEmail: owner.email }), 422);
  });
  it('a stored role this code does not recognise satisfies nothing', async () => {
    const m = await orgs.findActiveMembership(db, orgId, member.id);
    await db.membership.update({ where: { id: m!.id }, data: { role: 'future_role' } });
    try {
      await rejects(orgs.requireMembership(db, orgId, member.id, 'member'), 403);
    } finally {
      await db.membership.update({ where: { id: m!.id }, data: { role: 'member' } });
    }
  });
  it('ensurePersonalWorkspace is idempotent and its policy default is the most restrictive', async () => {
    const first = await orgs.ensurePersonalWorkspace(db, owner);
    const again = await orgs.ensurePersonalWorkspace(db, owner);
    assert.equal(first.id, again.id);
    assert.equal(again.aiProcessingPolicy, 'EXTERNAL_AI_PROHIBITED');
    assert.equal(await db.membership.count({ where: { organizationId: first.id } }), 1);
  });
});

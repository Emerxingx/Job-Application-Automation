/**
 * The linkage rules of src/lib/identity/link.ts, as NEGATIVE tests. The
 * Stage 01 review found that the first version trusted a user-writable claim
 * for email verification; these tests pin the corrected behaviour: nothing
 * links or creates an account unless the identity carries PROVIDER-side
 * verification, and an already-linked subject signs in regardless.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Link = typeof import('../src/lib/identity/link');
type Db = typeof import('../src/lib/db')['db'];
const S = randomBytes(4).toString('hex');
const SUB_A = `aaaaaaaa-0000-4000-8000-${S.padEnd(12, '0')}`;
const SUB_B = `bbbbbbbb-0000-4000-8000-${S.padEnd(12, '0')}`;
const SUB_C = `cccccccc-0000-4000-8000-${S.padEnd(12, '0')}`;
const victim = { id: `victim_${S}`, email: `victim-${S}@link.test` };
let link: Link;
let db: Db;
const identity = (subject: string, email: string | null, emailVerified: boolean) => ({
  subject, email, emailVerified, assuranceLevel: 'aal1' as const, providerSessionId: null, issuedAt: null,
});

describe('Supabase identity linkage — fails closed', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    link = await import('../src/lib/identity/link');
    await db.user.create({ data: { id: victim.id, email: victim.email, passwordHash: 'x', fullName: 'Victim' } });
  });
  after(async () => {
    const created = await db.user.findMany({ where: { email: { endsWith: `-${S}@link.test` } }, select: { id: true } });
    const ids = created.map((u) => u.id);
    await db.userIdentity.deleteMany({ where: { userId: { in: ids } } });
    await db.consentRecord.deleteMany({ where: { userId: { in: ids } } });
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.organization.deleteMany({ where: { id: { in: ids.map((id) => `org_personal_${id}`) } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const rejects = (p: Promise<unknown>, status: number) =>
    assert.rejects(p, (e: unknown) => e instanceof link.IdentityLinkError && e.status === status);

  it('THE FINDING: an unverified identity with an existing account’s email links NOTHING (no takeover)', async () => {
    await rejects(link.linkSupabaseIdentity(identity(SUB_A, victim.email, false)), 409);
    assert.equal(await db.userIdentity.count({ where: { userId: victim.id } }), 0);
    const untouched = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
    assert.equal(untouched.emailVerifiedAt, null);
  });
  it('an unverified identity with a new email creates no account even with consent', async () => {
    await rejects(link.linkSupabaseIdentity(identity(SUB_C, `new-${S}@link.test`, false), { consents: ['terms_of_service', 'privacy_policy'] }), 422);
    assert.equal(await db.user.count({ where: { email: `new-${S}@link.test` } }), 0);
  });
  it('an identity with no email links nothing', async () => {
    await rejects(link.linkSupabaseIdentity(identity(SUB_C, null, true)), 422);
  });
  it('a provider-verified email links to the existing account exactly once, then signs in by subject', async () => {
    const first = await link.linkSupabaseIdentity(identity(SUB_A, victim.email, true));
    assert.equal(first.user.id, victim.id);
    assert.equal(first.linked, true);
    assert.equal(first.created, false);
    // Rule 1 from now on: the subject is bound; a later unverified token for
    // the same subject still signs in (it is the same provider user).
    const again = await link.linkSupabaseIdentity(identity(SUB_A, victim.email, false));
    assert.equal(again.user.id, victim.id);
    assert.equal(again.linked, false);
    // But a DIFFERENT subject claiming the same email is a stranger.
    await rejects(link.linkSupabaseIdentity(identity(SUB_B, victim.email, false)), 409);
  });
  it('a bound subject cannot be re-bound to another account by presenting a different email', async () => {
    const r = await link.linkSupabaseIdentity(identity(SUB_A, `other-${S}@link.test`, true));
    assert.equal(r.user.id, victim.id, 'the existing binding wins; the email claim is ignored');
    assert.equal(await db.user.count({ where: { email: `other-${S}@link.test` } }), 0);
  });
  it('creating an account requires provider verification AND the required consents', async () => {
    await rejects(link.linkSupabaseIdentity(identity(SUB_C, `fresh-${S}@link.test`, true)), 422);
    await rejects(link.linkSupabaseIdentity(identity(SUB_C, `fresh-${S}@link.test`, true), { consents: ['terms_of_service'] }), 422);
    const created = await link.linkSupabaseIdentity(identity(SUB_C, `fresh-${S}@link.test`, true), { consents: ['terms_of_service', 'privacy_policy'], fullName: 'Fresh' });
    assert.equal(created.created, true);
    assert.ok(created.user.emailVerifiedAt);
    assert.equal(await db.membership.count({ where: { userId: created.user.id, role: 'owner' } }), 1, 'personal workspace');
    assert.equal(await db.consentRecord.count({ where: { userId: created.user.id } }), 2);
    assert.equal(await db.auditLog.count({ where: { actorId: created.user.id, action: 'auth.identity.linked' } }), 1);
  });
});

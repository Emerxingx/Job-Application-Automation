/**
 * Server-side session revocation against the database (ADR-0004 §1).
 * `createSession` needs a cookie jar and is exercised by the routes; the
 * revocation primitives are what make a stolen token die, so they are proven
 * here directly.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Auth = typeof import('../src/lib/auth');
type Db = typeof import('../src/lib/db')['db'];
const S = randomBytes(4).toString('hex');
const A = `sess_a_${S}`;
const B = `sess_b_${S}`;
let auth: Auth;
let db: Db;

describe('sessions — revocation is real', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    auth = await import('../src/lib/auth');
    for (const id of [A, B]) {
      await db.user.create({ data: { id, email: `${id}@sessions.test`, passwordHash: 'x', fullName: id } });
    }
  });
  after(async () => {
    await db.session.deleteMany({ where: { userId: { in: [A, B] } } });
    await db.user.deleteMany({ where: { id: { in: [A, B] } } });
    await db.$disconnect();
  });

  const live = (userId: string) => db.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });
  const issue = (userId: string) => db.session.create({ data: { userId, expiresAt: new Date(Date.now() + 3_600_000) } });

  it('revokeSession is scoped to the owner: another user’s session id is a no-op', async () => {
    const sa = await issue(A);
    assert.equal(await auth.revokeSession(B, sa.id, 'user_revoke'), false);
    assert.equal((await live(A)).length, 1);
    assert.equal(await auth.revokeSession(A, sa.id, 'user_revoke'), true);
    assert.equal((await live(A)).length, 0);
    const row = await db.session.findUniqueOrThrow({ where: { id: sa.id } });
    assert.equal(row.revokedReason, 'user_revoke');
    assert.equal(auth.isSessionLive(row, A, null), false, 'the revoked row is dead to the authoritative check');
    assert.equal(await auth.revokeSession(A, sa.id, 'user_revoke'), false, 'revoking twice is a no-op, not an error');
  });

  it('revokeAllSessions keeps the current one and kills the rest, for this user only', async () => {
    const keep = await issue(A);
    await issue(A);
    await issue(A);
    const other = await issue(B);
    const revoked = await auth.revokeAllSessions(A, 'password_change', { except: keep.id });
    assert.equal(revoked, 2);
    assert.deepEqual((await live(A)).map((s) => s.id), [keep.id]);
    assert.deepEqual((await live(B)).map((s) => s.id), [other.id], 'B’s sessions are untouched');
  });

  it('a session issued before a password change is dead even if the row was missed', async () => {
    const s = await issue(A);
    const changedAt = new Date(Date.now() + 1000);
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(auth.isSessionLive(row, A, changedAt, new Date(Date.now() + 2000)), false);
  });

  it('listLiveSessions never returns revoked or expired sessions, nor another user’s', async () => {
    await db.session.deleteMany({ where: { userId: { in: [A, B] } } });
    const ok = await issue(A);
    await db.session.create({ data: { userId: A, expiresAt: new Date(Date.now() - 1) } });
    await db.session.create({ data: { userId: A, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: new Date() } });
    await issue(B);
    const rows = await auth.listLiveSessions(A);
    assert.deepEqual(rows.map((r) => r.id), [ok.id]);
  });
});

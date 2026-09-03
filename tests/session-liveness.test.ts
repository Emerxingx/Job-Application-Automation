import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSessionLive } from '../src/lib/auth';

/**
 * The revocation rules, as a pure function. These are the conditions under
 * which a signature-valid cookie is REFUSED; each one is a way a stolen or
 * stale token stays dead.
 */
const now = new Date('2026-09-03T12:00:00Z');
const base = {
  userId: 'user_a',
  revokedAt: null as Date | null,
  expiresAt: new Date('2026-10-03T12:00:00Z'),
  createdAt: new Date('2026-09-01T12:00:00Z'),
};

describe('isSessionLive — server-side revocation rules', () => {
  it('accepts a live session for its owner', () => {
    assert.equal(isSessionLive(base, 'user_a', null, now), true);
  });
  it('refuses a missing row (the token names a session that does not exist)', () => {
    assert.equal(isSessionLive(null, 'user_a', null, now), false);
  });
  it('refuses a session whose row belongs to a different user than the token claims', () => {
    assert.equal(isSessionLive(base, 'user_b', null, now), false);
  });
  it('refuses a revoked session immediately, whatever its expiry', () => {
    assert.equal(isSessionLive({ ...base, revokedAt: now }, 'user_a', null, now), false);
  });
  it('refuses an expired session even if the row was never revoked', () => {
    assert.equal(isSessionLive({ ...base, expiresAt: now }, 'user_a', null, now), false);
    assert.equal(isSessionLive({ ...base, expiresAt: new Date(now.getTime() - 1) }, 'user_a', null, now), false);
  });
  it('refuses a session issued before the last password change', () => {
    const changed = new Date('2026-09-02T00:00:00Z');
    assert.equal(isSessionLive(base, 'user_a', changed, now), false);
  });
  it('accepts a session issued after the last password change', () => {
    const changed = new Date('2026-08-01T00:00:00Z');
    assert.equal(isSessionLive(base, 'user_a', changed, now), true);
  });
});

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { LIMITS, clientAddress, rateLimit, resetRateLimits } from '../src/lib/rate-limit';

const rule = { limit: 3, windowSeconds: 60 };

describe('rateLimit', () => {
  beforeEach(() => resetRateLimits());

  it('allows exactly the configured number of requests', async () => {
    for (let i = 0; i < rule.limit; i++) {
      assert.equal((await rateLimit('t', 'user-1', rule)).ok, true, `request ${i + 1} should pass`);
    }
    assert.equal((await rateLimit('t', 'user-1', rule)).ok, false, 'the next request must be refused');
  });

  it('counts down remaining accurately', async () => {
    assert.equal((await rateLimit('t', 'user-1', rule)).remaining, 2);
    assert.equal((await rateLimit('t', 'user-1', rule)).remaining, 1);
    assert.equal((await rateLimit('t', 'user-1', rule)).remaining, 0);
    assert.equal((await rateLimit('t', 'user-1', rule)).remaining, 0);
  });

  it('keeps separate counters per actor', async () => {
    for (let i = 0; i < rule.limit; i++) await rateLimit('t', 'user-1', rule);
    assert.equal((await rateLimit('t', 'user-1', rule)).ok, false);
    assert.equal((await rateLimit('t', 'user-2', rule)).ok, true, 'one user must not limit another');
  });

  it('keeps separate counters per bucket', async () => {
    for (let i = 0; i < rule.limit; i++) await rateLimit('scan', 'user-1', rule);
    assert.equal((await rateLimit('scan', 'user-1', rule)).ok, false);
    assert.equal((await rateLimit('apply', 'user-1', rule)).ok, true, 'buckets must not share a counter');
  });

  it('reports a positive retry delay only when refused', async () => {
    const allowed = await rateLimit('t', 'user-1', rule);
    assert.equal(allowed.retryAfterSeconds, 0);

    await rateLimit('t', 'user-1', rule);
    await rateLimit('t', 'user-1', rule);
    const refused = await rateLimit('t', 'user-1', rule);
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfterSeconds >= 1, 'a refusal must tell the client how long to wait');
    assert.ok(refused.retryAfterSeconds <= rule.windowSeconds);
  });

  it('resets once the window has elapsed', async () => {
    const brief = { limit: 1, windowSeconds: 0 };
    assert.equal((await rateLimit('t', 'user-1', brief)).ok, true);
    // A zero-length window is already expired on the next call.
    assert.equal((await rateLimit('t', 'user-1', brief)).ok, true);
  });

  it('returns a reset time in the future', async () => {
    const result = await rateLimit('t', 'user-1', rule);
    assert.ok(result.resetAt.getTime() > Date.now(), 'resetAt must be ahead of now');
  });

  it('defines a limit for every metered endpoint', async () => {
    for (const [name, r] of Object.entries(LIMITS)) {
      assert.ok(r.limit > 0, `${name} has a non-positive limit`);
      assert.ok(r.windowSeconds > 0, `${name} has a non-positive window`);
    }
  });
});

describe('clientAddress', () => {
  // Stage 14 review: the leftmost entry is whatever the caller wrote. Only the
  // entry the trusted proxy appended - the rightmost, with one hop - counts.
  it('believes the entry the trusted proxy appended, not the one the caller wrote', async () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' },
    });
    assert.equal(clientAddress(request, 1), '70.41.3.18');
    assert.equal(clientAddress(request, 2), '203.0.113.7', 'two trusted hops reach one entry further left');
    assert.equal(clientAddress(request, 3), 'unknown', 'more hops than entries: nothing believable');
  });

  it('ignores every forwarded header with zero trusted hops (one shared bucket)', async () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.4' },
    });
    assert.equal(clientAddress(request, 0), 'unknown');
  });

  it('a rotating forwarded header does not buy fresh buckets, and the per-account rule exists', async () => {
    resetRateLimits();
    const rule = { limit: 2, windowSeconds: 60 };
    for (const spoof of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      const request = new Request('https://example.com', { headers: { 'x-forwarded-for': `${spoof}, 70.41.3.18` } });
      await rateLimit('spoof-test', clientAddress(request, 1), rule);
    }
    assert.equal((await rateLimit('spoof-test', '70.41.3.18', rule)).ok, false, 'all three landed in the proxy-seen bucket');
    assert.ok(LIMITS.authAccount.limit >= 10 && LIMITS.authAccount.windowSeconds >= 300);
  });

  it('falls back to x-real-ip, then to a sentinel', async () => {
    assert.equal(
      clientAddress(new Request('https://example.com', { headers: { 'x-real-ip': '198.51.100.4' } })),
      '198.51.100.4',
    );
    assert.equal(clientAddress(new Request('https://example.com')), 'unknown');
  });
});

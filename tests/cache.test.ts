import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { getCache, resetCache } from '../src/lib/cache';

describe('cache (in-memory backend)', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    resetCache();
  });

  it('uses the in-memory backend when REDIS_URL is unset', () => {
    assert.equal(getCache().backend, 'memory');
  });

  it('stores and returns a value', async () => {
    const cache = getCache();
    await cache.set('k', 'v', 60);
    assert.equal(await cache.get('k'), 'v');
  });

  it('returns null for an unknown key', async () => {
    assert.equal(await getCache().get('nope'), null);
  });

  it('expires a value once its TTL has passed', async () => {
    const cache = getCache();
    // Zero-second TTL is already expired on the next read.
    await cache.set('k', 'v', 0);
    assert.equal(await cache.get('k'), null);
  });

  it('honours a positive TTL within the window', async () => {
    const cache = getCache();
    await cache.set('k', 'v', 60);
    assert.equal(await cache.get('k'), 'v');
  });

  it('deletes a key', async () => {
    const cache = getCache();
    await cache.set('k', 'v', 60);
    await cache.del('k');
    assert.equal(await cache.get('k'), null);
  });

  it('memoizes a single instance', () => {
    assert.equal(getCache(), getCache());
  });

  it('stores a negative-result sentinel distinctly from a miss', async () => {
    const cache = getCache();
    await cache.set('k', '__none__', 60);
    // The value round-trips; it is the caller (ats.ts) that maps it to null.
    assert.equal(await cache.get('k'), '__none__');
  });
});

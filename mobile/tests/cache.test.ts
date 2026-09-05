/** The offline cache policy: only allow-listed GETs, aged out, wiped on clear. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CACHEABLE_PATHS, MAX_AGE_MS, MemoryStore, OfflineCache, cacheKey, isCacheable } from '../src/api/cache';
import { PATHS } from '../src/api/client';

describe('isCacheable', () => {
  it('allows the read-only screens and nothing that mints, expires or writes', () => {
    assert.equal(isCacheable('GET', '/v1/recommendations'), true);
    assert.equal(isCacheable('GET', '/v1/jobs/abc'), true);
    assert.equal(isCacheable('GET', '/v1/applications/abc'), true);
    assert.equal(isCacheable('GET', '/v1/me'), true);
    assert.equal(isCacheable('GET', '/v1/auth/sessions'), false, 'the device list is live state');
    assert.equal(isCacheable('POST', '/v1/applications/abc/documents/d/link'), false, 'a signed link expires');
    assert.equal(isCacheable('POST', '/v1/applications/abc/confirm'), false);
    assert.equal(isCacheable('POST', '/v1/applications/abc/submit'), false);
    assert.equal(isCacheable('PUT', '/v1/jobs/abc/saved'), false);
    assert.equal(isCacheable('GET', '/v1/jobs/abc/saved'), false, 'a filled template only matches its own template');
    assert.equal(isCacheable('GET', '/v1/auth/sessions/current'), false);
  });
  it('every cacheable path is a contract path the client uses', () => {
    const known = new Set<string>(Object.values(PATHS));
    for (const p of CACHEABLE_PATHS) assert.ok(known.has(p), p);
    for (const write of [PATHS.confirm, PATHS.submit, PATHS.documentLink, PATHS.sessions, PATHS.currentSession, PATHS.session, PATHS.jobSaved, PATHS.consent]) assert.ok(!CACHEABLE_PATHS.includes(write), `${write} must not be cacheable`);
  });
});

describe('OfflineCache', () => {
  it('stores allowed bodies with a timestamp, refuses others, ages out, clears', async () => {
    let now = Date.parse('2026-09-05T10:00:00Z');
    const store = new MemoryStore();
    const cache = new OfflineCache(store, () => now);
    assert.equal(await cache.write('GET', '/v1/me', cacheKey('/v1/me'), { object: 'me' }), true);
    assert.equal(await cache.write('POST', '/v1/applications/x/confirm', 'k', { object: 'application' }), false);
    assert.equal(await store.get('k'), null, 'a refused write leaves nothing behind');
    const hit = await cache.read<{ object: string }>(cacheKey('/v1/me'));
    assert.equal(hit?.body.object, 'me');
    assert.equal(hit?.storedAt, '2026-09-05T10:00:00.000Z');
    now += MAX_AGE_MS + 1;
    assert.equal(await cache.read(cacheKey('/v1/me')), null, 'too old to show');
    assert.equal(await store.get(cacheKey('/v1/me')), null, 'and removed');
    await cache.write('GET', '/v1/me', cacheKey('/v1/me'), { object: 'me' });
    await cache.clear();
    assert.equal(await cache.read(cacheKey('/v1/me')), null, 'sign-out wipes the cache');
  });
  it('keys are stable across query order and drop undefined values', () => {
    assert.equal(cacheKey('/v1/jobs', { offset: 0, limit: 25 }), cacheKey('/v1/jobs', { limit: 25, offset: 0 }));
    assert.equal(cacheKey('/v1/jobs', { limit: 25, status: undefined }), '/v1/jobs?limit=25');
  });
  it('a corrupt entry is dropped, not thrown', async () => {
    const store = new MemoryStore();
    await store.set('bad', '{not json');
    const cache = new OfflineCache(store);
    assert.equal(await cache.read('bad'), null);
    assert.equal(await store.get('bad'), null);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEV_AUTH_SECRET, isUsableSecret } from '../src/lib/auth';

describe('isUsableSecret', () => {
  it('accepts a generated secret of sufficient length', () => {
    // 44 chars, the shape of `openssl rand -base64 32`.
    assert.equal(isUsableSecret('Zt6Xq2vK9pLm4RsW8yBn1cFd3gHj5kNq7uEr0aTiOxY='), true);
  });

  it('rejects the placeholder shipped in .env.example', () => {
    // The important case: it is 49 characters, so a length-only check passes it
    // and every session would be signed with a key published in the repository.
    assert.ok(DEV_AUTH_SECRET.length >= 32, 'placeholder is long enough to fool a length check');
    assert.equal(isUsableSecret(DEV_AUTH_SECRET), false);
  });

  it('rejects short or absent secrets', () => {
    assert.equal(isUsableSecret(undefined), false);
    assert.equal(isUsableSecret(''), false);
    assert.equal(isUsableSecret('too-short'), false);
    assert.equal(isUsableSecret('a'.repeat(31)), false);
    assert.equal(isUsableSecret('a'.repeat(32)), true);
  });
});

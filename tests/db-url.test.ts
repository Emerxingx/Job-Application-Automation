import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeDatabaseUrl, normalizeDatabaseUrl } from '../src/lib/db-url';

describe('normalizeDatabaseUrl', () => {
  it('percent-encodes a password containing URL-reserved characters', () => {
    const raw = 'postgresql://postgres.abc:p#ss@w/rd@aws-0-ca-central-1.pooler.example.com:6543/postgres?pgbouncer=true';
    const out = normalizeDatabaseUrl(raw)!;
    assert.doesNotThrow(() => new URL(out));
    const url = new URL(out);
    assert.equal(url.username, 'postgres.abc');
    assert.equal(decodeURIComponent(url.password), 'p#ss@w/rd');
    assert.equal(url.hostname, 'aws-0-ca-central-1.pooler.example.com');
    assert.equal(url.port, '6543');
  });

  it('is idempotent: an already-encoded password is not encoded twice', () => {
    const once = normalizeDatabaseUrl('postgresql://u:p%23ss@h:5432/db')!;
    const twice = normalizeDatabaseUrl(once)!;
    assert.equal(once, 'postgresql://u:p%23ss@h:5432/db');
    assert.equal(twice, once);
  });

  it('leaves plain passwords, passwordless URLs and non-URL values alone', () => {
    assert.equal(normalizeDatabaseUrl('postgresql://u:plain@h/db'), 'postgresql://u:plain@h/db');
    assert.equal(normalizeDatabaseUrl('postgresql://u@h/db'), 'postgresql://u@h/db');
    assert.equal(normalizeDatabaseUrl('file:./dev.db'), 'file:./dev.db');
    assert.equal(normalizeDatabaseUrl(''), '');
    assert.equal(normalizeDatabaseUrl(undefined), undefined);
  });

  it('treats a lone % that is not an escape as raw and encodes it', () => {
    const out = normalizeDatabaseUrl('postgresql://u:100%sure@h/db')!;
    assert.equal(new URL(out).password, '100%25sure');
  });
});

describe('describeDatabaseUrl', () => {
  it('never includes the credential and classifies the pooler mode by port', () => {
    const d = describeDatabaseUrl('postgresql://postgres.proj:s3cret@aws-0-ca-central-1.pooler.example.com:6543/postgres?pgbouncer=true')!;
    assert.equal(JSON.stringify(d).includes('s3cret'), false);
    assert.equal(JSON.stringify(d).includes('proj'), false);
    assert.equal(d.mode, 'transaction-pooler');
    assert.equal(d.pgbouncer, true);
    assert.equal(d.port, 6543);
    assert.equal(d.database, 'postgres');
    const s = describeDatabaseUrl('postgresql://postgres.proj:s3cret@aws-0-ca-central-1.pooler.example.com:5432/postgres')!;
    assert.equal(s.mode, 'session-pooler-or-direct');
  });

  it('returns null for an unparseable value rather than throwing', () => {
    assert.equal(describeDatabaseUrl('not a url'), null);
  });
});

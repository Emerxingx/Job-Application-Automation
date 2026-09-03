/**
 * Stage 05 — object storage behind the application folders (ADR-0015).
 * The local provider round-trips and refuses key escapes; the S3 signer is
 * pure and deterministic, keeps the secret out of the request, and the
 * provider refuses a region outside the residency allow-list. No bucket is
 * contacted: IMPLEMENTED-NOT-VALIDATED, and the register says so.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LocalStorageProvider } from '../src/lib/storage/local';
import { S3StorageProvider, readS3Config, signS3Request } from '../src/lib/storage/s3';

const root = mkdtempSync(path.join(tmpdir(), 'jp-storage-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('storage — local provider', () => {
  it('round-trips, lists, and refuses a key that escapes the root', async () => {
    const p = new LocalStorageProvider(root);
    await p.put('u1/applications/2026-09/acme-x/resume.txt', 'hello');
    assert.equal(await p.get('u1/applications/2026-09/acme-x/resume.txt'), 'hello');
    assert.equal(await p.get('u1/applications/2026-09/acme-x/missing.txt'), null);
    assert.deepEqual((await p.list('u1/applications/2026-09/acme-x')).map((o) => o.key), ['u1/applications/2026-09/acme-x/resume.txt']);
    await assert.rejects(() => p.put('../escape.txt', 'x'), /escapes the root/);
    assert.equal(await p.get('../../etc/passwd'), null);
  });
});

describe('storage — S3 signer and provider', () => {
  const config = { endpoint: 'https://s3.ca-central-1.amazonaws.com', region: 'ca-central-1', bucket: 'jobpilot-test', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  it('produces a deterministic SigV4 request that never carries the secret', () => {
    const now = new Date('2026-09-03T10:00:00Z');
    const a = signS3Request(config, 'PUT', 'u1/applications/2026-09/x/resume.txt', 'hello', now);
    const b = signS3Request(config, 'PUT', 'u1/applications/2026-09/x/resume.txt', 'hello', now);
    assert.deepEqual(a, b);
    assert.equal(a.url, 'https://s3.ca-central-1.amazonaws.com/jobpilot-test/u1/applications/2026-09/x/resume.txt');
    assert.match(a.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260903\/ca-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(a.headers['x-amz-date'], '20260903T100000Z');
    assert.equal(JSON.stringify(a).includes(config.secretAccessKey), false);
    // A different body or key changes the signature.
    assert.notEqual(signS3Request(config, 'PUT', 'u1/applications/2026-09/x/resume.txt', 'hello!', now).headers.Authorization, a.headers.Authorization);
    assert.notEqual(signS3Request(config, 'PUT', 'u1/other.txt', 'hello', now).headers.Authorization, a.headers.Authorization);
  });
  it('refuses a region outside the residency allow-list and reads a complete configuration only', () => {
    assert.throws(() => new S3StorageProvider({ ...config, region: 'us-east-1' }), /residency allow-list/);
    assert.equal(readS3Config({ STORAGE_S3_ENDPOINT: 'x' } as unknown as NodeJS.ProcessEnv), null);
    const read = readS3Config({ STORAGE_S3_ENDPOINT: config.endpoint, STORAGE_S3_REGION: config.region, STORAGE_S3_BUCKET: config.bucket, STORAGE_S3_ACCESS_KEY_ID: 'a', STORAGE_S3_SECRET_ACCESS_KEY: 'b' } as unknown as NodeJS.ProcessEnv);
    assert.equal(read?.bucket, config.bucket);
  });
  it('put, get and list go through a fetch the provider is given, with signed headers', async () => {
    const calls: { url: string; method: string; auth: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', auth: String((init?.headers as Record<string, string>).Authorization) });
      if (init?.method === 'PUT') return new Response('', { status: 200 });
      if (String(input).includes('list-type=2')) return new Response('<ListBucketResult><Contents><Key>u1/a.txt</Key><Size>5</Size></Contents></ListBucketResult>', { status: 200 });
      return new Response('hello', { status: 200 });
    }) as typeof fetch;
    const p = new S3StorageProvider(config, fetchImpl);
    await p.put('u1/a.txt', 'hello');
    assert.equal(await p.get('u1/a.txt'), 'hello');
    assert.deepEqual(await p.list('u1'), [{ key: 'u1/a.txt', size: 5 }]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.auth.startsWith('AWS4-HMAC-SHA256')));
    assert.equal(p.location, 's3:ca-central-1/jobpilot-test');
  });
});

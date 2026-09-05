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
  it('matches a known-answer vector computed by an independent implementation', () => {
    // Expected signatures were produced by a separate SigV4 implementation
    // written in Python (hashlib/hmac only) from the same inputs, so a
    // canonical-form mistake here would not be self-consistent with it.
    const kat = { endpoint: 'https://s3.ca-central-1.amazonaws.com', region: 'ca-central-1', bucket: 'jobpilot-folders', accessKeyId: 'AKIAEXAMPLEKEY000000', secretAccessKey: 'examplesecretkey/0000000000000000000000000' };
    const key = 'u1/applications/2026-09/co-title-abc123/resume.txt';
    const now = new Date('2026-09-03T12:00:00Z');
    const sig = (r: { headers: Record<string, string> }) => r.headers.Authorization.match(/Signature=([0-9a-f]{64})$/)![1];
    assert.equal(sig(signS3Request(kat, 'PUT', key, 'hello, folder', now)), '2c0f43f19554e671399365e8a03e3cfc775ee2b8617ca37bfc5ac270c5dcdd6f');
    assert.equal(sig(signS3Request(kat, 'GET', key, '', now)), '33f94d1c7ef0834fe2cde987bc240cb7ee494060f5577f456d04db3d0861a0f6');
    assert.equal(sig(signS3Request(kat, 'GET', '', '', now, 'list-type=2&prefix=u1%2Fapplications%2F')), 'cab61f104b20ff57f755e73d1d0fa72d237b2d74828d728e207344dbf6dfb106');
  });
  it('signs and sends an endpoint path prefix (a gateway such as /storage/v1/s3), and none when there is none', () => {
    const now = new Date('2026-09-03T10:00:00Z');
    const gateway = signS3Request({ ...config, endpoint: 'https://proj.supabase.co/storage/v1/s3/' }, 'GET', 'u1/x.txt', '', now);
    assert.equal(gateway.url, 'https://proj.supabase.co/storage/v1/s3/jobpilot-test/u1/x.txt');
    const plain = signS3Request(config, 'GET', 'u1/x.txt', '', now);
    assert.equal(plain.url, 'https://s3.ca-central-1.amazonaws.com/jobpilot-test/u1/x.txt');
    assert.notEqual(gateway.headers.Authorization, plain.headers.Authorization, 'the prefix is part of the signed canonical URI');
    const listed = signS3Request({ ...config, endpoint: 'https://proj.supabase.co/storage/v1/s3' }, 'GET', '', '', now, 'list-type=2&prefix=u1%2F');
    assert.equal(listed.url, 'https://proj.supabase.co/storage/v1/s3/jobpilot-test/?list-type=2&prefix=u1%2F');
  });
  it('a residency violation degrades to the local filesystem, loudly and once, instead of failing the application', async () => {
    const { getStorageProvider, resetStorageProviderForTests } = await import('../src/lib/storage');
    const saved = { ...process.env };
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      resetStorageProviderForTests();
      Object.assign(process.env, { STORAGE_PROVIDER: 's3', STORAGE_S3_ENDPOINT: config.endpoint, STORAGE_S3_REGION: 'us-east-1', STORAGE_S3_BUCKET: 'b', STORAGE_S3_ACCESS_KEY_ID: 'a', STORAGE_S3_SECRET_ACCESS_KEY: 'sekrit-value' });
      const first = await getStorageProvider();
      assert.equal(first.name, 'local');
      const second = await getStorageProvider();
      assert.equal(second, first, 'the fallback is remembered');
      assert.equal(errors.length, 1, 'logged once, not per call');
      assert.match(errors[0], /residency allow-list/);
      assert.ok(!errors[0].includes('sekrit-value'));
    } finally {
      console.error = originalError;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      resetStorageProviderForTests();
    }
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
  it('a listing follows the continuation token to the last page, so deletePrefix removes every object (review M5)', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.includes('continuation-token=')) return new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>u1/documents/b&amp;c.txt</Key><Size>2</Size></Contents></ListBucketResult>', { status: 200 });
      return new Response('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok/1+2=</NextContinuationToken><Contents><Key>u1/a.txt</Key><Size>1</Size></Contents></ListBucketResult>', { status: 200 });
    }) as typeof fetch;
    const p = new S3StorageProvider(config, fetchImpl);
    assert.deepEqual(await p.list('u1'), [{ key: 'u1/a.txt', size: 1 }, { key: 'u1/documents/b&c.txt', size: 2 }]);
    assert.equal(await p.deletePrefix('u1/'), 2);
    assert.equal(calls.filter((c) => c.startsWith('GET')).length, 4, 'two pages per listing, two listings');
    assert.ok(calls.some((c) => c.includes('continuation-token=tok%2F1%2B2%3D&list-type=2')), 'the token is encoded and sorted before list-type, as the signature requires');
    assert.equal(calls.filter((c) => c.startsWith('DELETE')).length, 2);
  });
});

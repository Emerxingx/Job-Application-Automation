import { createHash, createHmac } from 'node:crypto';
import type { StorageProvider, StoredObject } from './provider';

/**
 * S3-compatible object storage, signed with AWS Signature Version 4 by hand
 * so the build carries no SDK. Any S3-compatible endpoint works (AWS S3,
 * Supabase Storage's S3 gateway, MinIO); the REGION IS CHECKED against the
 * residency allow-list (ADR-0015: personal data stays in Canada) and the
 * provider refuses to start otherwise.
 *
 * IMPLEMENTED-NOT-VALIDATED: the signing is exercised by a unit test on its
 * canonical form; no request has been made against a live bucket from this
 * codebase (INTEGRATION_REGISTER.md).
 */
export interface S3Config {
  endpoint: string; // https://s3.ca-central-1.amazonaws.com or a compatible host
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (bucket in the path) — required by most compatible stores. */
  pathStyle?: boolean;
}

export const RESIDENCY_REGIONS: readonly string[] = ['ca-central-1', 'ca-west-1'];

export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env.STORAGE_S3_ENDPOINT;
  const region = env.STORAGE_S3_REGION;
  const bucket = env.STORAGE_S3_BUCKET;
  const accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, pathStyle: env.STORAGE_S3_PATH_STYLE !== 'false' };
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

function amzDate(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { stamp: iso, date: iso.slice(0, 8) };
}

function encodeKey(key: string): string {
  return key.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Build a SigV4-signed request. Pure given `now`, so it is testable. */
export function signS3Request(config: S3Config, method: 'GET' | 'PUT' | 'DELETE', key: string, body: string | Buffer, now = new Date(), query = '', contentType = 'text/plain; charset=utf-8'): SignedRequest {
  const base = new URL(config.endpoint);
  const host = config.pathStyle === false ? `${config.bucket}.${base.host}` : base.host;
  // An endpoint may carry a path prefix (Supabase's gateway is
  // `/storage/v1/s3`); it is part of the resource, so it is signed and sent.
  const prefix = base.pathname.replace(/\/+$/, '');
  const pathname = `${prefix}${config.pathStyle === false ? `/${encodeKey(key)}` : `/${config.bucket}/${encodeKey(key)}`}`;
  const { stamp, date } = amzDate(now);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    ...(method === 'PUT' ? { 'content-type': contentType } : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [method, pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const { host: _h, ...rest } = headers;
  void _h;
  return {
    url: `${base.protocol}//${host}${pathname}${query ? `?${query}` : ''}`,
    headers: { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  readonly location: string;
  constructor(private readonly config: S3Config, private readonly fetchImpl: typeof fetch = fetch) {
    if (!RESIDENCY_REGIONS.includes(config.region)) {
      throw new Error(`STORAGE_S3_REGION "${config.region}" is outside the residency allow-list (${RESIDENCY_REGIONS.join(', ')}); ADR-0015.`);
    }
    this.location = `s3:${config.region}/${config.bucket}`;
  }
  async put(key: string, body: string): Promise<void> {
    const req = signS3Request(this.config, 'PUT', key, body);
    const res = await this.fetchImpl(req.url, { method: 'PUT', headers: req.headers, body });
    if (!res.ok) throw new Error(`object store responded ${res.status} on put`);
  }
  async get(key: string): Promise<string | null> {
    const req = signS3Request(this.config, 'GET', key, '');
    const res = await this.fetchImpl(req.url, { method: 'GET', headers: req.headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object store responded ${res.status} on get`);
    return res.text();
  }
  async putBytes(key: string, body: Buffer, contentType: string): Promise<void> {
    const req = signS3Request(this.config, 'PUT', key, body, new Date(), '', contentType);
    const res = await this.fetchImpl(req.url, { method: 'PUT', headers: req.headers, body: new Uint8Array(body) });
    if (!res.ok) throw new Error(`object store responded ${res.status} on put`);
  }
  async getBytes(key: string): Promise<Buffer | null> {
    const req = signS3Request(this.config, 'GET', key, '');
    const res = await this.fetchImpl(req.url, { method: 'GET', headers: req.headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object store responded ${res.status} on get`);
    return Buffer.from(await res.arrayBuffer());
  }
  async delete(key: string): Promise<boolean> {
    const req = signS3Request(this.config, 'DELETE', key, '', new Date());
    const res = await this.fetchImpl(req.url, { method: 'DELETE', headers: req.headers });
    if (res.status === 404) return false;
    if (!res.ok && res.status !== 204) throw new Error(`object store responded ${res.status} on delete`);
    return true;
  }
  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const o of await this.list(prefix)) if (await this.delete(o.key)) n += 1;
    return n;
  }
  async list(prefix: string): Promise<StoredObject[]> {
    // A bucket listing is paged at 1000 keys; a person with more objects than
    // that (documents × versions × formats, exports) must have every one
    // listed or the erasure's purge silently stops at the first page (Stage
    // 23 review, M5). The query is built in canonical (sorted) order because
    // the signature covers it.
    const out: StoredObject[] = [];
    let token: string | null = null;
    for (let page = 0; page < 10_000; page++) {
      const query = `${token ? `continuation-token=${encodeURIComponent(token)}&` : ''}list-type=2&prefix=${encodeURIComponent(prefix.replace(/\/?$/, '/'))}`;
      const req = signS3Request(this.config, 'GET', '', '', new Date(), query);
      const res = await this.fetchImpl(req.url, { method: 'GET', headers: req.headers });
      if (!res.ok) throw new Error(`object store responded ${res.status} on list`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
        out.push({ key: decodeXml(m[1]), size: Number(m[2]) });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (!truncated || !next) break;
      token = decodeXml(next);
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

}

/** The five XML entities a key or a token can carry back from the listing. */
function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

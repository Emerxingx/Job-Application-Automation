import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import {
  fetchSupabaseUser,
  identityFromClaims,
  supabaseIdentityConfig,
  SupabaseIdentityError,
  verifySupabaseAccessToken,
  withProviderVerification,
} from '../src/lib/identity/supabase';

/**
 * Verification of a Supabase-SHAPED token, minted locally. This proves the
 * platform's checks — signature, issuer, audience, expiry, subject shape —
 * against a token whose claims mirror Supabase's; it does NOT prove
 * interoperability with a real project, which needs one reachable from the
 * build (AUTONOMOUS_STATUS.json). INTEGRATION_REGISTER.md records the module
 * as IMPLEMENTED-NOT-VALIDATED for exactly that reason.
 */
const SECRET = 'test-supabase-jwt-secret-at-least-32-chars-long';
const URL_ = 'https://project-ref.supabase.co';
const config = { url: URL_, jwtSecret: SECRET, jwksUrl: `${URL_}/auth/v1/.well-known/jwks.json` };
const SUB = '6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

async function mint(overrides: Record<string, unknown> = {}, opts: { secret?: string; iss?: string; aud?: string; exp?: string } = {}) {
  const jwt = new SignJWT({
    email: 'Person@Example.test',
    aal: 'aal1',
    session_id: 'sess-1',
    user_metadata: { email_verified: true },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(SUB)
    .setIssuer(opts.iss ?? `${URL_}/auth/v1`)
    .setAudience(opts.aud ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h');
  return jwt.sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

describe('supabaseIdentityConfig', () => {
  it('is null (fail closed) with nothing configured, or a secret that is too short', () => {
    assert.equal(supabaseIdentityConfig({} as unknown as NodeJS.ProcessEnv), null);
    assert.equal(supabaseIdentityConfig({ SUPABASE_JWT_SECRET: 'short' } as unknown as NodeJS.ProcessEnv), null);
  });
  it('derives the JWKS url from SUPABASE_URL and strips a trailing slash', () => {
    const c = supabaseIdentityConfig({ SUPABASE_URL: 'https://x.supabase.co/' } as unknown as NodeJS.ProcessEnv)!;
    assert.equal(c.url, 'https://x.supabase.co');
    assert.equal(c.jwksUrl, 'https://x.supabase.co/auth/v1/.well-known/jwks.json');
  });
});

describe('verifySupabaseAccessToken', () => {
  it('accepts a well-formed token and normalises the identity — as UNVERIFIED', async () => {
    const id = await verifySupabaseAccessToken(await mint(), config);
    assert.equal(id.subject, SUB);
    assert.equal(id.email, 'person@example.test');
    // user_metadata.email_verified is in the token and is IGNORED: it is
    // user-writable. Only the provider's record can verify (below).
    assert.equal(id.emailVerified, false);
    assert.equal(id.assuranceLevel, 'aal1');
    assert.equal(id.providerSessionId, 'sess-1');
  });
  it('carries aal2 through, and treats anything else as aal1', async () => {
    assert.equal((await verifySupabaseAccessToken(await mint({ aal: 'aal2' }), config)).assuranceLevel, 'aal2');
    assert.equal((await verifySupabaseAccessToken(await mint({ aal: 'aal9' }), config)).assuranceLevel, 'aal1');
  });
  it('never treats a claim as verification, whatever the token says', async () => {
    for (const claims of [{ user_metadata: {} }, { user_metadata: { email_verified: true } }, { email_verified: true }]) {
      const id = await verifySupabaseAccessToken(await mint(claims), config);
      assert.equal(id.emailVerified, false, JSON.stringify(claims));
    }
  });
  for (const [name, make] of [
    ['a wrong signature', () => mint({}, { secret: 'another-secret-that-is-also-32-chars-long!' })],
    ['a different issuer (another project)', () => mint({}, { iss: 'https://other.supabase.co/auth/v1' })],
    ['the anon audience', () => mint({}, { aud: 'anon' })],
    ['an expired token', () => mint({}, { exp: '-1s' })],
  ] as const) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(verifySupabaseAccessToken(await make(), config), SupabaseIdentityError);
    });
  }
  it('rejects a subject that is not a Supabase user id', async () => {
    const token = await new SignJWT({ email: 'a@b.c' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('not-a-uuid')
      .setIssuer(`${URL_}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    await assert.rejects(verifySupabaseAccessToken(token, config), /not a Supabase user id/);
  });
  it('refuses when neither a secret nor a JWKS url is configured', async () => {
    await assert.rejects(
      verifySupabaseAccessToken(await mint(), { url: null, jwtSecret: null, jwksUrl: null }),
      /not configured/,
    );
  });
  it('identityFromClaims lowercases and trims the email', () => {
    assert.equal(identityFromClaims({ sub: SUB, email: '  A@B.C ' }).email, 'a@b.c');
  });
});

describe('provider-side email verification (the only source that counts)', () => {
  const base = { subject: SUB, email: 'person@example.test', emailVerified: false, assuranceLevel: 'aal1' as const, providerSessionId: null, issuedAt: null };
  const fakeFetch = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('returns null (unverified) without a URL or anon key, on non-2xx, on a malformed body, and on a network error', async () => {
    assert.equal(await fetchSupabaseUser('t', { ...config, url: null }, { anonKey: 'k' }), null);
    assert.equal(await fetchSupabaseUser('t', config, { anonKey: null }), null);
    assert.equal(await fetchSupabaseUser('t', config, { anonKey: 'k', fetchImpl: fakeFetch(401, {}) }), null);
    assert.equal(await fetchSupabaseUser('t', config, { anonKey: 'k', fetchImpl: fakeFetch(200, { id: 'nope' }) }), null);
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    assert.equal(await fetchSupabaseUser('t', config, { anonKey: 'k', fetchImpl: boom }), null);
  });
  it('reads email_confirmed_at from the provider record and sends the bearer token with the apikey', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ id: SUB, email: 'Person@Example.test', email_confirmed_at: '2026-09-01T00:00:00Z' }), { status: 200 });
    }) as unknown as typeof fetch;
    const user = await fetchSupabaseUser('tok', config, { anonKey: 'anon', fetchImpl: spy });
    assert.equal(seen!.url, `${URL_}/auth/v1/user`);
    assert.equal(seen!.headers.Authorization, 'Bearer tok');
    assert.equal(seen!.headers.apikey, 'anon');
    assert.equal(user?.email, 'person@example.test');
    assert.ok(user?.emailConfirmedAt);
  });
  it('withProviderVerification upgrades only when subject and email match and the email is confirmed', () => {
    const confirmed = new Date('2026-09-01T00:00:00Z');
    assert.equal(withProviderVerification(base, null).emailVerified, false);
    assert.equal(withProviderVerification(base, { id: 'other', email: base.email, emailConfirmedAt: confirmed }).emailVerified, false, 'subject mismatch');
    assert.equal(withProviderVerification(base, { id: SUB, email: base.email, emailConfirmedAt: null }).emailVerified, false, 'not confirmed');
    assert.equal(withProviderVerification(base, { id: SUB, email: 'else@example.test', emailConfirmedAt: confirmed }).emailVerified, false, 'email mismatch');
    assert.equal(withProviderVerification(base, { id: SUB, email: base.email, emailConfirmedAt: confirmed }).emailVerified, true);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import {
  identityFromClaims,
  supabaseIdentityConfig,
  SupabaseIdentityError,
  verifySupabaseAccessToken,
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
  it('accepts a well-formed token and normalises the identity', async () => {
    const id = await verifySupabaseAccessToken(await mint(), config);
    assert.equal(id.subject, SUB);
    assert.equal(id.email, 'person@example.test');
    assert.equal(id.emailVerified, true);
    assert.equal(id.assuranceLevel, 'aal1');
    assert.equal(id.providerSessionId, 'sess-1');
  });
  it('carries aal2 through, and treats anything else as aal1', async () => {
    assert.equal((await verifySupabaseAccessToken(await mint({ aal: 'aal2' }), config)).assuranceLevel, 'aal2');
    assert.equal((await verifySupabaseAccessToken(await mint({ aal: 'aal9' }), config)).assuranceLevel, 'aal1');
  });
  it('does not treat an unverified email as verified', async () => {
    const id = await verifySupabaseAccessToken(await mint({ user_metadata: {} }), config);
    assert.equal(id.emailVerified, false);
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

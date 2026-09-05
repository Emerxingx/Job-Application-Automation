import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Every call to the provider is bounded (review M6): a hung issuer must not hold a request open. */
export const OIDC_FETCH_TIMEOUT_MS = 10_000;
/** The signing algorithms an ID token may use; HS* would let the client secret sign one, `none` is refused by jose already. */
export const ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'] as const;

/**
 * Stage 20 (ADR-0035) - the OpenID Connect pieces, kept pure and injectable.
 *
 * Authorization Code flow with PKCE (S256), a nonce bound to the ID token,
 * discovery from the issuer's well-known document, and ID-token verification
 * against the issuer's JWKS with jose. Nothing here reads the database or the
 * environment: the service hands in the connection, the test hands in a fake
 * issuer (`fetchImpl` and `getKey`), and the same code runs against both. No
 * real identity provider has been called from this codebase - the register
 * says IMPLEMENTED-NOT-VALIDATED, and the discovery/JWKS/token calls are the
 * three network calls a validation would exercise.
 */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** Advertised; the flow REQUIRES `code` and `S256`. */
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export class OidcError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'OidcError';
    this.status = status;
  }
}

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier (43-128 URL-safe characters) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: pkceChallenge(verifier) };
}
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}
export function randomToken(bytes = 24): string {
  return base64url(randomBytes(bytes));
}

/** An issuer is an https URL (http only for a loopback test issuer) without query or fragment. */
export function isIssuerUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    if (u.search || u.hash) return false;
    if (u.protocol === 'https:') return true;
    return isLoopbackHttp(value);
  } catch {
    return false;
  }
}

function isLoopbackHttp(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

/** Fetch and validate the issuer's discovery document. The document's `issuer` MUST equal the configured issuer (RFC 8414 §3.3) - a mix-up defence. */
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcDiscovery> {
  if (!isIssuerUrl(issuer)) throw new OidcError('The issuer is not a valid URL.', 422);
  const url = issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(OIDC_FETCH_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new OidcError('The identity provider could not be reached for discovery.', 502);
  }
  if (!res.ok) throw new OidcError(`Discovery failed (${res.status}).`, 502);
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (doc.issuer?.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) throw new OidcError('The discovery document names a different issuer.', 502);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    // Every endpoint is https (the client secret is POSTed to the token
    // endpoint; the JWKS decides who may sign in) - loopback http only for a
    // test issuer, the same rule as the issuer itself.
    if (typeof doc[k] !== 'string' || !isIssuerUrl(doc[k] as string) && !isLoopbackHttp(doc[k] as string)) throw new OidcError(`The discovery document lacks an https ${k}.`, 502);
  }
  if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes('S256')) throw new OidcError('The identity provider does not support PKCE S256.', 502);
  return doc as OidcDiscovery;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** `openid email profile` by default; `email` is what the platform needs. */
  scope?: string;
  loginHint?: string;
}

export function authorizationUrl(discovery: OidcDiscovery, req: AuthorizationRequest): string {
  const u = new URL(discovery.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', req.clientId);
  u.searchParams.set('redirect_uri', req.redirectUri);
  u.searchParams.set('scope', req.scope ?? 'openid email profile');
  u.searchParams.set('state', req.state);
  u.searchParams.set('nonce', req.nonce);
  u.searchParams.set('code_challenge', req.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (req.loginHint) u.searchParams.set('login_hint', req.loginHint);
  return u.toString();
}

export interface TokenResponse {
  id_token: string;
  access_token?: string;
  token_type?: string;
}

/** Exchange the code at the token endpoint with the client secret in the body (client_secret_post) and the PKCE verifier. */
export async function exchangeCode(
  discovery: OidcDiscovery,
  input: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, client_id: input.clientId, client_secret: input.clientSecret, code_verifier: input.codeVerifier });
  let res: Response;
  try {
    res = await fetchImpl(discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(OIDC_FETCH_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new OidcError('The identity provider could not be reached to redeem the code.', 502);
  }
  if (!res.ok) throw new OidcError(`The identity provider refused the code (${res.status}).`, 401);
  const json = (await res.json()) as Partial<TokenResponse>;
  if (typeof json.id_token !== 'string') throw new OidcError('The token response carries no ID token.', 502);
  return json as TokenResponse;
}

export interface VerifiedIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/**
 * Verify the ID token: signature against the issuer's JWKS, `iss`, `aud`,
 * `exp`, and the `nonce` this sign-in minted. Then the claims the platform
 * needs: a verified email, lower-cased. An unverified email is refused - the
 * provider is vouching for an address the platform will trust as an identity.
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

/** One remote JWKS per URI, cached for the process: jose refreshes it on an unknown kid and rate-limits refetches, so a sign-in does not refetch the key set every time. */
export function remoteJwks(jwksUri: string): JWTVerifyGetKey {
  let getKey = jwksCache.get(jwksUri);
  if (!getKey) {
    getKey = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: OIDC_FETCH_TIMEOUT_MS, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    jwksCache.set(jwksUri, getKey);
  }
  return getKey;
}

export async function verifyIdToken(idToken: string, opts: { issuer: string; clientId: string; nonce: string; getKey?: JWTVerifyGetKey; jwksUri?: string }): Promise<VerifiedIdentity> {
  const getKey = opts.getKey ?? remoteJwks(opts.jwksUri ?? '');
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getKey, { issuer: [opts.issuer, opts.issuer.replace(/\/$/, ''), opts.issuer.replace(/\/$/, '') + '/'], audience: opts.clientId, clockTolerance: 60, algorithms: [...ID_TOKEN_ALGORITHMS] }));
  } catch {
    throw new OidcError('The ID token did not verify.', 401);
  }
  if (payload.nonce !== opts.nonce) throw new OidcError('The ID token was not issued for this sign-in (nonce).', 401);
  if (typeof payload.sub !== 'string' || !payload.sub) throw new OidcError('The ID token carries no subject.', 401);
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) throw new OidcError('The identity provider did not release an email address.', 403);
  if (payload.email_verified !== true) throw new OidcError('The identity provider has not verified that email address.', 403);
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  return { subject: payload.sub, email, emailVerified: true, name };
}

/** The domain part of an address, lower-case; '' when there is none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

export function isEmailDomain(value: unknown): value is string {
  return typeof value === 'string' && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

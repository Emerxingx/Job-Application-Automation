import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';

/**
 * Supabase Auth identity verification — the platform side of the ratified
 * Stage 01 authentication decision (docs/programme/AUTH_DECISION_GATE.md).
 *
 * STATUS: IMPLEMENTED-NOT-VALIDATED. This module verifies a Supabase access
 * token and extracts the identity claims the platform needs. It has been
 * exercised only with tokens minted locally in the same shape (tests/
 * supabase-identity.test.ts); it has NOT been run against a token issued by
 * a real project, because the build environment cannot reach one — see
 * AUTONOMOUS_STATUS.json → blockers. It must not be described as validated
 * until it has (INTEGRATION_REGISTER.md).
 *
 * WHAT IS VERIFIED, AND WHY EACH THING
 * -----------------------------------
 *   signature  — HS256 against SUPABASE_JWT_SECRET (the project's legacy
 *                shared secret) or an asymmetric key from the project's JWKS
 *                (SUPABASE_URL/auth/v1/.well-known/jwks.json). Both are
 *                supported because Supabase projects are migrating from the
 *                former to the latter; a project has one or the other in force.
 *   issuer     — must be `${SUPABASE_URL}/auth/v1` when SUPABASE_URL is set.
 *                A token from ANOTHER Supabase project signed with the same
 *                algorithm family is otherwise indistinguishable.
 *   audience   — must be `authenticated`. Supabase's `anon` role tokens are
 *                also valid JWTs; they are not an identity.
 *   expiry     — enforced by jose.
 *
 * What is NOT done here: no user is created, linked or signed in. That is the
 * exchange route's job, on the system client, with the linkage rules in
 * linkSupabaseIdentity. This module is pure verification so it can be tested
 * without a database.
 *
 * FAIL CLOSED. Missing configuration is `null` from `supabaseIdentityConfig`,
 * and the exchange route answers 503 rather than accepting anything.
 */

export interface SupabaseIdentityConfig {
  /** `https://<ref>.supabase.co`, no trailing slash. */
  url: string | null;
  /** HS256 shared secret, when the project still uses one. */
  jwtSecret: string | null;
  /** JWKS endpoint for asymmetric keys, derived from `url`. */
  jwksUrl: string | null;
}

export function supabaseIdentityConfig(env: NodeJS.ProcessEnv = process.env): SupabaseIdentityConfig | null {
  const url = env.SUPABASE_URL?.replace(/\/+$/, '') || null;
  const jwtSecret = env.SUPABASE_JWT_SECRET && env.SUPABASE_JWT_SECRET.length >= 32 ? env.SUPABASE_JWT_SECRET : null;
  if (!jwtSecret && !url) return null;
  return { url, jwtSecret, jwksUrl: url ? `${url}/auth/v1/.well-known/jwks.json` : null };
}

export interface SupabaseIdentity {
  /** auth.users.id — the stable subject. */
  subject: string;
  email: string | null;
  /**
   * TRUE only when the provider itself reported `email_confirmed_at` for this
   * user (see `fetchSupabaseUser`). The token cannot establish this.
   */
  emailVerified: boolean;
  /** aal1 or aal2, per the MFA assurance claim. */
  assuranceLevel: 'aal1' | 'aal2';
  /** Supabase's own session id, for correlation only. */
  providerSessionId: string | null;
  issuedAt: Date | null;
}

export class SupabaseIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseIdentityError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure claim extraction, shared by the HS256 and JWKS paths. */
export function identityFromClaims(payload: JWTPayload): SupabaseIdentity {
  const subject = payload.sub;
  if (typeof subject !== 'string' || !UUID.test(subject)) {
    throw new SupabaseIdentityError('Token subject is not a Supabase user id');
  }
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase().trim() : null;
  const aal = payload.aal === 'aal2' ? 'aal2' : 'aal1';
  return {
    subject,
    email,
    // NEVER derived from the token. `user_metadata.email_verified` is writable
    // by the end user through updateUser(), and Supabase issues no trusted
    // top-level claim for it, so a token can only ever say "unverified" here.
    // The exchange route asks the provider (fetchSupabaseUser) and overrides
    // this from `email_confirmed_at`, which the user cannot set.
    emailVerified: false,
    assuranceLevel: aal,
    providerSessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    issuedAt: typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : null,
  };
}

/**
 * Verify a Supabase access token and return its identity. Throws
 * SupabaseIdentityError on any failure; never returns a partial identity.
 */
export async function verifySupabaseAccessToken(
  token: string,
  config: SupabaseIdentityConfig,
  options: { jwks?: ReturnType<typeof createRemoteJWKSet> } = {},
): Promise<SupabaseIdentity> {
  const verifyOptions: JWTVerifyOptions = {
    audience: 'authenticated',
    ...(config.url ? { issuer: `${config.url}/auth/v1` } : {}),
    // Supabase tokens are short-lived (an hour by default); a token older than
    // a day is stale whatever its exp says.
    maxTokenAge: '1 day',
  };
  try {
    if (config.jwtSecret) {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), {
        ...verifyOptions,
        algorithms: ['HS256'],
      });
      return identityFromClaims(payload);
    }
    if (config.jwksUrl) {
      const jwks = options.jwks ?? createRemoteJWKSet(new URL(config.jwksUrl));
      const { payload } = await jwtVerify(token, jwks, { ...verifyOptions, algorithms: ['ES256', 'RS256'] });
      return identityFromClaims(payload);
    }
  } catch (error) {
    if (error instanceof SupabaseIdentityError) throw error;
    throw new SupabaseIdentityError('Token could not be verified');
  }
  throw new SupabaseIdentityError('Supabase identity is not configured');
}

/**
 * Ask the provider who the token belongs to, and whether that user's email is
 * confirmed. `GET /auth/v1/user` returns the `auth.users` row for the bearer;
 * `email_confirmed_at` is set by the provider's own confirmation flow and is
 * not user-writable, unlike anything in `user_metadata`.
 *
 * Returns `null` when the provider cannot be consulted (no URL configured, no
 * anon key, network failure, non-2xx) — the caller must treat null as
 * UNVERIFIED. It never throws on a network error, so a provider outage
 * degrades to "cannot link by email" rather than a 500, and never returns a
 * partial answer.
 */
export interface SupabaseProviderUser {
  id: string;
  email: string | null;
  emailConfirmedAt: Date | null;
}

export async function fetchSupabaseUser(
  accessToken: string,
  config: SupabaseIdentityConfig,
  options: { anonKey?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<SupabaseProviderUser | null> {
  const anonKey = options.anonKey ?? process.env.SUPABASE_ANON_KEY ?? null;
  if (!config.url || !anonKey) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${config.url}/auth/v1/user`, {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: unknown; email?: unknown; email_confirmed_at?: unknown };
    if (typeof body.id !== 'string' || !UUID.test(body.id)) return null;
    const confirmed = typeof body.email_confirmed_at === 'string' ? new Date(body.email_confirmed_at) : null;
    return {
      id: body.id,
      email: typeof body.email === 'string' ? body.email.toLowerCase().trim() : null,
      emailConfirmedAt: confirmed && !Number.isNaN(confirmed.getTime()) ? confirmed : null,
    };
  } catch {
    return null;
  }
}

/**
 * Combine the verified token with the provider's answer. The subject must
 * match (a token for user A must not be upgraded with user B's record) and
 * the confirmed email must equal the token's email; otherwise the identity is
 * returned unverified, never rejected — rule 1 in link.ts still applies to an
 * already-linked identity.
 */
export function withProviderVerification(
  identity: SupabaseIdentity,
  providerUser: SupabaseProviderUser | null,
): SupabaseIdentity {
  if (!providerUser) return identity;
  if (providerUser.id !== identity.subject) return identity;
  if (!providerUser.emailConfirmedAt) return identity;
  if (identity.email !== null && providerUser.email !== identity.email) return identity;
  return { ...identity, email: identity.email ?? providerUser.email, emailVerified: true };
}

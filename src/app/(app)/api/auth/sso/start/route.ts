import { z } from 'zod';
import { cookies } from 'next/headers';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, clientAddress, rateLimit } from '@/lib/rate-limit';
import { appUrl } from '@/lib/app-url';
import { SSO_STATE_COOKIE, SSO_STATE_TTL_SECONDS, SsoError, beginSsoSignIn } from '@/lib/sso/service';
import { OidcError } from '@/lib/sso/oidc';

const schema = z.object({ email: z.string().email().max(254) });

/**
 * POST /api/auth/sso/start - route an address to its organisation's OIDC
 * connection and answer with the provider's authorization URL (Stage 20,
 * ADR-0035). Public (no session yet), address-limited like the password
 * route. The PKCE verifier and nonce travel in a signed, httpOnly, ten-minute
 * cookie; the `state` parameter is that token's id.
 */
export const POST = route(async (request: Request) => {
  const limit = rateLimit('auth', clientAddress(request), LIMITS.auth);
  if (!limit.ok) return tooMany(`Too many attempts. Try again in ${describeWait(limit.retryAfterSeconds)}.`, limit.retryAfterSeconds);
  const body = schema.parse(await request.json());
  try {
    const { url, stateToken, organizationName } = await beginSsoSignIn({ email: body.email, redirectUri: `${appUrl()}/api/auth/sso/callback` });
    const store = await cookies();
    store.set(SSO_STATE_COOKIE, stateToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/auth/sso', maxAge: SSO_STATE_TTL_SECONDS });
    return ok({ redirect: url, organizationName });
  } catch (error) {
    if (error instanceof SsoError || error instanceof OidcError) return fail(error.message, error.status);
    throw error;
  }
});

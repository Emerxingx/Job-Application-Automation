import { NextResponse } from 'next/server';
import { LIMITS, clientAddress, rateLimit } from '@/lib/rate-limit';
import { SCIM_ERROR_SCHEMA, ScimError, authenticateScim, type ScimPrincipal } from './service';
import { redactError } from '@/lib/log';

/**
 * The SCIM route wrapper: bearer authentication, a per-token rate limit, the
 * SCIM error envelope (RFC 7644 §3.12) and the `application/scim+json`
 * content type. Deliberately NOT `route()`: a SCIM client is a machine with a
 * token, not a browser with a cookie, so the session, impersonation and
 * internal-envelope rules do not apply - and its errors must be SCIM errors.
 */
export function scimJson(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: { 'content-type': 'application/scim+json; charset=utf-8', 'cache-control': 'no-store' } });
}

export function scimError(status: number, detail: string, scimType?: string): Response {
  return scimJson({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status);
}

export function scimBaseUrl(request: Request): string {
  const u = new URL(request.url);
  return `${u.origin}/api/scim/v2`;
}

export function scimRoute<Args extends unknown[]>(handler: (principal: ScimPrincipal, request: Request, ...args: Args) => Promise<Response>): (request: Request, ...args: Args) => Promise<Response> {
  return async (request: Request, ...args: Args) => {
    try {
      // Unauthenticated attempts are budgeted per address (review L5): a token
      // guesser gets the auth limit, not unlimited tries at the digest table.
      const guesses = await rateLimit('auth', `scim:${clientAddress(request)}`, LIMITS.auth);
      if (!guesses.ok) return scimError(429, 'Too many requests.');
      const principal = await authenticateScim(request.headers.get('authorization'));
      const limit = await rateLimit('scim', principal.tokenId, LIMITS.scim);
      if (!limit.ok) return scimError(429, 'Too many requests.');
      return await handler(principal, request, ...args);
    } catch (error) {
      if (error instanceof ScimError) return scimError(error.status, error.message, error.scimType);
      if (error instanceof SyntaxError || error instanceof TypeError) return scimError(400, 'The request body is not a JSON object.', 'invalidSyntax');
      console.error('[scim] unhandled error:', redactError(error));
      return scimError(500, 'Something went wrong.');
    }
  };
}

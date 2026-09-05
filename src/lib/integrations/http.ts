/**
 * The plumbing behind `/api/v1/*` — the public, API-key-authenticated API.
 *
 * WHY THIS DOES NOT USE `fail()` FROM src/lib/api.ts
 * --------------------------------------------------
 * The internal app returns `{ error: "Agent not found." }`, and for a first-
 * party client that is exactly right: the caller is our own React code and the
 * only thing it does with the value is show it.
 *
 * A third-party client cannot branch on English. It needs a stable, documented
 * token to switch on — retry on `rate_limited`, re-auth on `unauthorized`,
 * surface-to-the-user on `invalid_request` — and that token has to survive us
 * rewording the message. So the public API returns a structured error:
 *
 *     { "error": { "type": "...", "code": "...", "message": "...", "param": "..." } }
 *
 * The internal convention is unchanged and still applies to every route under
 * `/api/integrations/*`, which is first-party and uses `ok()`/`fail()`.
 *
 * WHY `v1Route` DOES NOT WRAP `route()`
 * -------------------------------------
 * `route()`'s catch block emits `{ error: string }`. Nesting would mean a
 * handled error returned the v1 envelope while an unhandled one returned the
 * internal shape — the public API's error contract would then hold right up
 * until something actually went wrong, which is the moment a client most needs
 * it to hold. `v1Route` therefore catches everything itself, including the
 * `ZodError` and `UnauthorizedError` cases `route()` knows about.
 *
 * NO CORS HEADERS, DELIBERATELY
 * -----------------------------
 * Nothing here sends `Access-Control-Allow-Origin`. An API key is a bearer
 * credential; putting one in browser-side JavaScript ships it to every visitor.
 * Enabling CORS would be an invitation to do exactly that. Calls come from
 * servers, and the absence of a preflight response is the first thing that
 * tells a developer they are holding it wrong.
 */

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { LIMITS, clientAddress, rateLimit, type RateLimitResult, type RateLimitRule } from '../rate-limit';
import {
  authenticateApiKey,
  extractApiKey,
  prismaApiKeyStore,
  recordApiKeyUse,
  type ApiScope,
  type AuthenticatedApiKey,
} from './api-keys';
import { redactError } from '@/lib/log';

// --- Errors -----------------------------------------------------------------

export type ApiErrorCode =
  | 'unauthorized'
  | 'insufficient_scope'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'internal_error'
  // Stage 14: a dependency this deployment does not have (an identity provider), 503.
  | 'unavailable';

/** Broad class, for clients that want to handle whole families at once. */
const ERROR_TYPES: Record<ApiErrorCode, string> = {
  unauthorized: 'authentication_error',
  insufficient_scope: 'permission_error',
  invalid_request: 'invalid_request_error',
  not_found: 'not_found_error',
  rate_limited: 'rate_limit_error',
  internal_error: 'api_error',
  unavailable: 'api_error',
};

export interface ApiErrorOptions {
  /** The offending query parameter or body field, when there is one. */
  param?: string;
  headers?: Record<string, string>;
}

/** A public-API error response. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  status: number,
  options: ApiErrorOptions = {},
): NextResponse {
  return NextResponse.json(
    {
      error: {
        type: ERROR_TYPES[code],
        code,
        message,
        ...(options.param ? { param: options.param } : {}),
      },
    },
    { status, headers: options.headers },
  );
}

/**
 * Thrown by helpers inside a handler to abort with a specific public error.
 * Caught by `v1Route`, which is the only place that turns it into a response.
 */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly param?: string;

  constructor(code: ApiErrorCode, message: string, status: number, param?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.param = param;
  }
}

/** Shorthand for the overwhelmingly common case. */
export function badRequest(message: string, param?: string): ApiRequestError {
  return new ApiRequestError('invalid_request', message, 400, param);
}

export function notFound(message: string): ApiRequestError {
  return new ApiRequestError('not_found', message, 404);
}

// --- Rate limiting ----------------------------------------------------------

/** The bucket name, shared by every v1 endpoint. */
export const V1_RATE_BUCKET = 'api_v1';

/**
 * A separate budget for requests that FAIL authentication, keyed by client
 * address rather than by key — a request with no valid key has no key to charge.
 *
 * Only failures are counted, so a legitimate integration pushing thousands of
 * authenticated requests from one address never touches this bucket. What it
 * catches is the client looping on a rotated key, or someone walking the key
 * space, and it converts that into a 429 the caller can actually see.
 *
 * Honest about what it does NOT do: the lookup still happens before the failure
 * is known, so this does not spare the database a `findUnique` per request. That
 * is deliberate rather than an oversight — the lookup is a single hit on a
 * unique index, and the attack this would otherwise be defending against
 * (guessing a key) is already infeasible against 256 bits of entropy. The value
 * here is bounding sustained noise, not preventing a break-in.
 */
export const V1_AUTH_FAILURE_BUCKET = 'api_v1_auth_fail';
export const V1_AUTH_FAILURE_RULE = { limit: 60, windowSeconds: 300 };

/**
 * Standard rate-limit headers.
 *
 * Sent on SUCCESSFUL responses too, not only on 429s. A client that can only
 * discover its budget by exceeding it has to hit the wall to learn where the
 * wall is; a client that sees `X-RateLimit-Remaining: 3` can slow down first.
 */
export function rateLimitHeaders(result: RateLimitResult, limit: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt.getTime() / 1000)),
  };
}

/**
 * Consume one unit of the key's per-minute budget.
 *
 * Keyed by `ApiKey.id`, NOT by user id: the budget belongs to the credential,
 * so a runaway script holding one key cannot starve the same customer's other
 * integrations, and revoking that key immediately frees its share.
 */
export function enforceApiKeyRateLimit(key: AuthenticatedApiKey): RateLimitResult {
  return rateLimit(V1_RATE_BUCKET, key.id, {
    limit: Math.max(1, key.rateLimitPerMinute),
    windowSeconds: 60,
  });
}

// --- Route wrapper ----------------------------------------------------------

export interface V1Context {
  key: AuthenticatedApiKey;
  request: Request;
  url: URL;
  /** Attach to every response so the client can pace itself. */
  headers: Record<string, string>;
  /** Stage 14: the dynamic segments of the route (`{applicationId}` in the contract), decoded. Empty for a static path. */
  params: Record<string, string>;
}

/** What Next hands a dynamic route as its second argument. */
export interface V1RouteArgs {
  params: Promise<Record<string, string | string[] | undefined>>;
}

/** A successful v1 response, carrying the rate-limit headers. */
export function v1Ok<T>(context: V1Context, data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: context.headers });
}

/**
 * Authenticate by API key, enforce scope, enforce the rate limit, then run the
 * handler. The order matters: an unauthenticated request must not be able to
 * consume anyone's rate-limit budget, so authentication comes first, and the
 * bucket is only touched once we know whose it is.
 */
export function v1Route(
  requiredScope: ApiScope,
  handler: (context: V1Context) => Promise<Response>,
): (request: Request, args?: V1RouteArgs) => Promise<Response> {
  return async (request: Request, args?: V1RouteArgs) => {
    try {
      const params = await v1Params(args);
      const authentication = await authenticateApiKey(prismaApiKeyStore(), extractApiKey(request), {
        requiredScope,
      });

      if (!authentication.ok) {
        // A scope failure came from a VALID key, so it is not a credential
        // failure and must not count against the failure budget — a client
        // hitting one endpoint it lacks a scope for would otherwise lock itself
        // out of the endpoints it is entitled to.
        if (authentication.reason !== 'insufficient_scope') {
          const failures = rateLimit(
            V1_AUTH_FAILURE_BUCKET,
            clientAddress(request),
            V1_AUTH_FAILURE_RULE,
          );
          if (!failures.ok) {
            return apiError(
              'rate_limited',
              'Too many failed authentication attempts. Check your API key and try again shortly.',
              429,
              { headers: { 'Retry-After': String(failures.retryAfterSeconds) } },
            );
          }
        }

        const code: ApiErrorCode =
          authentication.reason === 'insufficient_scope' ? 'insufficient_scope' : 'unauthorized';
        return apiError(code, authentication.message, authentication.status, {
          // RFC 6750: a 401 on a bearer scheme should say which scheme it wants.
          headers:
            authentication.status === 401
              ? { 'WWW-Authenticate': 'Bearer realm="JobPilot API"' }
              : undefined,
        });
      }

      const key = authentication.key;
      const limit = enforceApiKeyRateLimit(key);
      const headers = rateLimitHeaders(limit, key.rateLimitPerMinute);

      if (!limit.ok) {
        return apiError(
          'rate_limited',
          `Rate limit of ${key.rateLimitPerMinute} requests per minute exceeded for this API key.`,
          429,
          { headers: { ...headers, 'Retry-After': String(limit.retryAfterSeconds) } },
        );
      }

      // Usage is stamped for requests that got past the gate. Counting refused
      // requests would make `requestCount` a measure of noise rather than of
      // what the customer actually did with the key.
      void recordApiKeyUse(key.id, clientAddress(request));

      const context: V1Context = { key, request, url: new URL(request.url), headers, params };
      return await handler(context);
    } catch (error) {
      return v1ErrorResponse(error);
    }
  };
}

/** Every failure a v1 handler can throw, as the one envelope. */
export function v1ErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiRequestError) {
    return apiError(error.code, error.message, error.status, { param: error.param });
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return apiError('invalid_request', issue?.message ?? 'Invalid request.', 400, {
      param: issue?.path.join('.') || undefined,
    });
  }
  console.error('[api/v1] unhandled error:', redactError(error));
  // The message is fixed rather than echoed. An exception string can carry
  // a query fragment or a file path, and a public API is exactly the wrong
  // place to hand those out.
  return apiError('internal_error', 'Something went wrong on our end.', 500);
}

/** Read the dynamic segments Next hands a route, decoded. */
export async function v1Params(args?: V1RouteArgs): Promise<Record<string, string>> {
  const rawParams = args ? await args.params : {};
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawParams)) if (typeof v === 'string') params[k] = decodeURIComponent(v);
  return params;
}

export interface V1PublicContext {
  request: Request;
  url: URL;
  headers: Record<string, string>;
  params: Record<string, string>;
}

/**
 * Stage 14: a v1 endpoint that has NO key yet - the mobile sign-in that mints
 * one. Same envelope, same error handling; the budget is the address's, on the
 * sign-in rule (`LIMITS.auth`), because the caller has no credential to charge
 * and the thing to blunt is credential stuffing. Nothing else in /api/v1 may
 * use this: every other operation has a key, and a key is what scopes a read.
 */
export function v1PublicRoute(
  handler: (context: V1PublicContext) => Promise<Response>,
  options: { bucket?: string; rule?: RateLimitRule } = {},
): (request: Request, args?: V1RouteArgs) => Promise<Response> {
  return async (request: Request, args?: V1RouteArgs) => {
    try {
      const params = await v1Params(args);
      const limit = rateLimit(options.bucket ?? 'auth', clientAddress(request), options.rule ?? LIMITS.auth);
      if (!limit.ok) {
        return apiError('rate_limited', 'Too many attempts. Try again shortly.', 429, {
          headers: { 'Retry-After': String(limit.retryAfterSeconds) },
        });
      }
      return await handler({ request, url: new URL(request.url), headers: {}, params });
    } catch (error) {
      return v1ErrorResponse(error);
    }
  };
}

// --- Query parameters -------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Offset pagination, capped.
 *
 * Offset rather than cursor, knowingly: it is what a caller expects from a
 * first version, and it composes with the arbitrary filters below without
 * needing a stable sort key per filter combination. The cost is that a row
 * inserted during a walk can shift the window — acceptable for a read API over
 * a user's own records, and something a cursor API would have to solve before
 * it was worth the extra surface.
 */
export function parsePagination(url: URL): Pagination {
  const limit = parseBoundedInt(url.searchParams.get('limit'), {
    fallback: DEFAULT_PAGE_SIZE,
    min: 1,
    max: MAX_PAGE_SIZE,
    param: 'limit',
  });
  const offset = parseBoundedInt(url.searchParams.get('offset'), {
    fallback: 0,
    min: 0,
    max: 100_000,
    param: 'offset',
  });
  return { limit, offset };
}

/**
 * Parse an integer parameter, REFUSING out-of-range values rather than
 * clamping them.
 *
 * Silently clamping `limit=1000` to 100 gives the caller 100 rows and no
 * indication that 900 are missing, which reads as data loss on their side. A
 * 400 that names the bound is what lets them fix their code.
 */
export function parseBoundedInt(
  raw: string | null,
  options: { fallback: number; min: number; max: number; param: string },
): number {
  if (raw === null || raw.trim() === '') return options.fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw badRequest(`\`${options.param}\` must be an integer.`, options.param);
  }
  if (value < options.min || value > options.max) {
    throw badRequest(
      `\`${options.param}\` must be between ${options.min} and ${options.max}.`,
      options.param,
    );
  }
  return value;
}

/** Read a parameter constrained to a fixed set of values. */
export function parseEnumParam<T extends string>(
  url: URL,
  param: string,
  allowed: readonly T[],
): T | undefined {
  const raw = url.searchParams.get(param);
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (!(allowed as readonly string[]).includes(value)) {
    throw badRequest(`\`${param}\` must be one of: ${allowed.join(', ')}.`, param);
  }
  return value as T;
}

/** Read an ISO-8601 date parameter. */
export function parseDateParam(url: URL, param: string): Date | undefined {
  const raw = url.searchParams.get(param);
  if (raw === null || raw.trim() === '') return undefined;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw badRequest(`\`${param}\` must be an ISO-8601 date, e.g. 2026-08-01.`, param);
  }
  return value;
}

/** The list envelope every collection endpoint returns. */
export interface ListEnvelope<T> {
  object: 'list';
  data: T[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export function listEnvelope<T>(data: T[], pagination: Pagination, total: number): ListEnvelope<T> {
  return {
    object: 'list',
    data,
    pagination: {
      limit: pagination.limit,
      offset: pagination.offset,
      total,
      hasMore: pagination.offset + data.length < total,
    },
  };
}

/**
 * Every failure the app sees is one of two shapes: the server's structured
 * envelope (`{ error: { type, code, message, param } }`, the one thing the
 * contract promises about errors) or the absence of a server (no network, a
 * timeout, a proxy answering with something that is not the envelope).
 *
 * Screens branch on `code`, never on the message: the message is for the
 * person, the code is for the program (ADR-0028, the reason the public API
 * has a structured envelope at all).
 */

export const ERROR_CODES = [
  'unauthorized',
  'insufficient_scope',
  'invalid_request',
  'not_found',
  'rate_limited',
  'internal_error',
  'unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  error: { type: string; code: string; message: string; param?: string };
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string');
}

export class ApiError extends Error {
  readonly code: ErrorCode | 'unknown';
  readonly type: string;
  readonly status: number;
  readonly param: string | undefined;
  /** Seconds, from Retry-After, when the server said to wait. */
  readonly retryAfter: number | null;

  constructor(status: number, envelope: ErrorEnvelope['error'], retryAfter: number | null = null) {
    super(envelope.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = (ERROR_CODES as readonly string[]).includes(envelope.code) ? (envelope.code as ErrorCode) : 'unknown';
    this.type = envelope.type;
    this.param = envelope.param;
    this.retryAfter = retryAfter;
  }

  /** The credential is gone (revoked, expired, never valid): the app must sign out, not retry. */
  get unauthorized(): boolean {
    return this.code === 'unauthorized';
  }
}

/** The server could not be reached, or answered with something that is not the API. */
export class NetworkError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** A response that was not JSON, or JSON that is not the envelope: treated as the server being unreachable, because nothing else is safe to assume. */
export class MalformedResponseError extends NetworkError {
  readonly status: number;
  constructor(status: number) {
    super(`The server answered ${status} with a body that is not the API's envelope.`);
    this.name = 'MalformedResponseError';
    this.status = status;
  }
}

/** Words for the person, by code; the message the server sent is preferred when it is one. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unauthorized':
        return 'Your session has ended. Sign in again.';
      case 'rate_limited':
        return error.retryAfter ? `Too many requests. Try again in ${error.retryAfter} seconds.` : 'Too many requests. Try again shortly.';
      case 'unavailable':
        return error.message || 'That service is not available on this deployment.';
      default:
        return error.message;
    }
  }
  if (error instanceof NetworkError) return 'You appear to be offline. Showing what was saved on this device where possible.';
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { UnauthorizedError } from './auth';

/** Standard JSON success response. */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/** Standard JSON error response. */
export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Wrap a route handler so auth and validation failures become clean HTTP
 * responses instead of unhandled 500s.
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return fail('Please sign in to continue.', 401);
      }
      if (error instanceof ZodError) {
        return fail(error.issues[0]?.message ?? 'Invalid request.', 422);
      }
      console.error('[api] unhandled error:', error);
      const message =
        error instanceof Error ? error.message : 'Something went wrong. Please try again.';
      return fail(message, 500);
    }
  };
}

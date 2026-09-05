import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { currentImpersonation, ImpersonationReadOnlyError, UnauthorizedError } from './auth';
import { TenantContextError } from './tenancy/context';
import { OrganizationAccessError } from './tenancy/organizations';
import { ApplicationModeError } from './apply/modes';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Standard JSON success response. */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/** Standard JSON error response. */
export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Rate-limit rejection. Carries Retry-After so a well-behaved client waits
 * the right amount of time instead of retrying immediately.
 */
export function tooMany(message: string, retryAfterSeconds: number) {
  return NextResponse.json(
    { error: message, retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/** Phrase a wait in units a person reads without doing arithmetic. */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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
      // Stage 20 (ADR-0035): a support impersonation is READ-ONLY. Every
      // handler that could write goes through here, so the refusal lives here
      // and not in each route; the one exception is the endpoint that ENDS
      // the impersonation, which is not wrapped by route().
      const request = args[0];
      // Logout is the one write allowed: destroySession ends the impersonation first (M7).
      if (request instanceof Request && !READ_METHODS.has(request.method) && new URL(request.url).pathname !== '/api/auth/logout' && (await currentImpersonation())) {
        return fail('This is a read-only support session: nothing can be changed while impersonating. End the impersonation to act as yourself.', 403);
      }
      return await handler(...args);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return fail('Please sign in to continue.', 401);
      }
      if (error instanceof ImpersonationReadOnlyError) {
        return fail(error.message, error.status);
      }
      if (error instanceof ZodError) {
        return fail(error.issues[0]?.message ?? 'Invalid request.', 422);
      }
      if (error instanceof OrganizationAccessError) {
        return fail(error.message, error.status);
      }
      if (error instanceof ApplicationModeError) {
        // A mode refusal is the applicant's own setting, said in their words.
        return fail(error.message, error.status);
      }
      if (error instanceof TenantContextError) {
        // A request that could not establish who it acts for is not a server
        // fault and must not read like one; it is refused as unauthorised.
        return fail('Please sign in to continue.', 401);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // Known database outcomes map to statuses; their messages are not
        // returned because they name tables, columns and constraints.
        if (error.code === 'P2002') return fail('That already exists.', 409);
        if (error.code === 'P2003') return fail('A referenced record does not exist.', 422);
        if (error.code === 'P2025') return fail('Not found.', 404);
      }
      // Everything else is logged server-side and answered generically: an
      // unexpected error's message can carry a table name, a policy name or a
      // provider's own text, none of which belongs in a response body.
      console.error('[api] unhandled error:', error);
      return fail('Something went wrong. Please try again.', 500);
    }
  };
}

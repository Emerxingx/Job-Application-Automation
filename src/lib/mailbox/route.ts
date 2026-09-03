import { fail, route } from '../api';
import { MailboxError } from './service';

/** Stage 11 — the shared wrapper for mailbox routes: a refusal is a clean 4xx/5xx with its reason, never a 500. */
export function mailboxRoute<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>): (...args: Args) => Promise<Response> {
  return route(async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof MailboxError) return fail(error.message, error.status);
      throw error;
    }
  });
}

/** The callback URL the provider returns to; derived from the request so the flow never trusts a stored origin. */
export function callbackUri(request: Request): string {
  return new URL('/api/mailbox/callback', request.url).toString();
}

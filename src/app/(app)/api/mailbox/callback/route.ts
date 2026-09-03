import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { completeConnection, MailboxError } from '@/lib/mailbox/service';
import { callbackUri } from '@/lib/mailbox/route';
import { requestMeta } from '@/lib/security-audit';
import { route } from '@/lib/api';

/**
 * GET /api/mailbox/callback?code&state — the provider returns here. The
 * signed state must belong to the signed-in user; the result is a redirect
 * to settings with a status, never a page that renders provider data.
 */
export const GET = route(async (request: Request) => {
  const user = await requireUser();
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const back = (status: string) => NextResponse.redirect(new URL(`/dashboard/settings?mailbox=${encodeURIComponent(status)}`, request.url), 302);
  if (!code || !state) return back('denied');
  try {
    await completeConnection(user, { code, state, redirectUri: callbackUri(request) }, requestMeta(request));
    return back('connected');
  } catch (error) {
    if (error instanceof MailboxError) return back(error.status === 403 ? 'state' : error.status === 503 ? 'unavailable' : 'refused');
    // The browser is mid-redirect from the provider: a network or provider
    // failure must land on settings with a notice, never on a JSON error body.
    // The message is logged without the code, the state or any token.
    console.error('[mailbox] callback failed:', error instanceof Error ? error.message : 'unknown error');
    return back('failed');
  }
});

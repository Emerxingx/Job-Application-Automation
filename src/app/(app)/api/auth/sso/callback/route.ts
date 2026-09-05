import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { createSession } from '@/lib/auth';
import { appUrl } from '@/lib/app-url';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';
import { SSO_STATE_COOKIE, SsoError, completeSsoSignIn, sessionMaxHoursFor } from '@/lib/sso/service';
import { OidcError } from '@/lib/sso/oidc';
import { SsoKeyMissingError } from '@/lib/sso/crypto';

/**
 * GET /api/auth/sso/callback?code=&state= - the provider's redirect. Matches
 * the state cookie, redeems the code, verifies the ID token, provisions if
 * the connection allows it, and issues the same revocable session every
 * other sign-in gets. A refusal lands on the login page with a message; the
 * detail is in the audit log, not the URL.
 */
export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const providerError = url.searchParams.get('error');
  const store = await cookies();
  const stateToken = store.get(SSO_STATE_COOKIE)?.value ?? '';
  store.delete(SSO_STATE_COOKIE);
  const back = (message: string) => NextResponse.redirect(`${appUrl()}/login?sso=${encodeURIComponent(message)}`, 303);
  if (providerError) return back('The identity provider did not complete the sign-in.');
  if (!code || !state || !stateToken) return back('This sign-in has expired. Start again.');
  const meta = requestMeta(request);
  try {
    const result = await completeSsoSignIn({ code, state, stateToken, meta });
    const sessionId = await createSession(result.userId, { method: 'sso', meta, maxHours: await sessionMaxHoursFor(result.userId) });
    await recordSecurityEvent({ event: 'auth.login.succeeded', user: { id: result.userId, email: '' }, entityType: 'Session', entityId: sessionId, summary: 'Signed in', detail: { method: 'sso', organizationId: result.organizationId, provisioned: result.provisioned }, meta });
    return NextResponse.redirect(`${appUrl()}${result.onboarded ? '/dashboard' : '/onboarding'}`, 303);
  } catch (error) {
    if (error instanceof SsoError || error instanceof OidcError || error instanceof SsoKeyMissingError) return back(error.message);
    throw error;
  }
});

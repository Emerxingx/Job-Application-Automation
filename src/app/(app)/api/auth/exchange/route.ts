import { z } from 'zod';
import { createSession } from '@/lib/auth';
import { passwordSignInRefusal, sessionMaxHoursFor } from '@/lib/sso/service';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, clientAddress, rateLimit } from '@/lib/rate-limit';
import { SELF_SERVICE_PURPOSES } from '@/lib/consent';
import { activatePlan } from '@/lib/subscription';
import { IdentityLinkError, linkSupabaseIdentity } from '@/lib/identity/link';
import {
  fetchSupabaseUser,
  SupabaseIdentityError,
  supabaseIdentityConfig,
  verifySupabaseAccessToken,
  withProviderVerification,
} from '@/lib/identity/supabase';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';

const schema = z.object({
  accessToken: z.string().min(20).max(8192),
  fullName: z.string().min(2).max(120).optional(),
  consents: z.array(z.enum(SELF_SERVICE_PURPOSES)).optional(),
});

/**
 * Exchange a Supabase Auth access token for a platform session.
 *
 * Supabase authenticates (password, magic link, OAuth, MFA); the platform
 * authorises. The session issued here is the same server-side, revocable
 * session the password route issues, carrying the provider's assurance level.
 *
 * 503 when the provider is not configured: this deployment has no identity
 * provider, and saying so is safer than accepting a token nothing can verify.
 */
export const POST = route(async (request: Request) => {
  const config = supabaseIdentityConfig();
  if (!config) return fail('Identity provider sign-in is not configured on this deployment.', 503);

  const limit = rateLimit('auth', clientAddress(request), LIMITS.auth);
  if (!limit.ok) {
    return tooMany(`Too many attempts. Try again in ${describeWait(limit.retryAfterSeconds)}.`, limit.retryAfterSeconds);
  }

  const body = schema.parse(await request.json());
  const meta = requestMeta(request);

  let identity;
  try {
    identity = await verifySupabaseAccessToken(body.accessToken, config);
    // Email verification comes from the provider's own record, never from a
    // claim the user can write. Unreachable provider ⇒ unverified ⇒ no
    // linking by email and no account creation; an already-linked identity
    // still signs in.
    identity = withProviderVerification(identity, await fetchSupabaseUser(body.accessToken, config));
  } catch (error) {
    if (error instanceof SupabaseIdentityError) {
      await recordSecurityEvent({
        event: 'auth.login.failed',
        actor: { type: 'system' },
        summary: 'Identity-provider token rejected',
        detail: { provider: 'supabase', reason: error.message },
        meta,
      });
      return fail('That sign-in token is not valid.', 401);
    }
    throw error;
  }

  try {
    const { user, created } = await linkSupabaseIdentity(identity, {
      consents: body.consents,
      fullName: body.fullName,
      meta,
    });
    if (created) {
      try {
        await activatePlan(user.id, 'starter', 'monthly');
      } catch {
        // The plan is a convenience default; its absence is not a sign-in failure.
      }
    }
    // Stage 20 (ADR-0035): an organisation that requires SSO for its domain
    // closes this door for that domain too.
    const ssoRequired = await passwordSignInRefusal(user.email);
    if (ssoRequired) return fail(ssoRequired, 403);
    const sessionId = await createSession(user.id, {
      method: 'supabase',
      assuranceLevel: identity.assuranceLevel,
      meta,
      maxHours: await sessionMaxHoursFor(user.id),
    });
    await recordSecurityEvent({
      event: 'auth.login.succeeded',
      user,
      entityType: 'Session',
      entityId: sessionId,
      summary: 'Signed in through Supabase Auth',
      detail: { method: 'supabase', assuranceLevel: identity.assuranceLevel, created },
      meta,
    });
    return ok({ ok: true, redirect: user.onboardedAt ? '/dashboard' : '/onboarding' });
  } catch (error) {
    if (error instanceof IdentityLinkError) return fail(error.message, error.status);
    throw error;
  }
});

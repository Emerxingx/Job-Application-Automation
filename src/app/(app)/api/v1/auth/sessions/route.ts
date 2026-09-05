import { z } from 'zod';
import { CONSENT_PURPOSES } from '@/lib/consent';
import { DEVICE_PLATFORMS, issueDeviceSession, listDeviceSessions } from '@/lib/integrations/device-sessions';
import { loadMe } from '@/lib/integrations/candidate-api';
import { listEnvelope, notFound, parsePagination, v1Ok, v1PublicRoute, v1Route } from '@/lib/integrations/http';
import { requestMeta } from '@/lib/security-audit';

const device = z.object({
  name: z.string().trim().min(1).max(80),
  platform: z.enum(DEVICE_PLATFORMS),
});

const signInSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), email: z.string().email(), password: z.string().min(1).max(200), device }),
  z.object({
    method: z.literal('supabase'),
    accessToken: z.string().min(20).max(8192),
    fullName: z.string().trim().min(2).max(120).optional(),
    consents: z.array(z.enum(CONSENT_PURPOSES)).optional(),
    device,
  }),
]);

/**
 * POST /api/v1/auth/sessions (v1.1, public) - the mobile sign-in. The
 * applicant's password or Supabase token mints a DEVICE key: the bearer
 * credential every other operation takes, returned exactly once. Rate limited
 * by address on the sign-in rule (contract: DeviceSignIn -> DeviceSessionIssued).
 */
export const POST = v1PublicRoute(async (context) => {
  const body = signInSchema.parse(await context.request.json());
  const meta = requestMeta(context.request);
  const { device: descriptor, ...signIn } = body;
  const issued = await issueDeviceSession(signIn, descriptor, meta);
  const me = await loadMe(issued.user.id);
  if (!me) throw notFound('No profile for this key.');
  return new Response(JSON.stringify({ object: 'device_session_issued', token: issued.token, session: issued.session, onboarded: issued.user.onboarded, me }), {
    status: 201,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});

/** GET /api/v1/auth/sessions (v1.1) - the caller's signed-in devices, the current one flagged (contract: DeviceSessionList). */
export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const all = await listDeviceSessions(context.key.userId, context.key.id);
  return v1Ok(context, listEnvelope(all.slice(pagination.offset, pagination.offset + pagination.limit), pagination, all.length));
});

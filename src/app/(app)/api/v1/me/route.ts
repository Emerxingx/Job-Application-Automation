import { z } from 'zod';
import { loadMe, updateMe } from '@/lib/integrations/candidate-api';
import { ApplicationModeError } from '@/lib/apply/modes';
import { ApiRequestError, notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/me - the key owner's profile summary (contract: Me). */
export const GET = v1Route('read', async (context) => {
  const me = await loadMe(context.key.userId);
  if (!me) throw notFound('No profile for this key.');
  return v1Ok(context, me);
});

const patchSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Your name is required.').max(120).optional(),
    city: z.string().trim().max(120).nullable().optional(),
    headline: z.string().trim().max(160).nullable().optional(),
    applicationMode: z.string().max(40).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

/** PATCH /api/v1/me (v1.1) - the lightweight profile edits the mobile scope allows; the mode is parsed by parseApplicationMode (contract: MeUpdate -> Me). */
export const PATCH = v1Route('write', async (context) => {
  const body = patchSchema.parse(await context.request.json());
  let me;
  try {
    me = await updateMe(context.key.userId, body);
  } catch (error) {
    // The unreachable mode (ADR-0016): refused with its reason, as the web profile route refuses it.
    if (error instanceof ApplicationModeError) throw new ApiRequestError('invalid_request', error.message, error.status === 403 ? 403 : 400, 'applicationMode');
    throw error;
  }
  if (!me) throw notFound('No profile for this key.');
  return v1Ok(context, me);
});

import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { requestMeta } from '@/lib/security-audit';
import { staffingFail } from '@/lib/staffing/request';
import { respondToRepresentation, revokeRepresentation } from '@/lib/staffing/service';

const schema = z.object({ action: z.enum(['grant', 'decline', 'revoke']) });

/** PATCH /api/representations/:id - the candidate grants (a consent record is written), declines (final), or revokes. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  const body = schema.parse(await request.json());
  const meta = requestMeta(request);
  try {
    if (body.action === 'revoke') {
      await revokeRepresentation({ id: user.id, email: user.email }, id, meta);
      return ok({ status: 'revoked' });
    }
    const r = await respondToRepresentation({ id: user.id, email: user.email }, id, body.action === 'grant', meta);
    return ok({ status: r.status });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});

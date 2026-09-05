import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { requestMeta } from '@/lib/security-audit';
import { employerFail } from '@/lib/employer/request';
import { respondToDisclosure, revokeDisclosure } from '@/lib/employer/service';

const schema = z.object({ action: z.enum(['grant', 'decline', 'revoke']) });

/** PATCH /api/disclosures/:id - the candidate grants (a consent record is written), declines, or revokes (consent revoked, disclosed submissions withdrawn, pool memberships removed). */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  const body = schema.parse(await request.json());
  const meta = requestMeta(request);
  try {
    if (body.action === 'revoke') {
      await revokeDisclosure({ id: user.id, email: user.email }, id, meta);
      return ok({ status: 'revoked' });
    }
    const r = await respondToDisclosure({ id: user.id, email: user.email }, id, body.action === 'grant', meta);
    return ok({ status: r.status });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});

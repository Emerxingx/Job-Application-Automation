import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { requestMeta } from '@/lib/security-audit';
import { caseFail } from '@/lib/cases/request';
import { respondToInvitation, withdrawFromCase } from '@/lib/cases/service';

const schema = z.object({ action: z.enum(['accept', 'decline', 'withdraw']) });

/** PATCH /api/cases/invitations/:caseId - the client accepts (consent recorded), declines, or withdraws (consent revoked, case closed). */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ caseId: string }> }) => {
  const user = await requireUser();
  const { caseId } = await params;
  const body = schema.parse(await request.json());
  const meta = requestMeta(request);
  try {
    if (body.action === 'withdraw') {
      await withdrawFromCase({ id: user.id, email: user.email }, caseId, meta);
      return ok({ status: 'closed' });
    }
    const c = await respondToInvitation({ id: user.id, email: user.email }, caseId, body.action === 'accept', meta);
    return ok({ status: c.status });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});

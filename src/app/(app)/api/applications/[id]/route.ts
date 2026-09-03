import { requireTenant } from '@/lib/tenancy/request';
import { statusBodySchema } from '@/lib/applications/schemas';
import { folderRoute } from '@/lib/applications/route';
import { flushAudit, folderActor, transitionApplication } from '@/lib/applications/service';
import type { ApplicationStatus } from '@/lib/types';
import { fail, ok } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/applications/:id — the applicant records what happened
 * (interviewing, offer, not selected, withdrawn) and keeps the legacy summary
 * note. Stage 10: the move goes through the status machine — refused with a
 * reason when it is not an honest move — and writes a history row and an
 * audit row in the same transaction.
 */
export const PATCH = folderRoute(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const actor = folderActor(user);
  const { id } = await params;
  const body = statusBodySchema.parse(await request.json());

  const application = await run(async (tx) => {
    const existing = await tx.application.findFirst({ where: { id, userId: user.id } });
    if (!existing) return null;
    let current = existing;
    if (body.status) {
      current = await transitionApplication(tx, actor, id, body.status as ApplicationStatus, { actor: 'applicant', source: 'ui', reason: body.reason ?? null, rejectionReason: body.rejectionReason ?? null });
    }
    if (body.notes !== undefined) current = await tx.application.update({ where: { id }, data: { notes: body.notes, lastActivityAt: new Date() } });
    return current;
  });
  if (!application) return fail('Application not found.', 404);
  await flushAudit(actor);
  return ok({ application });
});

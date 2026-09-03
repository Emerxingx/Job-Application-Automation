import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';

const schema = z.object({
  status: z
    .enum(['submitted', 'interviewing', 'offer', 'rejected', 'withdrawn'])
    .optional(),
  notes: z.string().max(5000).optional(),
});

type Params = { params: Promise<{ id: string }> };

/** Update the outcome of an application as the applicant hears back. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  const body = schema.parse(await request.json());

  const application = await run(async (tx) => {
    const existing = await tx.application.findFirst({ where: { id, userId: user.id } });
    if (!existing) return null;
    return tx.application.update({
      where: { id },
      data: {
        ...body,
        // Stamp the response date the first time the status moves past submitted.
        respondedAt:
          body.status && body.status !== 'submitted' && !existing.respondedAt
            ? new Date()
            : existing.respondedAt,
      },
    });
  });
  if (!application) return fail('Application not found.', 404);

  return ok({ application });
});

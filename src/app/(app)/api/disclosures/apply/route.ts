import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { requestMeta } from '@/lib/security-audit';
import { employerFail } from '@/lib/employer/request';
import { applyThroughPlatform } from '@/lib/employer/service';

const schema = z.object({ jobId: z.string().min(1) });

/** POST /api/disclosures/apply - the candidate applies to an employer's posting ON this platform: their own act grants disclosure to that employer and enters its pipeline at `consented`. Nothing is sent anywhere else. */
export const POST = route(async (request: Request) => {
  const user = await requireUser();
  const body = schema.parse(await request.json());
  try {
    const s = await applyThroughPlatform({ id: user.id, email: user.email }, body.jobId, requestMeta(request));
    return ok({ submission: { id: s.id, stage: s.stage } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});

import { destroySession } from '@/lib/auth';
import { ok, route } from '@/lib/api';
import { requestMeta } from '@/lib/security-audit';

export const POST = route(async (request: Request) => {
  await destroySession(requestMeta(request));
  return ok({ ok: true });
});

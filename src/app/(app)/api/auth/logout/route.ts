import { destroySession } from '@/lib/auth';
import { ok, route } from '@/lib/api';

export const POST = route(async () => {
  await destroySession();
  return ok({ ok: true });
});

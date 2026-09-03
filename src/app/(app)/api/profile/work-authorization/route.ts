import { requireTenant } from '@/lib/tenancy/request';
import { ok, route } from '@/lib/api';
import { loadWorkAuthorization, saveWorkAuthorization, workAuthorizationSchema } from '@/lib/candidate/preferences';

/**
 * Work authorisation is CONFIDENTIAL and operationally relevant to eligibility
 * (ADR-0007: not sensitive-segregated, but access-controlled). It is read and
 * written on the tenant path, own row only.
 */
export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const workAuthorization = await run((tx) => loadWorkAuthorization(tx, user.id));
  return ok({ workAuthorization });
});

export const PUT = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = workAuthorizationSchema.parse(await request.json());
  const workAuthorization = await run((tx) => saveWorkAuthorization(tx, user.id, body));
  return ok({ workAuthorization });
});

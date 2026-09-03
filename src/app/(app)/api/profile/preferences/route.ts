import { requireTenant } from '@/lib/tenancy/request';
import { ok, route } from '@/lib/api';
import { loadPreferences, preferencesSchema, savePreferences } from '@/lib/candidate/preferences';

export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const preferences = await run((tx) => loadPreferences(tx, user.id));
  return ok({ preferences });
});

export const PUT = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = preferencesSchema.parse(await request.json());
  const preferences = await run((tx) => savePreferences(tx, user.id, body));
  return ok({ preferences });
});

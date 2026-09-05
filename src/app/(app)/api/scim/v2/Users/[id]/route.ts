import { scimBaseUrl, scimJson, scimRoute } from '@/lib/scim/route';
import { getScimUser, parsePatch, renameScimUser, setScimUserActive } from '@/lib/scim/service';
import { requestMeta } from '@/lib/security-audit';

type Ctx = { params: Promise<{ id: string }> };

export const GET = scimRoute(async (principal, request, { params }: Ctx) => {
  const { id } = await params;
  return scimJson(await getScimUser(principal, id, scimBaseUrl(request)));
});

/** PATCH - `replace`/`add` on `active` (deactivate = remove the membership and revoke sessions; never delete the account) and `name.formatted`. */
export const PATCH = scimRoute(async (principal, request, { params }: Ctx) => {
  const { id } = await params;
  const patch = parsePatch((await request.json()) as { schemas?: unknown; Operations?: unknown });
  if (patch.formatted !== undefined) await renameScimUser(principal, id, patch.formatted);
  const user = patch.active !== undefined ? await setScimUserActive(principal, id, patch.active, scimBaseUrl(request), requestMeta(request)) : await getScimUser(principal, id, scimBaseUrl(request));
  return scimJson(user);
});

/** PUT - the same two attributes, full-replace semantics for them; everything else on the resource is the platform's. */
export const PUT = scimRoute(async (principal, request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await request.json()) as { active?: unknown; name?: unknown };
  const name = body.name && typeof body.name === 'object' ? (body.name as Record<string, unknown>) : null;
  if (name && typeof name.formatted === 'string') await renameScimUser(principal, id, name.formatted);
  const user = typeof body.active === 'boolean' ? await setScimUserActive(principal, id, body.active, scimBaseUrl(request), requestMeta(request)) : await getScimUser(principal, id, scimBaseUrl(request));
  return scimJson(user);
});

/** DELETE - deprovision: the membership is removed and sessions revoked; the account and the person's own data remain (erasure is the person's request). */
export const DELETE = scimRoute(async (principal, request, { params }: Ctx) => {
  const { id } = await params;
  await setScimUserActive(principal, id, false, scimBaseUrl(request), requestMeta(request));
  return new Response(null, { status: 204 });
});

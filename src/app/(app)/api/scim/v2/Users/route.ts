import { scimBaseUrl, scimJson, scimRoute } from '@/lib/scim/route';
import { createScimUser, listScimUsers } from '@/lib/scim/service';
import { requestMeta } from '@/lib/security-audit';

/** GET /api/scim/v2/Users?filter=userName eq "x"&startIndex=&count= - the token's organisation's memberships as SCIM users (Stage 20, ADR-0035). */
export const GET = scimRoute(async (principal, request) => {
  const q = new URL(request.url).searchParams;
  const list = await listScimUsers(principal, { filter: q.get('filter'), startIndex: Number(q.get('startIndex') ?? 1) || 1, count: Number(q.get('count') ?? 100) || 100 }, scimBaseUrl(request));
  return scimJson(list);
});

/** POST /api/scim/v2/Users - provision an account (if none) and an accepted membership, under the organisation's provisioning domains. */
export const POST = scimRoute(async (principal, request) => {
  const body = (await request.json()) as Record<string, unknown>;
  const user = await createScimUser(principal, body, scimBaseUrl(request), requestMeta(request));
  return scimJson(user, 201);
});

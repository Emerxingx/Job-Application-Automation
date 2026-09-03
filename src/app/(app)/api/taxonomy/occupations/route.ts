import { requireTenant } from '@/lib/tenancy/request';
import { ok, route } from '@/lib/api';
import { searchOccupations } from '@/lib/taxonomy/queries';

/**
 * GET /api/taxonomy/occupations?q=&locale=&limit= — search the occupational
 * spine. Reference data on the tenant path (SELECT-only for every tenant).
 */
export const GET = route(async (request: Request) => {
  const { run } = await requireTenant();
  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';
  const locale = params.get('locale') ?? undefined;
  const limit = Number(params.get('limit') ?? '20') || 20;
  const occupations = await run((tx) => searchOccupations(tx, q, { locale, limit }));
  return ok({ occupations });
});

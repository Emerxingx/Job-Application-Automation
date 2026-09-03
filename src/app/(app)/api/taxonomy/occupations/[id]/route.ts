import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { crosswalk, getOccupation } from '@/lib/taxonomy/queries';

/** GET /api/taxonomy/occupations/:id — one occupation with its labels, codes and the SOC crosswalk. */
export const GET = route(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { run } = await requireTenant();
  const { id } = await params;
  const result = await run(async (tx) => {
    const occupation = await getOccupation(tx, id);
    if (!occupation) return null;
    const noc = occupation.codes.find((c) => c.scheme === 'NOC2021');
    const soc = noc ? await crosswalk(tx, { scheme: 'NOC2021', code: noc.code }, 'SOC2018') : [];
    return { occupation, soc };
  });
  if (!result) return fail('Occupation not found.', 404);
  return ok(result);
});

import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { runAgentScan, runAllScans } from '@/lib/services/scanner';
import { ok, route } from '@/lib/api';

const schema = z.object({ agentId: z.string().optional() });

/**
 * Run a live scan. With an agentId, runs that agent; without one, runs every
 * active agent the user has.
 */
export const POST = route(async (request: Request) => {
  const user = await requireUser();

  const raw = await request.text();
  const body = schema.parse(raw ? JSON.parse(raw) : {});

  // A single-agent scan lets errors propagate to the caller; a run-all
  // collects per-agent failures so one broken agent doesn't hide the rest.
  const run = body.agentId
    ? { results: [await runAgentScan(user.id, body.agentId)], errors: [] }
    : await runAllScans(user.id);

  const { results, errors } = run;

  const totals = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      newMatches: acc.newMatches + r.newMatches,
      aboveThreshold: acc.aboveThreshold + r.aboveThreshold,
    }),
    { scanned: 0, newMatches: 0, aboveThreshold: 0 },
  );

  return ok({ results, totals, errors });
});

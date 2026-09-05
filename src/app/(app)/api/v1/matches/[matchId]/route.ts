import { loadMatchAnalysis } from '@/lib/integrations/candidate-api';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/matches/{matchId} - why a posting scored what it did: the dimensions with cited evidence ids (contract: MatchAnalysis). */
export const GET = v1Route('read', async (context) => {
  const analysis = await loadMatchAnalysis(context.key.userId, context.params.matchId ?? '');
  if (!analysis) throw notFound('No such match.');
  return v1Ok(context, analysis);
});

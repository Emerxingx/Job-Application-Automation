import { loadApplicationDetail } from '@/lib/integrations/candidate-api';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/applications/{applicationId} - the whole folder as the tracker shows it (contract: ApplicationDetail). Ids, kinds, dates and hashes; never a note body or a document's bytes. */
export const GET = v1Route('read', async (context) => {
  const application = await loadApplicationDetail(context.key.userId, context.params.applicationId ?? '');
  if (!application) throw notFound('No such application.');
  return v1Ok(context, application);
});

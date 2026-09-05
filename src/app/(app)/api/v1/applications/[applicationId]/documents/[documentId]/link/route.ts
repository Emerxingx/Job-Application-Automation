import { createDocumentLink } from '@/lib/integrations/candidate-api';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/**
 * POST /api/v1/applications/{applicationId}/documents/{documentId}/link (v1.1) -
 * a ten-minute signed link to one document version in the caller's folder.
 * The link, not this API, serves the bytes (Stage 09) (contract: DocumentLink).
 */
export const POST = v1Route('read', async (context) => {
  const link = await createDocumentLink(context.key.userId, context.params.applicationId ?? '', context.params.documentId ?? '', context.url.origin);
  if (!link) throw notFound('No such document.');
  return v1Ok(context, link, 201);
});

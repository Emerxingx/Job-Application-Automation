import { db } from '@/lib/db';
import { verifyDocumentLink } from '@/lib/documents/sign';
import { CONTENT_TYPES, DocumentIntegrityError, documentFileName, readDocumentBytes, type DocumentFormat } from '@/lib/documents/versions';
import { fail, route } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/documents/:id/download?u=&exp=&sig= — serves the bytes of one
 * document version to the holder of a valid, unexpired signed link. No
 * session: the signature IS the authorisation, and it binds the owner's id,
 * so the row lookup still filters by that owner (system client — there is
 * no session to open a tenant transaction with). The bytes are verified
 * against the stored hash before they leave; a mismatch is refused and
 * logged, never served.
 */
export const GET = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const q = new URL(request.url).searchParams;
  const link = { documentId: id, userId: q.get('u') ?? '', expiresAt: Number(q.get('exp')), signature: q.get('sig') ?? '' };
  const verdict = verifyDocumentLink(link);
  if (verdict === 'invalid') return fail('This link is not valid.', 403);
  if (verdict === 'expired') return fail('This link has expired. Open the document again for a new one.', 410);

  const row = await db.documentVersion.findFirst({
    where: { id, userId: link.userId },
    include: { application: { select: { job: { select: { company: true } } } } },
  });
  if (!row) return fail('Document not found.', 404);

  let bytes: Buffer;
  try {
    bytes = await readDocumentBytes(row);
  } catch (error) {
    if (error instanceof DocumentIntegrityError) {
      // A stored object that is missing or altered is a serious signal; the
      // id is logged (never the content) and the download is refused.
      console.error(`[documents] integrity check failed for ${error.documentId}: ${error.message}`);
      return fail('The stored document failed its integrity check and was not served.', 409);
    }
    throw error;
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': CONTENT_TYPES[row.format as DocumentFormat] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${documentFileName(row, { company: row.application?.job.company })}"`,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

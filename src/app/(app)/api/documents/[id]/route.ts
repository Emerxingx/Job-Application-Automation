import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/tenancy/request';
import { documentLinkPath, signDocumentLink } from '@/lib/documents/sign';
import { fail, ok, route } from '@/lib/api';
import { assertNotImpersonating } from '@/lib/auth';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/documents/:id — the signed-in owner's way to a document. The row
 * is read on the tenant path (RLS plus the owner filter); the response is a
 * redirect to a signed, expiring link (`?link=1` returns the link as JSON
 * instead, for "copy link"). No bytes are served from here: every download
 * goes through the signed route, so there is exactly one path to a file.
 */
export const GET = route(async (request: Request, { params }: Params) => {
  // A document's bytes are the person's (Stage 20 review, H3): no signed link is minted under a support impersonation.
  await assertNotImpersonating('a document');
  const { user, run } = await requireTenant();
  const { id } = await params;
  const row = await run((tx) => tx.documentVersion.findFirst({ where: { id, userId: user.id }, select: { id: true } }));
  if (!row) return fail('Document not found.', 404);
  const link = signDocumentLink(row.id, user.id);
  const path = documentLinkPath(link);
  if (new URL(request.url).searchParams.get('link') === '1') {
    return ok({ url: path, expiresAt: new Date(link.expiresAt * 1000).toISOString() });
  }
  return NextResponse.redirect(new URL(path, request.url), 302);
});

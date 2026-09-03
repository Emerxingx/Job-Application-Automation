import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/tenancy/request';
import { scanUpload, UPLOAD_MAX_BYTES } from '@/lib/documents/scan';
import { recordDocumentVersion } from '@/lib/documents/versions';
import { fail, ok, route } from '@/lib/api';

/**
 * POST /api/documents/upload (multipart, field `file`) — store an uploaded
 * résumé as a versioned document AFTER the server-side scan. A refused file
 * is answered with the scan's reason codes and is never stored. The bytes
 * are kept as uploaded (hashed); nothing is parsed from them here.
 */
export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return fail('Attach a file.', 422);
  if (file.size > UPLOAD_MAX_BYTES) return fail('The file is larger than 5 MB.', 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  const scan = await scanUpload(bytes, file.name);
  if (!scan.ok || !scan.format) {
    return NextResponse.json({ error: 'The file was refused by the upload scan.', reasons: scan.reasons }, { status: 422 });
  }
  const row = await run((tx) => recordDocumentVersion(tx, { userId: user.id, kind: 'uploaded_resume', format: scan.format!, bytes, scanReport: scan }));
  return ok({ document: { id: row.id, kind: row.kind, format: row.format, version: row.version, sizeBytes: row.sizeBytes, contentHash: row.contentHash, createdAt: row.createdAt.toISOString() }, scan });
});

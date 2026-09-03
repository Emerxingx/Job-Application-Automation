import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { grantConsent, hasCurrentConsent } from '@/lib/consent';
import { beginConnection, consentPurposeFor } from '@/lib/mailbox/service';
import { callbackUri, mailboxRoute } from '@/lib/mailbox/route';
import { requestMeta } from '@/lib/security-audit';
import { fail, ok } from '@/lib/api';

const schema = z.object({
  provider: z.enum(['google', 'microsoft']),
  kind: z.enum(['mail', 'calendar']),
  /** The explicit, per-connection consent checkbox. Refused without it. */
  consent: z.literal(true, { errorMap: () => ({ message: 'Tick the consent box to connect.' }) }),
});

/**
 * POST /api/mailbox/connect — record the consent for this kind (versioned,
 * audited) and start the OAuth flow with metadata scopes only. Returns the
 * provider URL to send the browser to.
 */
export const POST = mailboxRoute(async (request: Request) => {
  const user = await requireUser();
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid request.', 422);
  const { provider, kind } = parsed.data;
  const purpose = consentPurposeFor(kind);
  if (!(await hasCurrentConsent(db, user.id, purpose))) await grantConsent(db, user, purpose, { source: 'mailbox_connect', meta: requestMeta(request) });
  const { url } = await beginConnection(user, provider, kind, callbackUri(request));
  return ok({ url });
});

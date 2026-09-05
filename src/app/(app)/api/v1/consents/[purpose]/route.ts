import { z } from 'zod';
import { isConsentPurpose } from '@/lib/consent';
import { setConsent } from '@/lib/integrations/candidate-api';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';
import { requestMeta } from '@/lib/security-audit';

const schema = z.object({ granted: z.boolean() }).strict();

/**
 * PUT /api/v1/consents/{purpose} (v1.1) - grant or withdraw one purpose. A
 * required purpose cannot be withdrawn here and an unavailable one cannot be
 * granted; both are 409 with the reason (contract: ConsentUpdate -> Consent).
 */
export const PUT = v1Route('write', async (context) => {
  const purpose = context.params.purpose ?? '';
  if (!isConsentPurpose(purpose)) throw notFound('No such consent purpose.');
  const body = schema.parse(await context.request.json());
  return v1Ok(context, await setConsent(context.key.userId, purpose, body.granted, requestMeta(context.request)));
});

import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import { requestMeta } from '@/lib/security-audit';
import {
  DISABILITY_STATUS,
  ETHNICITY,
  GENDER,
  INDIGENOUS_STATUS,
  SELF_IDENTIFICATION_NOTICE_VERSION,
  VETERAN_STATUS,
  eraseSelfIdentification,
  isSelfIdentificationInput,
  readSelfIdentification,
  writeSelfIdentification,
} from '@/lib/sensitive/self-identification';

/**
 * The candidate's OWN voluntary self-identification (ADR-0007). This route is
 * the only HTTP surface onto the sensitive schema; it goes through the
 * sensitive role, never the tenant role, and every call is audited without
 * the values. It deliberately does not use requireTenant(): the tenant path
 * cannot reach this data, by design.
 */
export const GET = route(async (request: Request) => {
  const user = await requireUser();
  const current = await readSelfIdentification(user, { meta: requestMeta(request) });
  return ok({
    current,
    noticeVersion: SELF_IDENTIFICATION_NOTICE_VERSION,
    options: { gender: GENDER, ethnicity: ETHNICITY, indigenousStatus: INDIGENOUS_STATUS, veteranStatus: VETERAN_STATUS, disabilityStatus: DISABILITY_STATUS },
  });
});

export const PUT = route(async (request: Request) => {
  const user = await requireUser();
  const body: unknown = await request.json();
  if (!isSelfIdentificationInput(body)) {
    return fail('Each answer must be one of the offered options, including "prefer not to say".', 422);
  }
  const saved = await writeSelfIdentification(user, body, { meta: requestMeta(request) });
  return ok({ current: saved });
});

export const DELETE = route(async (request: Request) => {
  const user = await requireUser();
  await eraseSelfIdentification(user, { meta: requestMeta(request) });
  return ok({ ok: true });
});

import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { BUILTIN_FIELD_MAPPINGS, BUILTIN_FIELD_MAPPING_VERSION, createFieldMappingVersion, getActiveFieldMappings, listFieldMappingVersions } from '@/lib/apply/field-mappings';
import { requestMeta } from '@/lib/security-audit';

/** GET /api/console/field-mappings — every register version, the active one, and the built-in set. Admin only. */
export const GET = governanceRoute(async () => {
  await requireStaff('admin');
  const [versions, active] = await Promise.all([listFieldMappingVersions(), getActiveFieldMappings()]);
  return ok({ versions, active, builtin: { version: BUILTIN_FIELD_MAPPING_VERSION, mappings: BUILTIN_FIELD_MAPPINGS } });
});

const createSchema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change the field mappings.'),
  reason: z.string().trim().max(500).optional(),
  // Validated in depth by validateMappings — the shape is the register's, not zod's.
  mappings: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
  notes: z.string().max(4000).optional(),
});

/** POST /api/console/field-mappings — a new DRAFT version. Admin + step-up. */
export const POST = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = createSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const version = await createFieldMappingVersion({ mappings: body.mappings, notes: body.notes }, staff, body.reason ?? null);
  return ok({ version }, { status: 201 });
});

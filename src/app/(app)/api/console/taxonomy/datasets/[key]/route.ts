import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { TaxonomyLicenceError, recordDatasetLicence } from '@/lib/taxonomy/datasets';

const schema = z.object({
  status: z.enum(['recorded', 'prohibited']),
  licenceName: z.string().trim().max(200).default(''),
  licenceUrl: z.string().trim().max(500).optional(),
  attribution: z.string().trim().max(1000).default(''),
  ingestionApproved: z.boolean().default(false),
  notes: z.string().max(4000).optional(),
  reason: z.string().trim().min(1, 'Name the review or the counsel advice this records.').max(500),
});

/**
 * PATCH /api/console/taxonomy/datasets/:key — record a dataset's licence
 * (or counsel's prohibition) and whether ingestion is approved. Admin-only
 * and audited: this is the L-2 gate being opened or closed, by a person.
 */
export const PATCH = consoleRoute(async (request: Request, { params }: { params: Promise<{ key: string }> }) => {
  const staff = await requireStaff('admin');
  const { key } = await params;
  const body = schema.parse(await request.json());
  try {
    const dataset = await recordDatasetLicence(key, body, staff, body.reason);
    return ok({ dataset });
  } catch (error) {
    if (error instanceof TaxonomyLicenceError) return fail(error.message, error.status);
    throw error;
  }
});

import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { organizationIdOf, staffingFail, staffingRequest } from '@/lib/staffing/request';
import { FEE_KINDS, createFeeStructure, listFeeStructures } from '@/lib/staffing/service';

/** GET /api/staffing/fees?organizationId= - fee structures (admin, recruiter, finance). */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await staffingRequest(request, organizationIdOf(request));
    const rows = await tenant.run((tx) => listFeeStructures(tx, actor));
    return ok({ fees: rows.map((f) => ({ id: f.id, name: f.name, kind: f.kind, percentBps: f.percentBps, flatCents: f.flatCents, currency: f.currency, guaranteeDays: f.guaranteeDays, paidBy: f.paidBy, contractId: f.contractId })) });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({ organizationId: z.string().min(1), name: z.string().trim().min(2).max(120), kind: z.enum(FEE_KINDS), percentBps: z.number().int().nullable().optional(), flatCents: z.number().int().nullable().optional(), currency: z.enum(['CAD', 'USD']).optional(), guaranteeDays: z.number().int().optional(), contractId: z.string().min(1).nullable().optional(), paidBy: z.string().optional() });

/** POST /api/staffing/fees - an administrator defines what the CLIENT pays; any other payer is refused. */
export const POST = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const f = await tenant.run((tx) => createFeeStructure(tx, actor, body));
    return ok({ fee: { id: f.id } }, { status: 201 });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});

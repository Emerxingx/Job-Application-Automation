import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { personalOrganizationId } from '../tenancy/organizations';
import { resolveAiProcessingPolicy, type AiProcessingPolicy } from '../tenancy/roles';

/**
 * Per-tenant AI processing policy resolution (ADR-0015, ADR-0006).
 *
 * Resolved BEFORE dispatch, from the organisation the request acts within —
 * today the candidate's personal workspace; an organisation id may be passed
 * for Stage 17+ flows. Anything that cannot be read, is missing, or carries a
 * value this code does not recognise resolves to EXTERNAL_AI_PROHIBITED. That
 * is the whole point: a tenant nobody configured must not have its data sent
 * across a border because a lookup failed.
 */
export interface ResolvedAiPolicy {
  organizationId: string | null;
  policy: AiProcessingPolicy;
  /** Why the value is what it is — recorded on the AiRun for auditability. */
  basis: 'organization' | 'missing_organization' | 'lookup_failed' | 'no_tenant';
}

type Client = Prisma.TransactionClient | typeof db;

export async function resolveAiPolicy(
  input: { userId?: string | null; organizationId?: string | null },
  client: Client = db,
): Promise<ResolvedAiPolicy> {
  const organizationId = input.organizationId ?? (input.userId ? personalOrganizationId(input.userId) : null);
  if (!organizationId) return { organizationId: null, policy: 'EXTERNAL_AI_PROHIBITED', basis: 'no_tenant' };
  try {
    const org = await client.organization.findUnique({ where: { id: organizationId }, select: { aiProcessingPolicy: true } });
    if (!org) return { organizationId, policy: 'EXTERNAL_AI_PROHIBITED', basis: 'missing_organization' };
    return { organizationId, policy: resolveAiProcessingPolicy(org.aiProcessingPolicy), basis: 'organization' };
  } catch {
    return { organizationId, policy: 'EXTERNAL_AI_PROHIBITED', basis: 'lookup_failed' };
  }
}

/**
 * Whether a task may leave the permitted processing boundary under a policy.
 * `EXTERNAL_AI_RESTRICTED` permits external processing only for named tasks;
 * nothing is named yet, so it behaves as PROHIBITED until L-3 is resolved and a
 * task is explicitly listed here with its data category.
 */
export const RESTRICTED_PERMITTED_TASKS: ReadonlySet<string> = new Set<string>();

export function externalAllowed(policy: AiProcessingPolicy, task: string): boolean {
  if (policy === 'EXTERNAL_AI_ALLOWED') return true;
  if (policy === 'EXTERNAL_AI_RESTRICTED') return RESTRICTED_PERMITTED_TASKS.has(task);
  return false;
}

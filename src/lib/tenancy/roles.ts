/**
 * Organisation roles — the RBAC half of ADR-0005, kept in code (ADR-0019: the
 * security implementation is not runtime configuration).
 *
 * Three roles, one linear ladder, for the same reason the staff console has
 * one (src/lib/crm/auth.ts): a lattice cannot be checked with a single
 * comparison, and every extra branch is somewhere a check gets forgotten.
 * The per-organisation-type role names in MULTITENANCY_ARCHITECTURE.md
 * (hiring_manager, case_manager, …) are Stage 17–19 concerns and will be
 * introduced as named permission sets over this ladder, not as more rungs.
 */

export const ORGANIZATION_ROLES = ['member', 'admin', 'owner'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ROLE_RANK: Record<OrganizationRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === 'string' && (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

/**
 * Whether `actual` satisfies a requirement of `required`. An unrecognised
 * stored role — a value written by a future migration this code has not
 * caught up with — satisfies NOTHING, not even `member`. Failing closed on
 * the unknown is the property that matters.
 */
export function meetsRole(actual: string | null | undefined, required: OrganizationRole): boolean {
  if (!isOrganizationRole(actual)) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export const ORGANIZATION_TYPES = [
  'personal',
  'employer',
  'staffing_agency',
  'service_provider',
  'career_consultancy',
  'training_organization',
  'platform',
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export function isOrganizationType(value: unknown): value is OrganizationType {
  return typeof value === 'string' && (ORGANIZATION_TYPES as readonly string[]).includes(value);
}

/**
 * Per-tenant AI processing policy states (ADR-0015). The order is from most
 * to least restrictive; `EXTERNAL_AI_PROHIBITED` is the schema default and
 * the state an unreadable or unrecognised value collapses to.
 */
export const AI_PROCESSING_POLICIES = [
  'EXTERNAL_AI_PROHIBITED',
  'EXTERNAL_AI_RESTRICTED',
  'EXTERNAL_AI_ALLOWED',
] as const;
export type AiProcessingPolicy = (typeof AI_PROCESSING_POLICIES)[number];

export function resolveAiProcessingPolicy(value: unknown): AiProcessingPolicy {
  return typeof value === 'string' && (AI_PROCESSING_POLICIES as readonly string[]).includes(value)
    ? (value as AiProcessingPolicy)
    : 'EXTERNAL_AI_PROHIBITED';
}

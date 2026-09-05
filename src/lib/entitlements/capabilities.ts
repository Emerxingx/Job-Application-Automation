/**
 * Stage 15 (ADR-0010, ADR-0030) - the capability registry: every question a
 * feature may ask of an account, with its kind and its free-tier baseline.
 *
 * The keys are the vocabulary of `Entitlement.capability`; the plan mapping
 * below is what a plan GRANTS when it activates (`syncPlanEntitlements`),
 * derived from the plan row's own columns where the row has one
 * (`applicationsPerMonth`, `maxAgents`) and from `docs/product/ENTITLEMENT_MATRIX.md`
 * for the rest. The matrix's B2C quantities (30 / 100 / 300 applications)
 * differ from the seeded plans (25 / 120 / 400); the plan ROW wins, because
 * that is what the customer was shown and charged for - reconciling the two
 * is a product decision recorded in the Stage 15 evidence, not a silent edit.
 *
 * Pure: no database, no React. Tested in tests/entitlements.test.ts.
 */

export type CapabilityKind = 'boolean' | 'quantity';

/** A quantity that means "no ceiling" - large enough that no window reaches it, small enough for an Int column. */
export const UNLIMITED = 1_000_000;

export interface CapabilityDefinition {
  kind: CapabilityKind;
  /** What every account has with no entitlement row at all (the matrix's Free column). */
  free: number | boolean;
  /** For a quantity: the unit, for messages. */
  unit?: string;
  description: string;
}

export const CAPABILITIES = {
  applications_per_month: { kind: 'quantity', free: 5, unit: 'applications per month', description: 'Applications JobPilot may prepare in a monthly window (unused quota is refunded).' },
  agents: { kind: 'quantity', free: 1, unit: 'job agents', description: 'Concurrent job-search agents.' },
  documents_per_month: { kind: 'quantity', free: 3, unit: 'tailored documents per month', description: 'Tailored résumés and cover letters per month.' },
  document_history_days: { kind: 'quantity', free: 0, unit: 'days', description: 'How far back document versions stay browsable.' },
  interview_prep_per_month: { kind: 'quantity', free: 0, unit: 'sessions per month', description: 'Interview preparation sessions.' },
  career_transition_per_month: { kind: 'quantity', free: 0, unit: 'analyses per month', description: 'Career transition analyses (Stage 16).' },
  recommendations_full: { kind: 'boolean', free: false, description: 'Unlimited recommendations rather than a limited feed.' },
  match_explanation_full: { kind: 'boolean', free: false, description: 'The full compatibility explanation rather than a summary.' },
  docx_export: { kind: 'boolean', free: false, description: 'DOCX export of documents.' },
  mailbox_intelligence: { kind: 'boolean', free: false, description: 'Email and calendar intelligence (Stage 11).' },
  analytics_full: { kind: 'boolean', free: false, description: 'Full candidate analytics rather than the basic view.' },
  learning_recommendations: { kind: 'boolean', free: false, description: 'Learning recommendations (Stage 16).' },
  priority_support: { kind: 'boolean', free: false, description: 'Priority support.' },
  api_access: { kind: 'boolean', free: false, description: 'Integration API keys (B2B).' },
} as const satisfies Record<string, CapabilityDefinition>;

export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as Capability[];

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && value in CAPABILITIES;
}

/** `cap` is the one source that LOWERS: a ceiling staff set on a capability (a quantity, or `false` for a boolean), applied after every grant (Stage 15 review). */
export const ENTITLEMENT_SOURCES = ['plan', 'trial', 'comp', 'pilot', 'licence', 'bonus', 'staff', 'cap'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export const REVOKE_REASONS = ['plan_changed', 'canceled', 'payment_lapsed', 'trial_ended', 'staff', 'expired'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** What a plan row must expose for the mapping. */
export interface PlanShape {
  code: string;
  applicationsPerMonth: number;
  maxAgents: number;
}

export type Grant = { capability: Capability; quantity?: number };

/** The matrix's B2C columns beyond the two quantities the plan row carries. Unknown codes get the row-derived pair only. */
const PLAN_FEATURES: Record<string, Grant[]> = {
  starter: [
    { capability: 'documents_per_month', quantity: UNLIMITED },
    { capability: 'document_history_days', quantity: 90 },
    { capability: 'interview_prep_per_month', quantity: 3 },
    { capability: 'recommendations_full' },
    { capability: 'match_explanation_full' },
    { capability: 'docx_export' },
    { capability: 'analytics_full' },
  ],
  professional: [
    { capability: 'documents_per_month', quantity: UNLIMITED },
    { capability: 'document_history_days', quantity: UNLIMITED },
    { capability: 'interview_prep_per_month', quantity: UNLIMITED },
    { capability: 'career_transition_per_month', quantity: 1 },
    { capability: 'recommendations_full' },
    { capability: 'match_explanation_full' },
    { capability: 'docx_export' },
    { capability: 'mailbox_intelligence' },
    { capability: 'analytics_full' },
    { capability: 'learning_recommendations' },
  ],
  executive: [
    { capability: 'documents_per_month', quantity: UNLIMITED },
    { capability: 'document_history_days', quantity: UNLIMITED },
    { capability: 'interview_prep_per_month', quantity: UNLIMITED },
    { capability: 'career_transition_per_month', quantity: UNLIMITED },
    { capability: 'recommendations_full' },
    { capability: 'match_explanation_full' },
    { capability: 'docx_export' },
    { capability: 'mailbox_intelligence' },
    { capability: 'analytics_full' },
    { capability: 'learning_recommendations' },
    { capability: 'priority_support' },
  ],
};

/** The matrix column a plan code belongs to: `starter`, `starter-2026`, `starter_ca` are all the starter column. */
export function planFamily(code: string): string {
  return code.toLowerCase().split(/[-_:.]/)[0] ?? code;
}

/** Everything activating `plan` grants. Deterministic; the same plan always yields the same set. */
export function grantsForPlan(plan: PlanShape): Grant[] {
  const grants: Grant[] = [
    { capability: 'applications_per_month', quantity: Math.max(0, plan.applicationsPerMonth) },
    { capability: 'agents', quantity: Math.max(1, plan.maxAgents) },
    ...(PLAN_FEATURES[planFamily(plan.code)] ?? []),
  ];
  // One row per capability: a duplicated key in PLAN_FEATURES would be a bug, not a bonus.
  const seen = new Set<Capability>();
  for (const g of grants) {
    if (seen.has(g.capability)) throw new Error(`plan ${plan.code} grants ${g.capability} twice`);
    seen.add(g.capability);
    if (CAPABILITIES[g.capability].kind === 'quantity' && g.quantity === undefined) throw new Error(`${g.capability} needs a quantity`);
    if (CAPABILITIES[g.capability].kind === 'boolean' && g.quantity !== undefined) throw new Error(`${g.capability} is boolean`);
  }
  return grants;
}

export type EntitlementValue = number | boolean;

export interface ResolvedCapability {
  value: EntitlementValue;
  /** Where the winning value came from; `free` when no row applies. */
  source: EntitlementSource | 'free';
  /** Row ids that contributed (all active rows for the capability). */
  rowIds: string[];
}

export type EntitlementSet = Record<Capability, ResolvedCapability>;

export interface ActiveRow {
  id: string;
  capability: string;
  kind: string;
  quantity: number | null;
  source: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Merge the active rows into one answer per capability: grants combine by
 * MAX (a comp on top of a plan never lowers what the plan gave; a boolean is
 * true if any grant says so), nothing → the free baseline, and then a CAP
 * row, if any, lowers the answer to its ceiling (the lowest cap wins; a
 * boolean cap is a block). A cap is the only way below a plan's grant or
 * the baseline, and only staff write one. Pure, so the rule is testable
 * without a database.
 */
export function resolveEntitlements(rows: readonly ActiveRow[], now: Date = new Date()): EntitlementSet {
  const set = {} as EntitlementSet;
  for (const key of CAPABILITY_KEYS) {
    const def = CAPABILITIES[key];
    const live = rows.filter((r) => r.capability === key && r.revokedAt === null && (r.expiresAt === null || r.expiresAt > now));
    const caps = live.filter((r) => r.source === 'cap');
    const active = live.filter((r) => r.source !== 'cap');
    let resolved: ResolvedCapability;
    if (active.length === 0) {
      resolved = { value: def.free, source: 'free', rowIds: [] };
    } else if (def.kind === 'quantity') {
      let best = active[0]!;
      for (const r of active) if ((r.quantity ?? 0) > (best.quantity ?? 0)) best = r;
      const value = Math.max(typeof def.free === 'number' ? def.free : 0, best.quantity ?? 0);
      resolved = { value, source: value === (best.quantity ?? 0) ? (best.source as EntitlementSource) : 'free', rowIds: active.map((r) => r.id) };
    } else {
      resolved = { value: true, source: active[0]!.source as EntitlementSource, rowIds: active.map((r) => r.id) };
    }
    if (caps.length > 0) {
      if (def.kind === 'quantity') {
        const ceiling = Math.min(...caps.map((c) => c.quantity ?? 0));
        if (typeof resolved.value === 'number' && ceiling < resolved.value) resolved = { value: ceiling, source: 'cap', rowIds: [...resolved.rowIds, ...caps.map((c) => c.id)] };
      } else {
        resolved = { value: false, source: 'cap', rowIds: [...resolved.rowIds, ...caps.map((c) => c.id)] };
      }
    }
    set[key] = resolved;
  }
  return set;
}

export function quantityOf(set: EntitlementSet, capability: Capability): number {
  const v = set[capability].value;
  return typeof v === 'number' ? v : v ? 1 : 0;
}

export function allows(set: EntitlementSet, capability: Capability): boolean {
  const v = set[capability].value;
  return typeof v === 'boolean' ? v : v > 0;
}

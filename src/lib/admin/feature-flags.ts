import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import type { StaffContext } from '@/lib/crm/auth';
import { AdminError } from './organizations';

/**
 * Stage 20 (ADR-0035) - feature flags as a Tier-1 control (ADR-0019), with
 * the boundary that makes them safe to hand to a non-technical operator:
 *
 * THE CODE DECLARES WHAT IS FLAGGABLE. `FLAG_REGISTRY` names every flag a
 * reader in the codebase consults, with its default. The console can turn a
 * declared flag on or off, roll it out by percentage or allow-list accounts;
 * it cannot invent a flag, and no flag may name an authentication, session,
 * isolation, consent, apply-mode, residency, encryption or audit control -
 * `isTierTwoKey` refuses the key and a static test holds the registry to it.
 * A flag therefore narrows or reveals a product feature; it never widens a
 * security rule, because no security rule reads one.
 *
 * Evaluation is deterministic: the same account gets the same answer for the
 * same flag state (a hash of key + user id against the percentage), so a
 * rollout is a stable cohort, not a coin toss per request.
 */
export interface FlagDeclaration {
  description: string;
  /** What the flag means when no row exists. */
  defaultEnabled: boolean;
  /** Where in the code it is read. Documentation for the operator; a static test keeps it true. */
  readBy: string;
}

export const FLAG_REGISTRY = {
  'auth.sso_start_button': { description: 'Show "Sign in with your organisation" on the login page (enterprise SSO entry point).', defaultEnabled: true, readBy: 'src/app/(app)/(auth)/login/page.tsx' },
  'console.report_export': { description: 'Allow staff to export the audit log as CSV from /console/audit.', defaultEnabled: true, readBy: 'src/app/(app)/api/console/audit/export/route.ts' },
} as const satisfies Record<string, FlagDeclaration>;

export type FlagKey = keyof typeof FLAG_REGISTRY;

export function isFlagKey(value: unknown): value is FlagKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FLAG_REGISTRY, value);
}

/** Words a flag key may never carry: each names a Tier-2 control (ADR-0019). */
export const TIER_TWO_WORDS = /(^|[._-])(auth(entication|z)?|sessions?|rls|isolation|tenant|policy|consent|sensitive|apply[_-]?mode|auto[_-]?apply|residency|encrypt(ion)?|secret|audit([_-]?(log|integrity))?|permissions?|roles?|impersonat(e|ion)|step[_-]?up|mfa|password|tokens?|rate[_-]?limit|sso[._-]?(require|bypass)|scim[._-]?(auth|token))([._-]|$)/i;

export function isTierTwoKey(key: string): boolean {
  // The entry point flag names "auth." because that is where the button lives;
  // a key that names a control - require, bypass, session, token - is refused.
  if (key === 'auth.sso_start_button') return false;
  return TIER_TWO_WORDS.test(key);
}

export interface FlagRow {
  enabled: boolean;
  rolloutPercent: number;
  allowlist: string;
}

/** Pure evaluation of a row for an account (null = anonymous, who only sees 100% or nothing). */
export function evaluateFlag(row: FlagRow, key: string, userId: string | null): boolean {
  if (!row.enabled) return false;
  if (row.rolloutPercent >= 100) return true;
  if (!userId) return false;
  try {
    const allow = JSON.parse(row.allowlist);
    if (Array.isArray(allow) && allow.includes(userId)) return true;
  } catch {
    /* an unparseable allow-list allows nobody */
  }
  if (row.rolloutPercent <= 0) return false;
  const bucket = createHash('sha256').update(`${key}:${userId}`).digest().readUInt16BE(0) % 100;
  return bucket < row.rolloutPercent;
}

export async function isFlagEnabled(key: FlagKey, userId: string | null): Promise<boolean> {
  const row = await db.featureFlag.findUnique({ where: { key }, select: { enabled: true, rolloutPercent: true, allowlist: true } });
  if (!row) return FLAG_REGISTRY[key].defaultEnabled;
  return evaluateFlag(row, key, userId);
}

export async function listFeatureFlags() {
  const rows = await db.featureFlag.findMany({ where: { key: { in: Object.keys(FLAG_REGISTRY) } } });
  return (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => {
    const d = FLAG_REGISTRY[key];
    const row = rows.find((r) => r.key === key);
    return { key, description: d.description, readBy: d.readBy, defaultEnabled: d.defaultEnabled, stored: row ? { enabled: row.enabled, rolloutPercent: row.rolloutPercent, allowlist: JSON.parse(row.allowlist) as string[], updatedAt: row.updatedAt } : null };
  });
}

export interface FlagInput {
  enabled: boolean;
  rolloutPercent: number;
  allowlist: string[];
}

export async function setFeatureFlag(staff: StaffContext, key: string, input: FlagInput, reason: string, meta?: RequestMeta) {
  if (!isFlagKey(key)) throw new AdminError('That flag is not declared in code; a flag is declared where it is read (ADR-0019).', 422);
  if (isTierTwoKey(key)) throw new AdminError('That key names a security control; it is not a flag.', 422);
  if (!Number.isInteger(input.rolloutPercent) || input.rolloutPercent < 0 || input.rolloutPercent > 100) throw new AdminError('The rollout is a whole percentage between 0 and 100.', 422);
  if (input.allowlist.length > 500 || input.allowlist.some((id) => typeof id !== 'string' || !id.trim())) throw new AdminError('The allow-list is up to 500 account ids.', 422);
  if (!reason.trim()) throw new AdminError('A reason is required.', 422);
  const before = await db.featureFlag.findUnique({ where: { key } });
  const data = { enabled: input.enabled, rolloutPercent: input.rolloutPercent, allowlist: JSON.stringify([...new Set(input.allowlist.map((s) => s.trim()))]), description: FLAG_REGISTRY[key].description };
  const row = await db.featureFlag.upsert({ where: { key }, create: { key, ...data }, update: data });
  await recordSecurityEvent(
    { event: 'feature_flag.set', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'FeatureFlag', entityId: row.id, summary: `Feature flag ${key}: ${input.enabled ? 'on' : 'off'} at ${input.rolloutPercent}%`, detail: { key, enabledBefore: before?.enabled ?? null, enabled: input.enabled, rolloutBefore: before?.rolloutPercent ?? null, rollout: input.rolloutPercent, allowlistSize: input.allowlist.length }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return row;
}

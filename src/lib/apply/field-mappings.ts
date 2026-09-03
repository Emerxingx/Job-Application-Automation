import type { FieldMappingVersion, Prisma } from '@prisma/client';
import { db } from '../db';
import type { StaffContext } from '../crm/auth';
import { getCache } from '../cache';

/**
 * Stage 12 — the field-mapping register as governed, versioned data
 * (ADR-0019 Tier 1, ADR-0026), out of the content CMS.
 *
 * A mapping says which canonical key an employer form's free-text question
 * names ("Are you legally allowed to work in Canada?" → work_authorization)
 * so the same fact is answered the same way on every form. These rules
 * decide what is placed into an employer's form, so they are administered
 * with the PromptVersion discipline: draft → approved by a SECOND admin →
 * active (one at a time; activating an older version is the rollback,
 * recorded as one) → retired. Every application records the version it was
 * prepared with.
 *
 * Fail-closed default: until a version is active, the BUILT-IN mappings
 * apply and are recorded as `builtin:1`. Nothing is seeded active. A fallback
 * rule is a note to the applicant, never an instruction to invent a value.
 */
export const MAPPING_DATA_TYPES = ['boolean', 'numeric', 'text', 'select'] as const;
export type MappingDataType = (typeof MAPPING_DATA_TYPES)[number];

export interface MappingPattern {
  kind: 'contains' | 'regex';
  pattern: string;
}

export interface FieldMapping {
  /** Stable snake_case key, e.g. work_authorization. */
  canonicalFieldKey: string;
  label: string;
  dataType: MappingDataType;
  patterns: MappingPattern[];
  selectOptions?: string[];
  /** What the applicant is told when nothing is stored — never "assume" or "invent". */
  fallbackRule: string;
}

export const BUILTIN_FIELD_MAPPINGS: FieldMapping[] = [
  { canonicalFieldKey: 'work_authorization', label: 'Work authorization', dataType: 'text', patterns: [{ kind: 'contains', pattern: 'authorized to work' }, { kind: 'contains', pattern: 'authorised to work' }, { kind: 'contains', pattern: 'legally allowed to work' }, { kind: 'contains', pattern: 'eligible to work' }, { kind: 'contains', pattern: 'entitled to work' }, { kind: 'contains', pattern: 'work authorization' }, { kind: 'contains', pattern: 'right to work' }], fallbackRule: 'Answer from your own status only; if unsure, leave it for yourself to answer on the form.' },
  { canonicalFieldKey: 'requires_sponsorship', label: 'Visa sponsorship', dataType: 'boolean', patterns: [{ kind: 'contains', pattern: 'sponsorship' }, { kind: 'regex', pattern: '\\bsponsor(ed|ing)?\\b' }], fallbackRule: 'Leave blank if unknown; never answer No on your behalf.' },
  { canonicalFieldKey: 'salary_expectation', label: 'Salary expectation', dataType: 'numeric', patterns: [{ kind: 'contains', pattern: 'salary expectation' }, { kind: 'contains', pattern: 'expected salary' }, { kind: 'contains', pattern: 'desired salary' }, { kind: 'contains', pattern: 'salary requirement' }, { kind: 'contains', pattern: 'compensation expectation' }, { kind: 'contains', pattern: 'desired compensation' }], fallbackRule: 'Leave blank if you have not stored one; JobPilot never suggests a number.' },
  { canonicalFieldKey: 'earliest_start_date', label: 'Earliest start date', dataType: 'text', patterns: [{ kind: 'contains', pattern: 'start date' }, { kind: 'contains', pattern: 'earliest start' }, { kind: 'contains', pattern: 'when can you start' }, { kind: 'contains', pattern: 'available to start' }], fallbackRule: 'Leave blank if unknown.' },
  { canonicalFieldKey: 'notice_period', label: 'Notice period', dataType: 'text', patterns: [{ kind: 'contains', pattern: 'notice period' }], fallbackRule: 'Leave blank if unknown.' },
  { canonicalFieldKey: 'willing_to_relocate', label: 'Willing to relocate', dataType: 'boolean', patterns: [{ kind: 'regex', pattern: '\\brelocat' }], fallbackRule: 'Leave blank if unknown.' },
  { canonicalFieldKey: 'work_location_preference', label: 'Remote / hybrid / on-site', dataType: 'select', patterns: [{ kind: 'regex', pattern: '\\b(remote|hybrid|on-?site|in[- ]office)\\b' }], selectOptions: ['remote', 'hybrid', 'on_site'], fallbackRule: 'Leave blank if you have not stated a preference.' },
  { canonicalFieldKey: 'years_of_experience', label: 'Years of experience', dataType: 'numeric', patterns: [{ kind: 'contains', pattern: 'years of experience' }, { kind: 'contains', pattern: 'how many years' }, { kind: 'regex', pattern: '\\byears\\b.*\\bexperience\\b' }], fallbackRule: 'Count only what your evidence supports; leave blank otherwise.' },
  { canonicalFieldKey: 'referral_source', label: 'How you heard about the role', dataType: 'text', patterns: [{ kind: 'contains', pattern: 'how did you hear' }, { kind: 'contains', pattern: 'referred by' }, { kind: 'contains', pattern: 'referral' }], fallbackRule: 'Leave blank if unknown.' },
  { canonicalFieldKey: 'previously_applied', label: 'Previously applied or employed here', dataType: 'boolean', patterns: [{ kind: 'contains', pattern: 'previously applied' }, { kind: 'contains', pattern: 'previously worked' }, { kind: 'contains', pattern: 'former employee' }, { kind: 'contains', pattern: 'applied before' }], fallbackRule: 'Leave blank if unknown.' },
  { canonicalFieldKey: 'linkedin_url', label: 'LinkedIn profile', dataType: 'text', patterns: [{ kind: 'contains', pattern: 'linkedin' }], fallbackRule: 'Leave blank if you have none.' },
  { canonicalFieldKey: 'portfolio_url', label: 'Portfolio or website', dataType: 'text', patterns: [{ kind: 'contains', pattern: 'portfolio' }, { kind: 'contains', pattern: 'personal website' }, { kind: 'contains', pattern: 'github' }], fallbackRule: 'Leave blank if you have none.' },
  { canonicalFieldKey: 'phone', label: 'Phone number', dataType: 'text', patterns: [{ kind: 'regex', pattern: '\\b(phone|mobile|cell)\\b' }], fallbackRule: 'Leave blank if you have not stored one.' },
];
export const BUILTIN_FIELD_MAPPING_VERSION = 'builtin:1';

export interface ActiveFieldMappings {
  /** `builtin:1` or `v<n>` for an activated register row. */
  version: string;
  mappings: FieldMapping[];
}

export class FieldMappingError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = 'FieldMappingError';
  }
}

const CACHE_KEY = 'apply:field-mappings:active';
const CACHE_TTL_SECONDS = 300;
const KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;
/** Words that would make a fallback rule an instruction to fabricate rather than a note to the applicant. */
const FORBIDDEN_FALLBACK = /\b(invent|fabricate|make up|assume yes|answer yes|guess)\b/i;

/** A register must be a non-empty array of well-formed, uniquely keyed mappings whose patterns compile. */
export function validateMappings(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return 'mappings must be a non-empty array';
  if (input.length > 200) return 'at most 200 mappings';
  const seen = new Set<string>();
  for (const [i, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object') return `mapping ${i} must be an object`;
    const m = raw as Record<string, unknown>;
    if (typeof m.canonicalFieldKey !== 'string' || !KEY_RE.test(m.canonicalFieldKey)) return `mapping ${i}: canonicalFieldKey must be snake_case (a-z, 0-9, _)`;
    if (seen.has(m.canonicalFieldKey)) return `duplicate canonicalFieldKey "${m.canonicalFieldKey}"`;
    seen.add(m.canonicalFieldKey);
    if (typeof m.label !== 'string' || !m.label.trim() || m.label.length > 120) return `${m.canonicalFieldKey}: label is required (≤ 120 chars)`;
    if (!(MAPPING_DATA_TYPES as readonly string[]).includes(m.dataType as string)) return `${m.canonicalFieldKey}: dataType must be one of ${MAPPING_DATA_TYPES.join(', ')}`;
    if (!Array.isArray(m.patterns) || m.patterns.length === 0) return `${m.canonicalFieldKey}: at least one pattern`;
    for (const p of m.patterns as unknown[]) {
      if (!p || typeof p !== 'object') return `${m.canonicalFieldKey}: pattern must be an object`;
      const { kind, pattern } = p as Record<string, unknown>;
      if (kind !== 'contains' && kind !== 'regex') return `${m.canonicalFieldKey}: pattern kind must be contains or regex`;
      if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 300) return `${m.canonicalFieldKey}: pattern is required (≤ 300 chars)`;
      if (kind === 'regex') {
        try {
          new RegExp(pattern, 'i');
        } catch (error) {
          return `${m.canonicalFieldKey}: invalid regex — ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    if (m.dataType === 'select' && (!Array.isArray(m.selectOptions) || m.selectOptions.length === 0 || !(m.selectOptions as unknown[]).every((o) => typeof o === 'string' && o.trim()))) return `${m.canonicalFieldKey}: a select needs its options`;
    if (typeof m.fallbackRule !== 'string' || !m.fallbackRule.trim() || m.fallbackRule.length > 500) return `${m.canonicalFieldKey}: fallbackRule is required (≤ 500 chars)`;
    if (FORBIDDEN_FALLBACK.test(m.fallbackRule)) return `${m.canonicalFieldKey}: a fallback rule may not tell anyone to invent, assume or guess an answer`;
  }
  return null;
}

export function parseMappings(json: string): FieldMapping[] {
  const parsed = JSON.parse(json) as FieldMapping[];
  const problem = validateMappings(parsed);
  if (problem) throw new FieldMappingError(`stored mappings are invalid: ${problem}`, 500);
  return parsed;
}

function normalise(label: string): string {
  return ` ${label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** The first mapping whose pattern the form label satisfies, in register order. Pure. */
export function matchMapping(label: string, mappings: FieldMapping[]): FieldMapping | null {
  const text = normalise(label);
  for (const m of mappings) {
    for (const p of m.patterns) {
      if (p.kind === 'contains') {
        // A word boundary at the start only: "salary expectation" must meet "salary expectations".
        if (text.includes(` ${normalise(p.pattern).trim()}`)) return m;
      } else {
        let re: RegExp;
        try {
          re = new RegExp(p.pattern, 'i');
        } catch {
          continue;
        }
        if (re.test(label)) return m;
      }
    }
  }
  return null;
}

/**
 * The mappings to prepare with now: the active register version, else the
 * built-in set. Cache-first; always on the SYSTEM client (the register is
 * system-only, so a tenant transaction would see nothing and cache the
 * baseline over a real activation — the Stage 08 lesson).
 */
export async function getActiveFieldMappings(): Promise<ActiveFieldMappings> {
  const cache = getCache();
  try {
    const cached = await cache.get(CACHE_KEY);
    if (cached !== null) return JSON.parse(cached) as ActiveFieldMappings;
  } catch (error) {
    console.error('[apply] mapping cache read failed; reading through:', error);
  }
  const active = await db.fieldMappingVersion.findFirst({ where: { status: 'active' }, orderBy: [{ activatedAt: 'desc' }, { version: 'desc' }] });
  let result: ActiveFieldMappings;
  if (active) {
    try {
      result = { version: `v${active.version}`, mappings: parseMappings(active.mappings) };
    } catch (error) {
      console.error(`[apply] active field mappings v${active.version} are invalid; preparing with the built-in set:`, error instanceof Error ? error.message : error);
      return { version: BUILTIN_FIELD_MAPPING_VERSION, mappings: BUILTIN_FIELD_MAPPINGS };
    }
  } else {
    result = { version: BUILTIN_FIELD_MAPPING_VERSION, mappings: BUILTIN_FIELD_MAPPINGS };
  }
  try {
    await cache.set(CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS);
  } catch (error) {
    console.error('[apply] mapping cache write failed; continuing:', error);
  }
  return result;
}

export async function invalidateActiveFieldMappings(): Promise<void> {
  try {
    await getCache().del(CACHE_KEY);
  } catch (error) {
    console.error('[apply] mapping cache invalidation failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Governance — the same lifecycle as PromptVersion, AtsRuleset and MatchWeightVersion.

async function lock(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'apply:field-mappings'}::text))`;
}

function snapshot(r: FieldMappingVersion) {
  return { version: r.version, status: r.status, mappings: r.mappings, notes: r.notes, createdByEmail: r.createdByEmail, approvedByEmail: r.approvedByEmail };
}

async function audit(tx: Prisma.TransactionClient, action: string, actor: StaffContext, before: FieldMappingVersion | null, after: FieldMappingVersion, summary: string, reason: string | null) {
  const b = before ? snapshot(before) : null;
  const a = snapshot(after);
  await tx.auditLog.create({
    data: {
      actorType: 'staff',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action,
      entityType: 'FieldMappingVersion',
      entityId: after.id,
      summary,
      before: JSON.stringify(b ?? {}),
      after: JSON.stringify(a),
      changedFields: JSON.stringify(b ? (Object.keys(a) as (keyof typeof a)[]).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k])) : Object.keys(a)),
      reason,
    },
  });
}

async function loadLocked(tx: Prisma.TransactionClient, id: string): Promise<FieldMappingVersion> {
  await lock(tx);
  const r = await tx.fieldMappingVersion.findUnique({ where: { id } });
  if (!r) throw new FieldMappingError('That mapping version does not exist.', 404);
  return r;
}

export async function listFieldMappingVersions(client: Prisma.TransactionClient | typeof db = db): Promise<FieldMappingVersion[]> {
  return client.fieldMappingVersion.findMany({ orderBy: { version: 'desc' } });
}

export async function createFieldMappingVersion(input: { mappings: unknown; notes?: string }, actor: StaffContext, reason: string | null = null): Promise<FieldMappingVersion> {
  const problem = validateMappings(input.mappings);
  if (problem) throw new FieldMappingError(problem, 422);
  return db.$transaction(async (tx) => {
    await lock(tx);
    const latest = await tx.fieldMappingVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
    const created = await tx.fieldMappingVersion.create({
      data: { version: (latest?.version ?? 0) + 1, mappings: JSON.stringify(input.mappings), notes: input.notes ?? '', createdById: actor.id, createdByEmail: actor.email },
    });
    await audit(tx, 'field_mappings.create', actor, null, created, `Created field mappings v${created.version} (draft).`, reason);
    return created;
  });
}

/** draft → approved, by a second admin. */
export async function approveFieldMappingVersion(id: string, actor: StaffContext, reason: string | null = null): Promise<FieldMappingVersion> {
  return db.$transaction(async (tx) => {
    const before = await loadLocked(tx, id);
    if (before.status !== 'draft') throw new FieldMappingError(`Only a draft can be approved; this version is ${before.status}.`);
    if (before.createdById && before.createdById === actor.id) throw new FieldMappingError('Mappings cannot be approved by the person who created them; a second admin must approve.', 403);
    const after = await tx.fieldMappingVersion.update({ where: { id }, data: { status: 'approved', approvedById: actor.id, approvedByEmail: actor.email, approvedAt: new Date() } });
    await audit(tx, 'field_mappings.approve', actor, before, after, `Approved field mappings v${after.version}.`, reason);
    return after;
  });
}

/** approved → active, demoting the current active version to approved. An older target is the rollback. A reason is mandatory: these rules decide what goes into an employer's form. */
export async function activateFieldMappingVersion(id: string, actor: StaffContext, reason: string | null = null): Promise<FieldMappingVersion> {
  const result = await db.$transaction(async (tx) => {
    const before = await loadLocked(tx, id);
    if (before.status === 'active') throw new FieldMappingError('This version is already active.');
    if (before.status !== 'approved') throw new FieldMappingError(`Only an approved version can be activated; this version is ${before.status}.`);
    if (!reason || !reason.trim()) throw new FieldMappingError('A reason is required to activate field mappings; it is recorded in the audit.', 422);
    const current = await tx.fieldMappingVersion.findFirst({ where: { status: 'active' } });
    if (current) await tx.fieldMappingVersion.update({ where: { id: current.id }, data: { status: 'approved' } });
    const after = await tx.fieldMappingVersion.update({ where: { id }, data: { status: 'active', activatedAt: new Date() } });
    const rollback = current !== null && current.version > after.version;
    await audit(tx, rollback ? 'field_mappings.rollback' : 'field_mappings.activate', actor, before, after, rollback ? `Rolled field mappings back from v${current!.version} to v${after.version}.` : `Activated field mappings v${after.version}${current ? ` (was v${current.version})` : ' (was the built-in set)'}.`, reason);
    return after;
  });
  await invalidateActiveFieldMappings();
  return result;
}

/** Any non-active version → retired. */
export async function retireFieldMappingVersion(id: string, actor: StaffContext, reason: string | null = null): Promise<FieldMappingVersion> {
  return db.$transaction(async (tx) => {
    const before = await loadLocked(tx, id);
    if (before.status === 'active') throw new FieldMappingError('The active mappings cannot be retired; activate another version first (the built-in set applies when none is active).');
    if (before.status === 'retired') throw new FieldMappingError('This version is already retired.');
    const after = await tx.fieldMappingVersion.update({ where: { id }, data: { status: 'retired' } });
    await audit(tx, 'field_mappings.retire', actor, before, after, `Retired field mappings v${after.version}.`, reason);
    return after;
  });
}

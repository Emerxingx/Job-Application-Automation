import { createHash } from 'node:crypto';
import type { Prisma, PromptVersion } from '@prisma/client';
import { db } from '../db';
import {
  MissingPromptVariablesError,
  extractPlaceholders,
  interpolate,
  missingVariables,
} from '../prompt-interpolate';
import type { StaffContext } from '../crm/auth';
import { parseJson } from '../types';

export { MissingPromptVariablesError } from '../prompt-interpolate';

/**
 * The governed prompt registry (ADR-0019 Tier 1, AI_GOVERNANCE.md § Prompt
 * governance). Stage 03 moved it out of the editorial CMS: a system prompt is
 * security-relevant configuration, so it lives in the transactional database
 * behind the staff console's two-lock gate, with step-up authentication on
 * every change, an audit row per change and a lifecycle the code enforces.
 *
 * LIFECYCLE
 *   draft ──approve──▶ approved ──promote──▶ default ──(another promoted)──▶ approved
 *     │                   │                     │
 *     └──────retire───────┴─────────────────────┘ (never the default: promote another first)
 *
 * The one rule that matters: `promote` refuses unless `evaluationStatus` is
 * `passed`. A version that has not passed evaluation cannot serve traffic, no
 * matter who asks. Evaluation status is recorded by a person, with a note;
 * this stage ships no automated evaluator (the live path has never run), so
 * the seeded baselines sit at `approved / pending` and the gateway serves the
 * deterministic engine until an operator records a passed evaluation.
 *
 * Rollback is a promotion of an older version that still holds a passed
 * evaluation; it is recorded as `prompt.rollback` so the audit feed reads
 * honestly.
 *
 * READ PATH. `renderPrompt(slug, variables)` fetches the default version and
 * interpolates it single-pass and non-recursively (prompt-interpolate.ts).
 * Missing declared variables are a hard error. There is no cache: one
 * indexed read per generation is nothing next to the model call, and a cache
 * would make a rollback take effect late.
 */

export const DEPLOYMENT_STATUSES = ['draft', 'approved', 'default', 'retired'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];
export const EVALUATION_STATUSES = ['pending', 'passed', 'failed'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export type PromptAuditAction =
  | 'prompt.create'
  | 'prompt.approve'
  | 'prompt.evaluate'
  | 'prompt.promote'
  | 'prompt.rollback'
  | 'prompt.retire';

type Client = Prisma.TransactionClient | typeof db;

export class PromptNotFoundError extends Error {
  constructor(slug: string) {
    super(`No default prompt is deployed for "${slug}".`);
    this.name = 'PromptNotFoundError';
  }
}

/** A lifecycle rule refused the change. Message is safe to show staff. */
export class PromptGovernanceError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'PromptGovernanceError';
    this.status = status;
  }
}

// --- read path ---------------------------------------------------------------

export interface RenderedPrompt {
  id: string;
  slug: string;
  version: number;
  modelProvider: string;
  targetModel: string;
  systemPrompt: string;
  userPrompt: string | null;
  modelParameters: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
}

/** The version currently serving a slug, or null when none is deployed. */
export async function getActivePrompt(slug: string, client: Client = db): Promise<PromptVersion | null> {
  return client.promptVersion.findFirst({ where: { slug, deploymentStatus: 'default' } });
}

/**
 * Fetch the default version and interpolate it.
 *
 * @throws PromptNotFoundError         when no default version exists for the slug
 * @throws MissingPromptVariablesError when a declared variable was not supplied
 */
export async function renderPrompt(
  slug: string,
  variables: Record<string, string>,
  client: Client = db,
): Promise<RenderedPrompt> {
  const doc = await getActivePrompt(slug, client);
  if (!doc) throw new PromptNotFoundError(slug);

  const declared = parseJson<string[]>(doc.requiredVariables, []);
  const missing = missingVariables(declared, variables);
  if (missing.length > 0) throw new MissingPromptVariablesError(slug, missing);

  return {
    id: doc.id,
    slug: doc.slug,
    version: doc.version,
    modelProvider: doc.modelProvider,
    targetModel: doc.targetModel,
    systemPrompt: interpolate(doc.systemPrompt, variables),
    userPrompt: doc.userPromptTemplate ? interpolate(doc.userPromptTemplate, variables) : null,
    modelParameters: parseJson<Record<string, unknown>>(doc.modelParameters, {}),
    outputSchema: doc.outputSchema ? parseJson<Record<string, unknown> | null>(doc.outputSchema, null) : null,
  };
}

// --- administration ------------------------------------------------------------

export interface NewPromptVersionInput {
  slug: string;
  targetModel: string;
  modelProvider?: string;
  systemPrompt: string;
  userPromptTemplate?: string | null;
  requiredVariables: string[];
  modelParameters?: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  notes?: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** modelParameters must be a plain object with sane numeric ranges where present. */
export function validateModelParameters(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'modelParameters must be a JSON object.';
  const p = value as Record<string, unknown>;
  if ('temperature' in p && (typeof p.temperature !== 'number' || p.temperature < 0 || p.temperature > 2)) {
    return 'temperature must be a number between 0 and 2.';
  }
  if ('top_p' in p && (typeof p.top_p !== 'number' || p.top_p < 0 || p.top_p > 1)) {
    return 'top_p must be a number between 0 and 1.';
  }
  if ('max_tokens' in p && (typeof p.max_tokens !== 'number' || p.max_tokens < 1 || !Number.isInteger(p.max_tokens))) {
    return 'max_tokens must be a positive integer.';
  }
  if ('effort' in p && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(p.effort))) {
    return 'effort must be one of low, medium, high, xhigh, max.';
  }
  return null;
}

/**
 * Validate a new version's shape. Both directions of the variable contract
 * are checked: a declared variable with no placeholder is a typo that would
 * make the engine reject valid calls; a placeholder that is not declared
 * would be sent to the model as literal "{{name}}" text.
 */
export function validatePromptInput(input: NewPromptVersionInput): string | null {
  if (!SLUG.test(input.slug)) return 'slug must be lowercase letters, digits and hyphens (2-64 characters).';
  if (!input.targetModel.trim()) return 'targetModel is required.';
  if (!input.systemPrompt.trim()) return 'systemPrompt is required.';
  const declared = [...new Set(input.requiredVariables.map((v) => v.trim()).filter(Boolean))];
  if (declared.some((v) => !/^[a-zA-Z0-9_]+$/.test(v))) return 'requiredVariables must be identifiers.';
  const haystack = `${input.systemPrompt}\n${input.userPromptTemplate ?? ''}`;
  const orphan = declared.find((name) => !haystack.includes(`{{${name}}}`));
  if (orphan) return `requiredVariables lists "${orphan}" but no {{${orphan}}} placeholder appears in the prompt.`;
  const undeclared = extractPlaceholders(haystack).find((name) => !declared.includes(name));
  if (undeclared) return `The prompt uses {{${undeclared}}} but does not declare it in requiredVariables.`;
  const params = validateModelParameters(input.modelParameters);
  if (params) return params;
  if (input.outputSchema != null && (typeof input.outputSchema !== 'object' || Array.isArray(input.outputSchema))) {
    return 'outputSchema must be a JSON object.';
  }
  return null;
}

/** Content digest, so the audit row can prove WHICH text was approved without storing it twice. */
export function promptDigest(v: Pick<PromptVersion, 'systemPrompt' | 'userPromptTemplate'>): string {
  return createHash('sha256').update(`${v.systemPrompt}\n--\n${v.userPromptTemplate ?? ''}`).digest('hex');
}

function snapshot(v: PromptVersion) {
  return {
    slug: v.slug,
    version: v.version,
    deploymentStatus: v.deploymentStatus,
    evaluationStatus: v.evaluationStatus,
    targetModel: v.targetModel,
    digest: promptDigest(v),
  };
}

async function audit(
  tx: Prisma.TransactionClient,
  action: PromptAuditAction,
  actor: StaffContext,
  before: PromptVersion | null,
  after: PromptVersion,
  summary: string,
  reason: string | null,
) {
  const changed = before
    ? (Object.keys(snapshot(after)) as (keyof ReturnType<typeof snapshot>)[]).filter((k) => snapshot(before)[k] !== snapshot(after)[k])
    : Object.keys(snapshot(after));
  await tx.auditLog.create({
    data: {
      actorType: 'staff',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action,
      entityType: 'PromptVersion',
      entityId: after.id,
      summary,
      before: JSON.stringify(before ? snapshot(before) : {}),
      after: JSON.stringify(snapshot(after)),
      changedFields: JSON.stringify(changed),
      reason,
    },
  });
}

/** Every version of every slug, newest first within a slug. */
export async function listPromptVersions(client: Client = db): Promise<PromptVersion[]> {
  return client.promptVersion.findMany({ orderBy: [{ slug: 'asc' }, { version: 'desc' }] });
}

/** Create the next version of a slug as a draft. Never touches the current default. */
export async function createPromptVersion(input: NewPromptVersionInput, actor: StaffContext, reason: string | null = null) {
  const problem = validatePromptInput(input);
  if (problem) throw new PromptGovernanceError(problem, 422);
  const declared = [...new Set(input.requiredVariables.map((v) => v.trim()).filter(Boolean))];

  return db.$transaction(async (tx) => {
    const latest = await tx.promptVersion.findFirst({ where: { slug: input.slug }, orderBy: { version: 'desc' }, select: { version: true } });
    const created = await tx.promptVersion.create({
      data: {
        slug: input.slug,
        version: (latest?.version ?? 0) + 1,
        modelProvider: input.modelProvider ?? 'anthropic',
        targetModel: input.targetModel.trim(),
        systemPrompt: input.systemPrompt,
        userPromptTemplate: input.userPromptTemplate ?? null,
        requiredVariables: JSON.stringify(declared),
        modelParameters: JSON.stringify(input.modelParameters ?? {}),
        outputSchema: input.outputSchema ? JSON.stringify(input.outputSchema) : null,
        deploymentStatus: 'draft',
        evaluationStatus: 'pending',
        createdById: actor.id,
        createdByEmail: actor.email,
        notes: input.notes ?? '',
      },
    });
    await audit(tx, 'prompt.create', actor, null, created, `Created ${created.slug} v${created.version} (draft).`, reason);
    return created;
  });
}

async function load(tx: Prisma.TransactionClient, id: string): Promise<PromptVersion> {
  const v = await tx.promptVersion.findUnique({ where: { id } });
  if (!v) throw new PromptGovernanceError('That prompt version does not exist.', 404);
  return v;
}

/** draft → approved. Approval is a second person's reading, recorded by name. */
export async function approvePromptVersion(id: string, actor: StaffContext, reason: string | null = null) {
  return db.$transaction(async (tx) => {
    const before = await load(tx, id);
    if (before.deploymentStatus !== 'draft') throw new PromptGovernanceError(`Only a draft can be approved; this version is ${before.deploymentStatus}.`);
    const after = await tx.promptVersion.update({
      where: { id },
      data: { deploymentStatus: 'approved', approvedById: actor.id, approvedByEmail: actor.email, approvedAt: new Date() },
    });
    await audit(tx, 'prompt.approve', actor, before, after, `Approved ${after.slug} v${after.version}.`, reason);
    return after;
  });
}

/**
 * Record the outcome of an evaluation run against the golden set. The note
 * is where the evidence lives (what was run, on which model, the numbers);
 * it is required for `passed` so a pass can never be recorded without saying
 * what passed.
 */
export async function recordPromptEvaluation(
  id: string,
  outcome: { status: EvaluationStatus; note: string },
  actor: StaffContext,
  reason: string | null = null,
) {
  if (!EVALUATION_STATUSES.includes(outcome.status)) throw new PromptGovernanceError('Unknown evaluation status.', 422);
  if (outcome.status === 'passed' && outcome.note.trim().length < 10) {
    throw new PromptGovernanceError('A passed evaluation must carry a note describing what was evaluated and the result.', 422);
  }
  return db.$transaction(async (tx) => {
    const before = await load(tx, id);
    if (before.deploymentStatus === 'retired') throw new PromptGovernanceError('A retired version cannot be evaluated.');
    // A default that FAILS a fresh evaluation stops serving immediately: it
    // is demoted to approved, and the gateway degrades to the deterministic
    // engine until an operator promotes something that passes.
    const demote = outcome.status === 'failed' && before.deploymentStatus === 'default';
    const after = await tx.promptVersion.update({
      where: { id },
      data: {
        evaluationStatus: outcome.status,
        evaluationNote: outcome.note.trim(),
        ...(demote ? { deploymentStatus: 'approved' } : {}),
      },
    });
    await audit(
      tx,
      'prompt.evaluate',
      actor,
      before,
      after,
      `Evaluation ${outcome.status} for ${after.slug} v${after.version}${demote ? ' — demoted from default' : ''}.`,
      reason,
    );
    return after;
  });
}

/**
 * approved → default, demoting the current default of the slug to approved.
 * Refused unless the version has PASSED evaluation. When the target is older
 * than the current default this is a rollback and is recorded as one.
 */
export async function promotePromptVersion(id: string, actor: StaffContext, reason: string | null = null) {
  return db.$transaction(async (tx) => {
    const before = await load(tx, id);
    if (before.deploymentStatus === 'default') throw new PromptGovernanceError('This version is already the default.');
    if (before.deploymentStatus !== 'approved') {
      throw new PromptGovernanceError(`Only an approved version can be promoted; this version is ${before.deploymentStatus}.`);
    }
    if (before.evaluationStatus !== 'passed') {
      throw new PromptGovernanceError('A version cannot be made default until its evaluation has passed.');
    }
    const current = await tx.promptVersion.findFirst({ where: { slug: before.slug, deploymentStatus: 'default' } });
    if (current) {
      await tx.promptVersion.update({ where: { id: current.id }, data: { deploymentStatus: 'approved' } });
    }
    const after = await tx.promptVersion.update({ where: { id }, data: { deploymentStatus: 'default' } });
    const rollback = current !== null && current.version > after.version;
    await audit(
      tx,
      rollback ? 'prompt.rollback' : 'prompt.promote',
      actor,
      before,
      after,
      rollback
        ? `Rolled ${after.slug} back from v${current!.version} to v${after.version}.`
        : `Promoted ${after.slug} v${after.version} to default${current ? ` (was v${current.version})` : ''}.`,
      reason,
    );
    return after;
  });
}

/** Any non-default version → retired. The default must be replaced first. */
export async function retirePromptVersion(id: string, actor: StaffContext, reason: string | null = null) {
  return db.$transaction(async (tx) => {
    const before = await load(tx, id);
    if (before.deploymentStatus === 'default') throw new PromptGovernanceError('The default version cannot be retired; promote another version first.');
    if (before.deploymentStatus === 'retired') throw new PromptGovernanceError('This version is already retired.');
    const after = await tx.promptVersion.update({ where: { id }, data: { deploymentStatus: 'retired' } });
    await audit(tx, 'prompt.retire', actor, before, after, `Retired ${after.slug} v${after.version}.`, reason);
    return after;
  });
}

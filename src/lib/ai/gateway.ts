import type { InterviewPrepPackage, MatchAnalysis, ResumeContent, TailoredDocuments } from '../types';
import { renderResumeText } from '../resume-render';
import { db } from '../db';
import { getDeterministicEngine, getExternalModelProvider } from '../providers';
import type { MatchOptions } from '@/lib/providers/ai/types';
import type { JobContext } from '../providers/ai/types';
import type { AiProcessingPolicy } from '../tenancy/roles';
import { externalAllowed, resolveAiPolicy } from './policy';
import { assertNoRestrictedFields, RestrictedPayloadError } from './restricted-fields';
import { allowedContext, buildCorpus, findViolations, groundInterviewPack, groundMatchAnalysis, groundTailoredDocuments } from './grounding';
import type { MessageKind } from '../documents/kinds';
import { MissingPromptVariablesError, PromptNotFoundError, renderPrompt, type RenderedPrompt } from './prompt-registry';
import { redactError } from '@/lib/log';

/**
 * The AI gateway (ADR-0006, ADR-0015, AI_GOVERNANCE.md). Every model-backed
 * task in the product goes through here, and nothing else in the codebase
 * may hold an external provider (tests/ai-gateway.test.ts, static part).
 *
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER
 * ---------------------------------------------
 *   1. Resolve the tenant's AI processing policy. Before anything else, from
 *      the organisation the request acts within; missing or unreadable
 *      resolves to EXTERNAL_AI_PROHIBITED (policy.ts).
 *   2. Refuse a payload that carries a RESTRICTED field (ADR-0007). This is
 *      not a routing decision: the payload is wrong, on every route, so the
 *      run is recorded as `refused` and the error propagates.
 *   3. Run the deterministic engine. Always. Its output is built only from the
 *      résumé, so it is grounded by construction, and it is the per-section
 *      fallback for whatever the external model gets wrong.
 *   4. Decide the route. The policy must permit the task, a provider must be
 *      configured, and a DEFAULT prompt version must exist in the governed
 *      registry. Any of those failing is recorded — `deterministic` when the
 *      policy decided, `degraded` when the policy would have allowed it but
 *      the platform could not — and the baseline serves. Never silently.
 *   5. External call with the rendered prompt; then grounding IN CODE before
 *      anything is rendered: unevidenced claims are rejected section by
 *      section and counted on the run.
 *   6. Write the AiRun row: task, tenant, policy state, route, provider,
 *      model, prompt slug + version, input and evidence references (never
 *      content), claims rejected, duration. That row is how "why did the
 *      system say that?" is answered.
 *
 * What the gateway sends out is the résumé projection (Stage 02: never the
 * sensitive schema, which has no Prisma model) plus the posting. Evidence is
 * passed as ids and one-line claims (the corpus the checker admits), never as
 * a free-text profile dump.
 */

export type AiTask = 'analyze_match' | 'tailor' | 'prepare_interview' | 'compose';
export type AiRoute = 'external' | 'deterministic' | 'degraded' | 'refused';

export const TASK_PROMPT_SLUG: Record<AiTask, string> = {
  analyze_match: 'analyze-match',
  tailor: 'tailor',
  prepare_interview: 'prepare-interview',
  compose: 'compose',
};

/** Approved evidence for generation: opaque ids for the run, one-line claims for the corpus. */
export interface EvidenceBundle {
  ids: string[];
  claims: string[];
  /** Stage 08: the same rows with their kind, so a dimension can cite the claims that support it. */
  entries?: { id: string; kind: string; claim: string }[];
}

export interface GenerationContext {
  userId: string;
  /** Defaults to the user's personal workspace. */
  organizationId?: string | null;
  evidence?: EvidenceBundle;
  /** Opaque references to the inputs (a job id, an application id). Never content. */
  inputRefs?: string[];
  /** Test seam: the client the AiRun row is written with. */
  client?: typeof db;
}

export interface GatewayRun {
  id: string | null;
  task: AiTask;
  policyState: AiProcessingPolicy;
  policyBasis: string;
  route: AiRoute;
  provider: string;
  model: string | null;
  promptSlug: string | null;
  promptVersion: number | null;
  claimsRejected: number;
  /** Why the route is not `external`, when it is not. Stable codes, never provider text. */
  reason: string | null;
  durationMs: number;
}

export interface GatewayResult<T> {
  value: T;
  run: GatewayRun;
}

/** Why a permitted external route did not serve. */
export type DegradeReason =
  | 'policy_prohibited'
  | 'policy_restricted'
  | 'no_external_provider'
  | 'no_default_prompt'
  | 'prompt_variables'
  | 'provider_unavailable'
  | 'malformed_output';

interface TaskSpec<T, Raw> {
  task: AiTask;
  /** Everything that would leave the boundary, for the RESTRICTED-field check. */
  payload: unknown;
  deterministic: () => Promise<T>;
  variables: (baseline: T) => Record<string, string>;
  schema: Record<string, unknown>;
  /** Map the model's JSON to the product shape. May throw on a malformed document. */
  parse: (raw: Raw, baseline: T) => T;
  ground: (candidate: T, baseline: T) => { value: T; rejected: number };
  /** Attach an honest notice to a non-external result, where the shape has room for one. */
  annotate?: (value: T, route: AiRoute, reason: DegradeReason) => T;
}

async function execute<T, Raw>(ctx: GenerationContext, spec: TaskSpec<T, Raw>): Promise<GatewayResult<T>> {
  const client = ctx.client ?? db;
  const started = Date.now();
  const policy = await resolveAiPolicy({ userId: ctx.userId, organizationId: ctx.organizationId }, client);
  const slug = TASK_PROMPT_SLUG[spec.task];

  const run: GatewayRun = {
    id: null,
    task: spec.task,
    policyState: policy.policy,
    policyBasis: policy.basis,
    route: 'deterministic',
    provider: 'deterministic',
    model: null,
    promptSlug: null,
    promptVersion: null,
    claimsRejected: 0,
    reason: null,
    durationMs: 0,
  };

  const record = async (status: 'ok' | 'refused' | 'failed', error: string | null) => {
    run.durationMs = Date.now() - started;
    try {
      const row = await client.aiRun.create({
        data: {
          task: spec.task,
          userId: ctx.userId,
          organizationId: policy.organizationId,
          policyState: policy.policy,
          route: run.route,
          provider: run.provider,
          model: run.model,
          promptSlug: run.promptSlug,
          promptVersion: run.promptVersion,
          inputRefs: JSON.stringify([...(ctx.inputRefs ?? []), `policy_basis:${policy.basis}`]),
          evidenceRefs: JSON.stringify(ctx.evidence?.ids ?? []),
          claimsRejected: run.claimsRejected,
          status,
          error,
          durationMs: run.durationMs,
        },
        select: { id: true },
      });
      run.id = row.id;
    } catch (err) {
      // The record is traceability, not a precondition of serving the user;
      // its absence is logged loudly and the result still returns.
      console.error(`[ai-gateway] failed to record ${spec.task} run:`, redactError(err).message);
    }
  };

  // 2. A RESTRICTED field in the payload is a defect on every route.
  try {
    assertNoRestrictedFields(spec.payload);
  } catch (error) {
    if (error instanceof RestrictedPayloadError) {
      run.route = 'refused';
      run.provider = 'none';
      run.reason = 'restricted_payload';
      await record('refused', `restricted_payload:${error.key}`);
    }
    throw error;
  }

  // Anything that throws after this point is still a run: the row is
  // written with status `failed` and a stable code before the error
  // propagates, so a call that reached the provider always leaves a trace.
  const failed = async (code: string, error: unknown): Promise<never> => {
    run.durationMs = Date.now() - started;
    await record('failed', code);
    throw error;
  };

  // 3. The grounded baseline, always.
  let baseline: T;
  try {
    baseline = await spec.deterministic();
  } catch (error) {
    run.route = 'deterministic';
    return failed('deterministic_engine_error', error);
  }

  const degrade = async (route: AiRoute, reason: DegradeReason): Promise<GatewayResult<T>> => {
    run.route = route;
    run.reason = reason;
    await record('ok', route === 'degraded' ? reason : null);
    return { value: spec.annotate ? spec.annotate(baseline, route, reason) : baseline, run };
  };

  // 4. The route.
  if (!externalAllowed(policy.policy, spec.task)) {
    return degrade('deterministic', policy.policy === 'EXTERNAL_AI_RESTRICTED' ? 'policy_restricted' : 'policy_prohibited');
  }
  const provider = getExternalModelProvider();
  if (!provider) return degrade('degraded', 'no_external_provider');

  let prompt: RenderedPrompt;
  try {
    prompt = await renderPrompt(slug, spec.variables(baseline), client);
  } catch (error) {
    if (error instanceof PromptNotFoundError) return degrade('degraded', 'no_default_prompt');
    if (error instanceof MissingPromptVariablesError) {
      // A deployed prompt declaring a variable this code does not supply is a
      // configuration defect; it degrades loudly rather than sending a
      // literal placeholder to the model.
      console.error(`[ai-gateway] ${slug} v? declares variables this task does not supply: ${error.missing.join(', ')}`);
      return degrade('degraded', 'prompt_variables');
    }
    throw error;
  }
  run.provider = provider.name;
  run.model = prompt.targetModel;
  run.promptSlug = prompt.slug;
  run.promptVersion = prompt.version;

  // 5. The call, then grounding in code.
  const params = prompt.modelParameters;
  run.route = 'external';
  let raw: Raw | null;
  try {
    raw = await provider.complete<Raw>({
      model: prompt.targetModel,
      system: prompt.systemPrompt,
      prompt: prompt.userPrompt ?? '',
      schema: prompt.outputSchema ?? spec.schema,
      maxTokens: typeof params.max_tokens === 'number' ? params.max_tokens : undefined,
      effort: typeof params.effort === 'string' ? (params.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : undefined,
      temperature: typeof params.temperature === 'number' ? params.temperature : undefined,
    });
  } catch (error) {
    // The adapter returns null on its own failures; a throw here is a
    // provider that does not honour the contract. Recorded, then raised.
    return failed('provider_threw', error);
  }
  if (raw === null || raw === undefined) return degrade('degraded', 'provider_unavailable');

  let candidate: T;
  try {
    candidate = spec.parse(raw, baseline);
  } catch {
    return degrade('degraded', 'malformed_output');
  }
  try {
    const grounded = spec.ground(candidate, baseline);
    run.claimsRejected = grounded.rejected;
    await record('ok', null);
    return { value: grounded.value, run };
  } catch (error) {
    return failed('grounding_error', error);
  }
}

// --- shared prompt material -----------------------------------------------------------

function jobBlock(job: JobContext): string {
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location} (${job.workMode})`,
    job.seniority ? `Seniority: ${job.seniority}` : '',
    `Required skills: ${job.skills.join(', ') || 'not listed'}`,
    `Requirements:\n${job.requirements.map((r) => `- ${r}`).join('\n') || '- not listed'}`,
    `Description:\n${job.description}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const engine = () => getDeterministicEngine();

// --- analyze_match ----------------------------------------------------------------

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matchScore: { type: 'integer' },
    breakdown: {
      type: 'object',
      properties: {
        skills: { type: 'integer' },
        experience: { type: 'integer' },
        keywords: { type: 'integer' },
        location: { type: 'integer' },
        seniority: { type: 'integer' },
      },
      required: ['skills', 'experience', 'keywords', 'location', 'seniority'],
      additionalProperties: false,
    },
    matchedKeywords: { type: 'array', items: { type: 'string' } },
    missingKeywords: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: ['matchScore', 'breakdown', 'matchedKeywords', 'missingKeywords', 'rationale'],
  additionalProperties: false,
};

/**
 * The deterministic engine alone: no policy resolution, no provider, no
 * `AiRun`. For a caller scoring OTHER people's résumés on a third party's
 * behalf (Stage 18 sourcing), where writing runs under each candidate's
 * identity, or routing their résumé to a model under a purpose they never
 * consented to, would be wrong. A pure function of its inputs.
 */
export async function analyzeMatchDeterministic(resume: ResumeContent, job: JobContext, options?: MatchOptions): Promise<MatchAnalysis> {
  return engine().analyzeMatch(resume, job, options);
}

export async function analyzeMatch(ctx: GenerationContext, resume: ResumeContent, job: JobContext, options?: MatchOptions): Promise<GatewayResult<MatchAnalysis>> {
  const claims = ctx.evidence?.claims ?? [];
  return execute<MatchAnalysis, MatchAnalysis>(ctx, {
    task: 'analyze_match',
    payload: { resume, job, claims },
    deterministic: () => engine().analyzeMatch(resume, job, options),
    variables: (baseline) => ({
      job_block: jobBlock(job),
      grounding: [
        `Matched: ${baseline.matchedKeywords.join(', ') || 'none'}`,
        `Missing: ${baseline.missingKeywords.join(', ') || 'none'}`,
        `Baseline score: ${baseline.matchScore}`,
      ].join('\n'),
      resume_json: JSON.stringify(resume, null, 2),
      resume_text: renderResumeText(resume),
      evidence_claims: claims.map((c) => `- ${c}`).join('\n') || '- none beyond the résumé',
    }),
    schema: MATCH_SCHEMA,
    parse: (raw) => {
      if (!raw || typeof raw !== 'object' || typeof raw.matchScore !== 'number' || !raw.breakdown) throw new Error('malformed');
      return raw;
    },
    ground: (candidate, baseline) => {
      const { analysis, report } = groundMatchAnalysis(candidate, baseline, resume, job, claims);
      return { value: analysis, rejected: report.violations.length };
    },
  });
}

// --- tailor -----------------------------------------------------------------------

interface RawTailor {
  summary: string;
  headline: string;
  skills: string[];
  experience: { company: string; title: string; bullets: string[] }[];
  coverLetter: string;
  changes: string[];
  atsScore: number;
}

const TAILOR_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    headline: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          title: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['company', 'title', 'bullets'],
        additionalProperties: false,
      },
    },
    coverLetter: { type: 'string' },
    changes: { type: 'array', items: { type: 'string' } },
    atsScore: { type: 'integer' },
  },
  required: ['summary', 'headline', 'skills', 'experience', 'coverLetter', 'changes', 'atsScore'],
  additionalProperties: false,
};

const DEGRADE_NOTICE: Record<DegradeReason, string> = {
  policy_prohibited: "Your workspace's AI policy keeps your data within JobPilot, so these documents were prepared by the built-in engine and no external model was used.",
  policy_restricted: "Your workspace's AI policy restricts external processing for this task, so these documents were prepared by the built-in engine.",
  no_external_provider: 'AI tailoring is not configured on this deployment; the built-in engine prepared these documents.',
  no_default_prompt: 'AI tailoring is not yet enabled (no approved prompt is deployed); the built-in engine prepared these documents.',
  prompt_variables: 'AI tailoring is misconfigured and was not used; the built-in engine prepared these documents.',
  provider_unavailable: 'The AI service did not respond, so the built-in engine prepared these documents.',
  malformed_output: 'The AI service returned an unusable result, so the built-in engine prepared these documents.',
};

export async function tailor(
  ctx: GenerationContext,
  resume: ResumeContent,
  job: JobContext,
  analysis: MatchAnalysis,
): Promise<GatewayResult<TailoredDocuments>> {
  const claims = ctx.evidence?.claims ?? [];
  return execute<TailoredDocuments, RawTailor>(ctx, {
    task: 'tailor',
    payload: { resume, job, analysis, claims },
    deterministic: () => engine().tailor(resume, job, analysis),
    variables: () => ({
      job_block: jobBlock(job),
      gap_analysis: [
        `Already demonstrated: ${analysis.matchedKeywords.join(', ') || 'none'}`,
        `Named in posting but absent: ${analysis.missingKeywords.join(', ') || 'none'}`,
      ].join('\n'),
      resume_json: JSON.stringify(resume, null, 2),
      resume_text: renderResumeText(resume),
      evidence_claims: claims.map((c) => `- ${c}`).join('\n') || '- none beyond the résumé',
    }),
    schema: TAILOR_SCHEMA,
    parse: (raw, baseline) => {
      if (!raw || typeof raw !== 'object' || typeof raw.summary !== 'string') throw new Error('malformed');
      // Merge the model's rewrites onto the real résumé, matching roles by
      // company+title so employment history can never be replaced wholesale.
      const experience = resume.experience.map((role) => {
        const rewritten = (raw.experience ?? []).find(
          (r) => r?.company?.toLowerCase() === role.company.toLowerCase() && r?.title?.toLowerCase() === role.title.toLowerCase(),
        );
        return rewritten?.bullets?.length ? { ...role, bullets: rewritten.bullets.filter((b) => typeof b === 'string') } : role;
      });
      const content: ResumeContent = {
        ...resume,
        headline: raw.headline || resume.headline,
        summary: raw.summary || resume.summary,
        skills: Array.isArray(raw.skills) && raw.skills.length ? raw.skills.filter((s) => typeof s === 'string') : resume.skills,
        experience,
      };
      return {
        resumeText: '',
        resumeContent: content,
        coverLetter: typeof raw.coverLetter === 'string' ? raw.coverLetter : baseline.coverLetter,
        notes: {
          summaryRewritten: true,
          bulletsAdjusted: experience.filter((role, i) => role.bullets !== resume.experience[i]?.bullets).length,
          skillsReordered: true,
          keywordsInjected: analysis.missingKeywords.filter((k) => content.skills.some((s) => s.toLowerCase() === k.toLowerCase())),
          atsScore: Math.max(0, Math.min(100, Number.isFinite(raw.atsScore) ? Math.round(raw.atsScore) : baseline.notes.atsScore)),
          changes: Array.isArray(raw.changes) && raw.changes.length ? raw.changes.filter((c) => typeof c === 'string') : baseline.notes.changes,
        },
      };
    },
    ground: (candidate, baseline) => {
      const { documents, report } = groundTailoredDocuments(candidate, baseline, resume, job, claims);
      return {
        value: { ...documents, resumeText: renderResumeText(documents.resumeContent) },
        rejected: report.violations.length,
      };
    },
    annotate: (value, _route, reason) => ({
      ...value,
      notes: { ...value.notes, changes: [...value.notes.changes, DEGRADE_NOTICE[reason]] },
    }),
  });
}

// --- prepare_interview ------------------------------------------------------------

const INTERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          category: { type: 'string', enum: ['behavioural', 'technical', 'situational', 'culture', 'closing'] },
          suggestedAnswer: { type: 'string' },
          tips: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'category', 'suggestedAnswer', 'tips'],
        additionalProperties: false,
      },
    },
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          situation: { type: 'string' },
          task: { type: 'string' },
          action: { type: 'string' },
          result: { type: 'string' },
          mapsTo: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'situation', 'task', 'action', 'result', 'mapsTo'],
        additionalProperties: false,
      },
    },
    companyResearch: { type: 'string' },
    questionsToAsk: { type: 'array', items: { type: 'string' } },
  },
  required: ['questions', 'stories', 'companyResearch', 'questionsToAsk'],
  additionalProperties: false,
};

export async function prepareInterview(ctx: GenerationContext, resume: ResumeContent, job: JobContext): Promise<GatewayResult<InterviewPrepPackage>> {
  const claims = ctx.evidence?.claims ?? [];
  return execute<InterviewPrepPackage, InterviewPrepPackage>(ctx, {
    task: 'prepare_interview',
    payload: { resume, job, claims },
    deterministic: () => engine().prepareInterview(resume, job),
    variables: () => ({
      job_block: jobBlock(job),
      resume_json: JSON.stringify(resume, null, 2),
      resume_text: renderResumeText(resume),
      evidence_claims: claims.map((c) => `- ${c}`).join('\n') || '- none beyond the résumé',
    }),
    schema: INTERVIEW_SCHEMA,
    parse: (raw) => {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.questions) || !Array.isArray(raw.stories)) throw new Error('malformed');
      return raw;
    },
    ground: (candidate, baseline) => {
      const { pack, report } = groundInterviewPack(candidate, baseline, resume, job, claims);
      return { value: pack, rejected: report.violations.length };
    },
  });
}

// --- compose (Stage 09) ---------------------------------------------------------------

const COMPOSE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

/**
 * A short message about a posting — application note, recruiter
 * introduction, outreach, follow-up, thank-you. The deterministic engine's
 * template is the baseline; a model's draft is checked in letter scope
 * (the posting's name, location and skill vocabulary are allowed, its free
 * text is not, and only this year's number) and replaced by the baseline
 * on any unevidenced claim.
 */
export async function compose(ctx: GenerationContext, kind: MessageKind, resume: ResumeContent, job: JobContext, analysis: MatchAnalysis): Promise<GatewayResult<string>> {
  const claims = ctx.evidence?.claims ?? [];
  return execute<string, { text?: unknown }>(ctx, {
    task: 'compose',
    payload: { kind, resume, job, analysis, claims },
    deterministic: () => engine().compose(kind, resume, job, analysis),
    variables: (baseline) => ({
      message_kind: kind,
      job_block: jobBlock(job),
      resume_text: renderResumeText(resume),
      evidence_claims: claims.map((c) => `- ${c}`).join('\n') || '- none beyond the résumé',
      baseline_message: baseline,
    }),
    schema: COMPOSE_SCHEMA,
    parse: (raw) => {
      if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('malformed');
      return raw.text.trim();
    },
    ground: (candidate, baseline) => {
      const violations = findViolations('message', candidate, buildCorpus(resume, claims), allowedContext(job, resume, 'letter'), new Set([String(new Date().getFullYear())]), true);
      return violations.length ? { value: baseline, rejected: violations.length } : { value: candidate, rejected: 0 };
    },
  });
}

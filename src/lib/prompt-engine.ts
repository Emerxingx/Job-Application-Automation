import { getPayload } from 'payload';
import config from '@payload-config';
import { getCache } from '@/lib/cache';
import {
  MissingPromptVariablesError,
  interpolate,
  missingVariables,
} from '@/lib/prompt-interpolate';

export { MissingPromptVariablesError } from '@/lib/prompt-interpolate';

/**
 * Prompt interpolation engine.
 *
 * Fetches a versioned prompt from the CMS registry by slug, checks that the
 * caller supplied every variable the prompt declares, and substitutes them —
 * then hands back a ready-to-send system/user message pair plus the model and
 * parameters the operator chose. The LLM orchestrator never hard-codes a
 * prompt; it asks for one by slug and gets whatever version an operator has
 * marked default.
 *
 * Two safety properties this enforces, both of which a naive `.replace()`
 * would miss:
 *
 *   1. Missing-variable is a hard error, not a silent gap. A prompt that
 *      declares {{job_description}} but is called without one would otherwise
 *      send the literal text "{{job_description}}" to the model — quietly
 *      degrading every generation. `renderPrompt` throws instead.
 *
 *   2. Substitution is non-recursive and single-pass. A value that itself
 *      contains "{{...}}" (a résumé that literally mentions a placeholder, or
 *      an injection attempt) is inserted verbatim and never re-scanned, so a
 *      user-supplied value can't smuggle in another variable's content or
 *      cause unbounded expansion.
 */

export interface RenderedPrompt {
  slug: string;
  version: number;
  modelProvider: string;
  targetModel: string;
  systemPrompt: string;
  userPrompt: string | null;
  modelParameters: Record<string, unknown>;
}

/** The registry document, narrowed to what this engine consumes. */
interface PromptDoc {
  promptSlug: string;
  version: number;
  modelProvider: string;
  targetModel: string;
  systemPrompt: string;
  userPromptTemplate?: string | null;
  requiredVariables?: { name?: string }[];
  modelParameters?: Record<string, unknown>;
}

const PROMPT_CACHE_TTL_SECONDS = 300;
const cacheKey = (slug: string) => `prompt:default:${slug}`;

export class PromptNotFoundError extends Error {
  constructor(slug: string) {
    super(`No default prompt found for slug "${slug}".`);
    this.name = 'PromptNotFoundError';
  }
}

/**
 * Fetch the default prompt for a slug (cache-first), validate the supplied
 * variables against what it declares, and return the interpolated result.
 *
 * @throws PromptNotFoundError        when no default version exists for the slug
 * @throws MissingPromptVariablesError when a declared variable was not supplied
 */
export async function renderPrompt(
  slug: string,
  variables: Record<string, string>,
): Promise<RenderedPrompt> {
  const doc = await getDefaultPrompt(slug);
  if (!doc) throw new PromptNotFoundError(slug);

  // 1. Validate: every declared variable must be supplied.
  const declared = (doc.requiredVariables ?? [])
    .map((v) => v?.name)
    .filter((n): n is string => Boolean(n));

  const missing = missingVariables(declared, variables);
  if (missing.length > 0) {
    throw new MissingPromptVariablesError(slug, missing);
  }

  // 2. Substitute, single-pass and non-recursive (see prompt-interpolate.ts).
  const systemPrompt = interpolate(doc.systemPrompt, variables);
  const userPrompt = doc.userPromptTemplate ? interpolate(doc.userPromptTemplate, variables) : null;

  return {
    slug: doc.promptSlug,
    version: doc.version,
    modelProvider: doc.modelProvider,
    targetModel: doc.targetModel,
    systemPrompt,
    userPrompt,
    modelParameters: doc.modelParameters ?? {},
  };
}

// --- fetch (cache-first) ---------------------------------------------------

async function getDefaultPrompt(slug: string): Promise<PromptDoc | null> {
  const cache = getCache();
  const key = cacheKey(slug);

  try {
    const cached = await cache.get(key);
    if (cached !== null) {
      return cached === '__none__' ? null : (JSON.parse(cached) as PromptDoc);
    }
  } catch (error) {
    console.error('[prompt] cache read failed; reading through:', error);
  }

  const doc = await readDefaultFromDb(slug);

  try {
    await cache.set(key, doc ? JSON.stringify(doc) : '__none__', PROMPT_CACHE_TTL_SECONDS);
  } catch (error) {
    console.error('[prompt] cache write failed; continuing:', error);
  }

  return doc;
}

async function readDefaultFromDb(slug: string): Promise<PromptDoc | null> {
  const payload = await getPayload({ config });
  const result = await payload.find({
    collection: 'prompt-registry',
    where: {
      and: [{ promptSlug: { equals: slug } }, { isDefault: { equals: true } }],
    },
    limit: 1,
    depth: 0,
    pagination: false,
  });

  const doc = result.docs[0] as unknown as PromptDoc | undefined;
  return doc ?? null;
}

/** Drop a slug's cached prompt. Wired into the registry's afterChange hook. */
export async function invalidatePrompt(slug: string): Promise<void> {
  try {
    await getCache().del(cacheKey(slug));
  } catch (error) {
    console.error('[prompt] cache invalidation failed:', error);
  }
}

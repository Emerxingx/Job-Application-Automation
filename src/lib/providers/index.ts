import { MockJobProvider } from './jobs/mock';
import type { JobProvider } from './jobs/types';
import { MockAIProvider } from './ai/mock';
import type { AIProvider, ExternalModelProvider } from './ai/types';

export type { JobProvider } from './jobs/types';
export type { AIProvider, ExternalModelProvider, CompletionRequest, JobContext } from './ai/types';
export { getPaymentProvider } from './payments';
export type { PaymentProvider } from './payments';

let jobProvider: JobProvider | null = null;
let engine: AIProvider | null = null;
let external: ExternalModelProvider | null | undefined;

/**
 * Resolve the configured job source. Falls back to the mock provider so the
 * app always runs, and logs when a requested provider isn't wired up yet.
 */
export function getJobProvider(): JobProvider {
  if (jobProvider) return jobProvider;

  const configured = (process.env.JOB_PROVIDER || 'mock').toLowerCase();

  if (configured === 'adzuna') {
    if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
      console.warn(
        '[providers] JOB_PROVIDER=adzuna but ADZUNA_APP_ID/ADZUNA_APP_KEY are unset; using the mock source.',
      );
    } else {
      // Required lazily so the live source never loads in mock deployments.
      const { AdzunaJobProvider } = require('./jobs/adzuna') as typeof import('./jobs/adzuna');
      jobProvider = new AdzunaJobProvider();
      return jobProvider;
    }
  } else if (configured !== 'mock') {
    console.warn(
      `[providers] JOB_PROVIDER="${configured}" is not implemented yet; using the mock source.`,
    );
  }

  jobProvider = new MockJobProvider();
  return jobProvider;
}

/** Test seam — clears the memoized providers. */
export function resetProviders(): void {
  jobProvider = null;
  engine = null;
  external = undefined;
}

/**
 * The deterministic engine. Always available, needs no configuration, and is
 * the engine of record: the gateway runs it for every task and uses its output
 * as the grounded baseline (see `src/lib/ai/gateway.ts`).
 */
export function getDeterministicEngine(): AIProvider {
  if (!engine) engine = new MockAIProvider();
  return engine;
}

/**
 * The external model provider, or null when none is configured. A null here is
 * a normal state, not an error: the gateway records the run as `degraded` when
 * the tenant's policy would have permitted an external model and none exists.
 *
 * Only the gateway calls this. Nothing else in the codebase may hold a
 * reference to an external provider (tests/ai-gateway.test.ts, static part).
 */
export function getExternalModelProvider(): ExternalModelProvider | null {
  if (external !== undefined) return external;

  const configured = (process.env.AI_PROVIDER || 'mock').toLowerCase();
  if (configured === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn(
        '[providers] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset; external generation is unavailable and every run will be recorded as degraded or deterministic.',
      );
      external = null;
    } else {
      // Required lazily so the SDK never loads in deployments without a key.
      const { AnthropicModelProvider } = require('./ai/anthropic') as typeof import('./ai/anthropic');
      external = new AnthropicModelProvider();
    }
  } else {
    if (configured !== 'mock') {
      console.warn(`[providers] AI_PROVIDER="${configured}" is not implemented; external generation is unavailable.`);
    }
    external = null;
  }
  return external;
}

/**
 * Test seam — install a fake external provider so the gateway's routing and
 * grounding can be exercised without a network or a key. Pass null to model
 * "permitted but unavailable".
 */
export function setExternalModelProviderForTests(provider: ExternalModelProvider | null): void {
  external = provider;
}

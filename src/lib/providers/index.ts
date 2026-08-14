import { MockJobProvider } from './jobs/mock';
import type { JobProvider } from './jobs/types';
import { MockAIProvider } from './ai/mock';
import type { AIProvider } from './ai/types';

export type { JobProvider } from './jobs/types';
export type { AIProvider, JobContext } from './ai/types';
export { getPaymentProvider } from './payments';
export type { PaymentProvider } from './payments';

let jobProvider: JobProvider | null = null;
let aiProvider: AIProvider | null = null;

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
  aiProvider = null;
}

/** Resolve the configured intelligence layer. */
export function getAIProvider(): AIProvider {
  if (aiProvider) return aiProvider;

  const configured = (process.env.AI_PROVIDER || 'mock').toLowerCase();

  if (configured === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn(
        '[providers] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset; using the local engine.',
      );
    } else {
      // Required lazily so the SDK never loads in mock deployments.
      const { AnthropicAIProvider } = require('./ai/anthropic') as typeof import('./ai/anthropic');
      aiProvider = new AnthropicAIProvider();
      return aiProvider;
    }
  }

  aiProvider = new MockAIProvider();
  return aiProvider;
}

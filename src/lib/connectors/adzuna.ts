import type { JobSearchQuery } from '@/lib/types';
import { AdzunaJobProvider } from '@/lib/providers/jobs/adzuna';
import { applicationRouteFor, normalizePosting, validatePosting } from './base';
import type { DiscoveredPosting, HealthReport, JobSourceConnector, NormalizedPosting, RefreshState } from './types';

/**
 * Adzuna, through its documented search API (ADR-0008 class 5, licensed
 * aggregation). Honest about what the API offers: there is no fetch-by-id
 * and no closure signal, so `fetch` re-searches and `refresh` answers
 * `unknown` for anything it cannot see again — the pipeline never marks a
 * posting closed on Adzuna's silence.
 *
 * IMPLEMENTED-NOT-VALIDATED: no request has been made with a live key from
 * this codebase. The contract suite runs it against a recorded fixture.
 */
export class AdzunaConnector implements JobSourceConnector {
  readonly key = 'adzuna';
  readonly name = 'Adzuna (search API)';
  readonly kind = 'aggregator' as const;
  readonly credentialEnvVars: readonly string[] = ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'];
  private readonly provider: AdzunaJobProvider;

  constructor(provider = new AdzunaJobProvider()) {
    this.provider = provider;
  }

  discover(query: JobSearchQuery): Promise<DiscoveredPosting[]> {
    return this.provider.search(query);
  }
  async fetch(_externalId: string): Promise<DiscoveredPosting | null> {
    // No by-id endpoint in the documented API; the posting stays as captured.
    void _externalId;
    return null;
  }
  normalize(raw: DiscoveredPosting): NormalizedPosting {
    return normalizePosting(raw);
  }
  validate(posting: NormalizedPosting) {
    return validatePosting(posting);
  }
  async refresh(externalIds: string[]): Promise<Record<string, RefreshState>> {
    return Object.fromEntries(externalIds.map((id) => [id, 'unknown' as const]));
  }
  async detectClosed(_externalId: string): Promise<RefreshState> {
    void _externalId;
    return 'unknown';
  }
  getApplicationRoute(posting: NormalizedPosting) {
    return applicationRouteFor(posting);
  }
  async healthCheck(): Promise<HealthReport> {
    const started = Date.now();
    try {
      const n = (await this.provider.search({ titles: ['analyst'], locations: [], country: 'CA', limit: 1 })).length;
      return { status: 'ok', latencyMs: Date.now() - started, detail: `search responded with ${n} posting(s)` };
    } catch (error) {
      return { status: 'down', latencyMs: Date.now() - started, detail: error instanceof Error ? error.message.slice(0, 120) : 'request failed' };
    }
  }
}

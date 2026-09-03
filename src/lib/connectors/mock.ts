import type { JobSearchQuery } from '@/lib/types';
import { MockJobProvider } from '@/lib/providers/jobs/mock';
import { applicationRouteFor, normalizePosting, validatePosting } from './base';
import type { DiscoveredPosting, HealthReport, JobSourceConnector, NormalizedPosting, RefreshState } from './types';

/**
 * The built-in synthetic source. No network, no personal data, deterministic
 * — the reason a clean clone boots with nothing configured. It is the only
 * connector enabled by default, and its register row says exactly that.
 */
export class MockConnector implements JobSourceConnector {
  readonly key = 'mock';
  readonly name = 'Built-in synthetic catalogue';
  readonly kind = 'mock' as const;
  readonly credentialEnvVars: readonly string[] = [];
  private readonly provider = new MockJobProvider();

  discover(query: JobSearchQuery): Promise<DiscoveredPosting[]> {
    return this.provider.search(query);
  }
  async fetch(externalId: string): Promise<DiscoveredPosting | null> {
    return this.provider.all().find((p) => p.externalId === externalId) ?? null;
  }
  normalize(raw: DiscoveredPosting): NormalizedPosting {
    return normalizePosting(raw);
  }
  validate(posting: NormalizedPosting) {
    return validatePosting(posting);
  }
  async refresh(externalIds: string[]): Promise<Record<string, RefreshState>> {
    // The catalogue is the whole world for a mock id, so absence from it IS
    // closure. An id that is not a mock id at all is one this source cannot
    // know anything about, and the honest answer is `unknown`, never
    // `closed` — the contract forbids inferring closure from silence.
    const live = new Set(this.provider.all().map((p) => p.externalId));
    return Object.fromEntries(externalIds.map((id) => [id, !id.startsWith('mock-') ? 'unknown' : live.has(id) ? 'active' : 'closed']));
  }
  async detectClosed(externalId: string): Promise<RefreshState> {
    return (await this.refresh([externalId]))[externalId] ?? 'unknown';
  }
  getApplicationRoute(posting: NormalizedPosting) {
    return applicationRouteFor(posting);
  }
  async healthCheck(): Promise<HealthReport> {
    const started = Date.now();
    const n = this.provider.all().length;
    return { status: 'ok', latencyMs: Date.now() - started, detail: `catalogue holds ${n} posting(s)` };
  }
}

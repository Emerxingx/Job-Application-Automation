import type { ConnectionKind, EventSummary, MailboxConnector, MailboxProvider, SyncPage, ThreadSummary, TokenSet } from './types';
import { requestedScopes } from './types';

/**
 * Stage 11 — the fixture-backed connector. It is what the tests and a clean
 * clone run against; it never talks to a network. Threads and events are
 * supplied at construction (the labelled corpus in tests, an empty set by
 * default), the "OAuth" flow returns a token for a fictitious account, and
 * revocation is recorded so a test can assert it was asked for.
 */
export interface MockMailboxData {
  accountEmail: string;
  threads: ThreadSummary[];
  events: EventSummary[];
}

const PAGE = 10;

export class MockMailboxConnector implements MailboxConnector {
  readonly provider: MailboxProvider;
  readonly configured = true;
  revoked = 0;
  constructor(provider: MailboxProvider, private readonly data: MockMailboxData = { accountEmail: 'mock@example.test', threads: [], events: [] }) {
    this.provider = provider;
  }
  authorizeUrl(kind: ConnectionKind, state: string, redirectUri: string): string {
    const scopes = requestedScopes(this.provider, kind).join(' ');
    return `mock://${this.provider}/authorize?scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(code: string): Promise<TokenSet> {
    if (!code.startsWith('mock-code:')) throw new Error('mock: invalid code');
    const kind = (code.slice('mock-code:'.length) || 'mail') as ConnectionKind;
    return { accessToken: `mock-access-${this.provider}`, refreshToken: `mock-refresh-${this.provider}`, expiresAt: new Date(Date.now() + 3600_000), scopes: [...requestedScopes(this.provider, kind)], accountEmail: this.data.accountEmail };
  }
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    return { ...tokens, accessToken: `${tokens.accessToken}-refreshed`, expiresAt: new Date(Date.now() + 3600_000) };
  }
  async listThreads(_tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<ThreadSummary>> {
    return page(this.data.threads.filter((t) => t.lastMessageAt >= since), cursor);
  }
  async listEvents(_tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<EventSummary>> {
    return page(this.data.events.filter((e) => e.startsAt >= since), cursor);
  }
  async revoke(): Promise<void> {
    this.revoked += 1;
  }
}

function page<T>(items: T[], cursor: string | null): SyncPage<T> {
  const offset = cursor ? Number(cursor) : 0;
  const slice = items.slice(offset, offset + PAGE);
  const next = offset + PAGE < items.length ? String(offset + PAGE) : null;
  return { items: slice, cursor: next };
}

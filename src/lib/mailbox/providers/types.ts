/**
 * Stage 11 — the mailbox / calendar connector contract and the scope
 * inventory. Least privilege by construction: the metadata scopes support
 * association (headers, participants, dates) and are the only scopes a
 * connection asks for; the content scopes exist as a SEPARATE, incremental
 * grant behind their own consent purpose and no code path in Stage 11
 * requests them.
 */
export type MailboxProvider = 'google' | 'microsoft';
export type ConnectionKind = 'mail' | 'calendar';

export const SCOPE_INVENTORY: Record<MailboxProvider, Record<ConnectionKind, { metadata: readonly string[]; content: readonly string[] }>> = {
  google: {
    mail: {
      metadata: ['https://www.googleapis.com/auth/gmail.metadata'],
      content: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
    calendar: {
      metadata: ['https://www.googleapis.com/auth/calendar.events.readonly'],
      content: [],
    },
  },
  microsoft: {
    mail: {
      metadata: ['Mail.ReadBasic', 'offline_access'],
      content: ['Mail.Read'],
    },
    calendar: {
      metadata: ['Calendars.Read', 'offline_access'],
      content: [],
    },
  },
};

/** What a connection may ask for today: metadata only. */
export function requestedScopes(provider: MailboxProvider, kind: ConnectionKind): readonly string[] {
  return SCOPE_INVENTORY[provider][kind].metadata;
}

export interface ThreadSummary {
  providerThreadId: string;
  subject: string;
  participants: string[];
  from: string;
  lastMessageAt: Date;
  hasCalendarInvite: boolean;
  messages: { providerMessageId: string; from: string; sentAt: Date; direction: 'inbound' | 'outbound' }[];
}

export interface EventSummary {
  providerEventId: string;
  title: string;
  organiser: string;
  startsAt: Date;
  endsAt: Date;
  attendees: string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  /** The scopes the provider actually granted. */
  scopes: string[];
  accountEmail: string;
}

export interface SyncPage<T> {
  items: T[];
  /** Opaque cursor (Gmail historyId, Graph delta link, fixture offset). */
  cursor: string | null;
}

/**
 * The connector. Every method takes the token set explicitly — the
 * connector holds no state and never sees the encryption key. `authorizeUrl`
 * and `exchangeCode` implement the OAuth code flow; `revoke` asks the
 * provider to invalidate the grant (best effort; the platform's purge does
 * not depend on it).
 */
export interface MailboxConnector {
  readonly provider: MailboxProvider;
  /** Whether the real client credentials are configured; a mock is always ready. */
  readonly configured: boolean;
  authorizeUrl(kind: ConnectionKind, state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  listThreads(tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<ThreadSummary>>;
  listEvents(tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<EventSummary>>;
  revoke(tokens: TokenSet): Promise<void>;
}

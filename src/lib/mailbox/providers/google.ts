import type { ConnectionKind, EventSummary, MailboxConnector, SyncPage, ThreadSummary, TokenSet } from './types';
import { requestedScopes } from './types';

/**
 * Stage 11 — Google (Gmail metadata + Calendar read-only) connector.
 *
 * IMPLEMENTED-NOT-VALIDATED: no client id or secret exists in this
 * environment and no request has been made to Google from this codebase
 * (INTEGRATION_REGISTER.md). Gmail is read with `format=metadata` and the
 * headers the association needs (From, To, Cc, Subject, Date) — the
 * `gmail.metadata` scope cannot return a body at all, which is the point.
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export function readGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload?: { headers?: GmailHeader[]; mimeType?: string; parts?: { mimeType?: string }[] };
}

function header(m: GmailMessage, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function parseAddresses(value: string): string[] {
  return [...value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
}

export class GoogleMailboxConnector implements MailboxConnector {
  readonly provider = 'google' as const;
  readonly configured: boolean;
  constructor(
    private readonly config: GoogleConfig | null = readGoogleConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.configured = config !== null;
  }
  private require(): GoogleConfig {
    if (!this.config) throw new Error('Google OAuth is not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).');
    return this.config;
  }
  authorizeUrl(kind: ConnectionKind, state: string, redirectUri: string): string {
    const { clientId } = this.require();
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', scope: requestedScopes('google', kind).join(' '), state });
    return `${AUTH}?${q}`;
  }
  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    const { clientId, clientSecret } = this.require();
    const res = await this.fetchImpl(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
    if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    const profile = await this.fetchImpl(`${GMAIL}/profile`, { headers: { Authorization: `Bearer ${body.access_token}` } });
    const email = profile.ok ? ((await profile.json()) as { emailAddress?: string }).emailAddress ?? '' : '';
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null, scopes: (body.scope ?? '').split(' ').filter(Boolean), accountEmail: email.toLowerCase() };
  }
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    const { clientId, clientSecret } = this.require();
    if (!tokens.refreshToken) throw new Error('No refresh token; reconnect required.');
    const res = await this.fetchImpl(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ refresh_token: tokens.refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }) });
    if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    return { ...tokens, accessToken: body.access_token, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null };
  }
  async listThreads(tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<ThreadSummary>> {
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const q = new URLSearchParams({ maxResults: '25', q: `after:${Math.floor(since.getTime() / 1000)}` });
    if (cursor) q.set('pageToken', cursor);
    const list = await this.fetchImpl(`${GMAIL}/threads?${q}`, { headers: auth });
    if (!list.ok) throw new Error(`Gmail threads list failed (${list.status})`);
    const page = (await list.json()) as { threads?: { id: string }[]; nextPageToken?: string };
    const items: ThreadSummary[] = [];
    for (const t of page.threads ?? []) {
      const res = await this.fetchImpl(`${GMAIL}/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth });
      if (!res.ok) continue;
      const thread = (await res.json()) as { id: string; messages?: GmailMessage[] };
      const messages = (thread.messages ?? []).map((m) => ({ providerMessageId: m.id, from: parseAddresses(header(m, 'From'))[0] ?? '', sentAt: new Date(Number(m.internalDate)), direction: (m.labelIds ?? []).includes('SENT') ? ('outbound' as const) : ('inbound' as const), participants: [...parseAddresses(header(m, 'From')), ...parseAddresses(header(m, 'To')), ...parseAddresses(header(m, 'Cc'))], subject: header(m, 'Subject'), invite: (m.payload?.mimeType ?? '').includes('calendar') || (m.payload?.parts ?? []).some((p) => (p.mimeType ?? '').includes('text/calendar')) }));
      if (!messages.length) continue;
      const last = messages.reduce((a, b) => (a.sentAt > b.sentAt ? a : b));
      items.push({ providerThreadId: thread.id, subject: messages[0].subject, participants: [...new Set(messages.flatMap((m) => m.participants))], from: last.from, lastMessageAt: last.sentAt, hasCalendarInvite: messages.some((m) => m.invite), messages: messages.map(({ providerMessageId, from, sentAt, direction }) => ({ providerMessageId, from, sentAt, direction })) });
    }
    return { items, cursor: page.nextPageToken ?? null };
  }
  async listEvents(tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<EventSummary>> {
    const q = new URLSearchParams({ maxResults: '50', singleEvents: 'true', orderBy: 'startTime', timeMin: since.toISOString() });
    if (cursor) q.set('pageToken', cursor);
    const res = await this.fetchImpl(`${CALENDAR}?${q}`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    if (!res.ok) throw new Error(`Calendar events list failed (${res.status})`);
    const page = (await res.json()) as { items?: { id: string; summary?: string; organizer?: { email?: string }; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { email?: string }[] }[]; nextPageToken?: string };
    const items: EventSummary[] = (page.items ?? []).map((e) => ({ providerEventId: e.id, title: e.summary ?? '', organiser: (e.organizer?.email ?? '').toLowerCase(), startsAt: new Date(e.start?.dateTime ?? e.start?.date ?? 0), endsAt: new Date(e.end?.dateTime ?? e.end?.date ?? 0), attendees: (e.attendees ?? []).map((a) => (a.email ?? '').toLowerCase()).filter(Boolean) }));
    return { items, cursor: page.nextPageToken ?? null };
  }
  async revoke(tokens: TokenSet): Promise<void> {
    await this.fetchImpl(`${REVOKE}?token=${encodeURIComponent(tokens.refreshToken ?? tokens.accessToken)}`, { method: 'POST' });
  }
}

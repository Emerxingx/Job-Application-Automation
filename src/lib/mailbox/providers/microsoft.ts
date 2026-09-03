import type { ConnectionKind, EventSummary, MailboxConnector, SyncPage, ThreadSummary, TokenSet } from './types';
import { requestedScopes } from './types';
import { parseAddresses } from './google';

/**
 * Stage 11 — Microsoft Graph (Mail.ReadBasic + Calendars.Read) connector.
 *
 * IMPLEMENTED-NOT-VALIDATED: no client id or secret exists in this
 * environment and no request has been made to Graph from this codebase
 * (INTEGRATION_REGISTER.md). Messages are read with `$select` limited to
 * headers; `Mail.ReadBasic` cannot return a body, which is the point.
 */
export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  tenant: string;
}

export function readMicrosoftConfig(env: NodeJS.ProcessEnv = process.env): MicrosoftConfig | null {
  const clientId = env.MICROSOFT_OAUTH_CLIENT_ID;
  const clientSecret = env.MICROSOFT_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret, tenant: env.MICROSOFT_OAUTH_TENANT || 'common' } : null;
}

const GRAPH = 'https://graph.microsoft.com/v1.0/me';

export class MicrosoftMailboxConnector implements MailboxConnector {
  readonly provider = 'microsoft' as const;
  readonly configured: boolean;
  constructor(
    private readonly config: MicrosoftConfig | null = readMicrosoftConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.configured = config !== null;
  }
  private require(): MicrosoftConfig {
    if (!this.config) throw new Error('Microsoft OAuth is not configured (MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET).');
    return this.config;
  }
  private base(): string {
    return `https://login.microsoftonline.com/${this.require().tenant}/oauth2/v2.0`;
  }
  authorizeUrl(kind: ConnectionKind, state: string, redirectUri: string): string {
    const { clientId } = this.require();
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: requestedScopes('microsoft', kind).join(' '), state });
    return `${this.base()}/authorize?${q}`;
  }
  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    const { clientId, clientSecret } = this.require();
    const res = await this.fetchImpl(`${this.base()}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
    if (!res.ok) throw new Error(`Microsoft token exchange failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    const me = await this.fetchImpl(`${GRAPH}?$select=mail,userPrincipalName`, { headers: { Authorization: `Bearer ${body.access_token}` } });
    const profile = me.ok ? ((await me.json()) as { mail?: string; userPrincipalName?: string }) : {};
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null, scopes: (body.scope ?? '').split(' ').filter(Boolean), accountEmail: (profile.mail ?? profile.userPrincipalName ?? '').toLowerCase() };
  }
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    const { clientId, clientSecret } = this.require();
    if (!tokens.refreshToken) throw new Error('No refresh token; reconnect required.');
    const res = await this.fetchImpl(`${this.base()}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refreshToken, grant_type: 'refresh_token' }) });
    if (!res.ok) throw new Error(`Microsoft token refresh failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return { ...tokens, accessToken: body.access_token, refreshToken: body.refresh_token ?? tokens.refreshToken, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null };
  }
  async listThreads(tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<ThreadSummary>> {
    const select = '$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isDraft,hasAttachments,meetingMessageType';
    const url = cursor ?? `${GRAPH}/messages?${select}&$filter=receivedDateTime ge ${since.toISOString()}&$orderby=receivedDateTime desc&$top=50`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    if (!res.ok) throw new Error(`Graph messages list failed (${res.status})`);
    const page = (await res.json()) as { value?: GraphMessage[]; '@odata.nextLink'?: string };
    const byThread = new Map<string, GraphMessage[]>();
    for (const m of page.value ?? []) {
      if (m.isDraft) continue;
      const key = m.conversationId ?? m.id;
      byThread.set(key, [...(byThread.get(key) ?? []), m]);
    }
    const items: ThreadSummary[] = [];
    for (const [conversationId, messages] of byThread) {
      const summaries = messages.map((m) => ({ providerMessageId: m.id, from: (m.from?.emailAddress?.address ?? '').toLowerCase(), sentAt: new Date(m.receivedDateTime ?? m.sentDateTime ?? 0), direction: (m.from?.emailAddress?.address ?? '').toLowerCase() === tokens.accountEmail ? ('outbound' as const) : ('inbound' as const), participants: [m.from?.emailAddress?.address ?? '', ...(m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? ''), ...(m.ccRecipients ?? []).map((r) => r.emailAddress?.address ?? '')].map((a) => a.toLowerCase()).filter(Boolean), invite: (m.meetingMessageType ?? 'none') !== 'none' }));
      const last = summaries.reduce((a, b) => (a.sentAt > b.sentAt ? a : b));
      items.push({ providerThreadId: conversationId, subject: messages[0].subject ?? '', participants: [...new Set(summaries.flatMap((s) => s.participants))], from: last.from, lastMessageAt: last.sentAt, hasCalendarInvite: summaries.some((s) => s.invite), messages: summaries.map(({ providerMessageId, from, sentAt, direction }) => ({ providerMessageId, from, sentAt, direction })) });
    }
    return { items, cursor: page['@odata.nextLink'] ?? null };
  }
  async listEvents(tokens: TokenSet, cursor: string | null, since: Date): Promise<SyncPage<EventSummary>> {
    const url = cursor ?? `${GRAPH}/calendarView?startDateTime=${encodeURIComponent(since.toISOString())}&endDateTime=${encodeURIComponent(new Date(since.getTime() + 180 * 86400_000).toISOString())}&$select=id,subject,organizer,start,end,attendees&$top=50`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    if (!res.ok) throw new Error(`Graph calendar view failed (${res.status})`);
    const page = (await res.json()) as { value?: { id: string; subject?: string; organizer?: { emailAddress?: { address?: string } }; start?: { dateTime?: string }; end?: { dateTime?: string }; attendees?: { emailAddress?: { address?: string } }[] }[]; '@odata.nextLink'?: string };
    const items: EventSummary[] = (page.value ?? []).map((e) => ({ providerEventId: e.id, title: e.subject ?? '', organiser: (e.organizer?.emailAddress?.address ?? '').toLowerCase(), startsAt: new Date(`${e.start?.dateTime ?? ''}Z`), endsAt: new Date(`${e.end?.dateTime ?? ''}Z`), attendees: (e.attendees ?? []).map((a) => (a.emailAddress?.address ?? '').toLowerCase()).filter(Boolean) }));
    return { items, cursor: page['@odata.nextLink'] ?? null };
  }
  async revoke(): Promise<void> {
    // Microsoft has no token-revocation endpoint for a single grant; the
    // platform's purge (delete the secret, derive nothing further) is the
    // revocation. The applicant removes the app under their Microsoft account.
  }
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isDraft?: boolean;
  meetingMessageType?: string;
}

export { parseAddresses };

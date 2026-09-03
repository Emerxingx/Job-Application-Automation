import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { signingSecret } from '../auth';
import type { ConnectionKind, MailboxProvider } from './providers/types';

/**
 * Stage 11 — the OAuth `state` parameter, signed. It binds the flow to the
 * signed-in user, the provider and the connection kind, carries a nonce and
 * a ten-minute expiry, and is verified in constant time on the callback, so
 * a callback cannot attach someone else's mailbox to this account (login
 * CSRF) or be replayed later. Nothing is stored server-side for it.
 */
export const OAUTH_STATE_TTL_SECONDS = 600;

export interface OAuthState {
  userId: string;
  provider: MailboxProvider;
  kind: ConnectionKind;
  nonce: string;
  expiresAt: number;
}

function mac(payload: string, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(`mailbox-oauth-state\n${payload}`).digest('base64url');
}

export function signOAuthState(input: Omit<OAuthState, 'nonce' | 'expiresAt'>, now = Date.now(), secret: Uint8Array = signingSecret()): string {
  const state: OAuthState = { ...input, nonce: randomBytes(12).toString('base64url'), expiresAt: Math.floor(now / 1000) + OAUTH_STATE_TTL_SECONDS };
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

export function verifyOAuthState(token: string, now = Date.now(), secret: Uint8Array = signingSecret()): OAuthState | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let state: OAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
  } catch {
    return null;
  }
  if (!state || typeof state.userId !== 'string' || !Number.isInteger(state.expiresAt)) return null;
  if (state.expiresAt * 1000 <= now) return null;
  return state;
}

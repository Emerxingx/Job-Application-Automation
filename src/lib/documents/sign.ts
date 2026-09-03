import { createHmac, timingSafeEqual } from 'node:crypto';
import { signingSecret } from '../auth';

/**
 * The link key is DERIVED from the session secret, never the secret itself
 * (the posture of src/lib/cms-secret.ts and src/lib/integrations/api-keys.ts:
 * one leaked or rotated primitive must not be two systems' primitive). A
 * document link and a session cookie therefore share a root but not a key.
 */
export function documentLinkKey(secret: Uint8Array = signingSecret()): Uint8Array {
  return createHmac('sha256', secret).update('jobpilot:document-link:v1').digest();
}

/**
 * Stage 09 — signed, expiring document links.
 *
 * A document is private by default: the only session-less way to fetch its
 * bytes is a link whose signature binds the document id, the owner's id and
 * an expiry to the server's signing secret. Ten minutes is enough to hand a
 * file to another device or a browser download and short enough that a
 * leaked link is worth little. The signature is verified in constant time,
 * expiry is checked AFTER the signature (an attacker learns nothing about a
 * forged link's validity from an "expired" answer), and the download route
 * still filters the row by the owner in the link — a signature over one
 * user's id cannot fetch another user's document.
 */
export const DOCUMENT_LINK_TTL_SECONDS = 600;

export interface DocumentLink {
  documentId: string;
  userId: string;
  /** Unix seconds. */
  expiresAt: number;
  signature: string;
}

function mac(documentId: string, userId: string, expiresAt: number, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(`document-link\n${documentId}\n${userId}\n${expiresAt}`).digest('base64url');
}

export function signDocumentLink(documentId: string, userId: string, now = Date.now(), ttlSeconds = DOCUMENT_LINK_TTL_SECONDS, secret: Uint8Array = documentLinkKey()): DocumentLink {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  return { documentId, userId, expiresAt, signature: mac(documentId, userId, expiresAt, secret) };
}

export function verifyDocumentLink(link: DocumentLink, now = Date.now(), secret: Uint8Array = documentLinkKey()): 'ok' | 'expired' | 'invalid' {
  if (!Number.isInteger(link.expiresAt) || typeof link.signature !== 'string') return 'invalid';
  const expected = Buffer.from(mac(link.documentId, link.userId, link.expiresAt, secret));
  const given = Buffer.from(link.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  if (link.expiresAt * 1000 <= now) return 'expired';
  return 'ok';
}

/** The relative URL a link is served at. */
export function documentLinkPath(link: DocumentLink): string {
  return `/api/documents/${encodeURIComponent(link.documentId)}/download?u=${encodeURIComponent(link.userId)}&exp=${link.expiresAt}&sig=${link.signature}`;
}

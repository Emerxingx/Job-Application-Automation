import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Stage 20 (ADR-0035) - encryption at rest for an organisation's OIDC client
 * secret. AES-256-GCM under `SSO_ENCRYPTION_KEY` (32 bytes, hex or base64).
 *
 * Deliberately a SEPARATE key from the mailbox one (Stage 11): a key names a
 * blast radius, and a leaked mailbox key must not unlock every enterprise
 * client secret, nor the reverse. The shape mirrors src/lib/mailbox/crypto.ts
 * on purpose - the same tag-authenticated ciphertext, the same key version
 * beside every row - so the rotation procedure is one procedure. A missing key
 * means no connection can be saved with a secret: the console says so instead
 * of storing a secret in the clear.
 */
export const SSO_KEY_ENV = 'SSO_ENCRYPTION_KEY';
export const CURRENT_SSO_KEY_VERSION = 1;

export class SsoKeyMissingError extends Error {
  readonly status = 503;
  constructor() {
    super(`${SSO_KEY_ENV} is not set to a 32-byte key; an SSO client secret cannot be stored on this deployment.`);
    this.name = 'SsoKeyMissingError';
  }
}

export interface EncryptedClientSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

/** The key from the environment, or null. Never logged, never returned to a caller that prints. */
export function ssoKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env[SSO_KEY_ENV];
  if (!raw) return null;
  try {
    const key = /^[0-9a-fA-F]{64}$/.test(raw.trim()) ? Buffer.from(raw.trim(), 'hex') : Buffer.from(raw.trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function encryptClientSecret(plaintext: string, key: Buffer | null = ssoKey()): EncryptedClientSecret {
  if (!key) throw new SsoKeyMissingError();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), keyVersion: CURRENT_SSO_KEY_VERSION };
}

export function decryptClientSecret(secret: EncryptedClientSecret, key: Buffer | null = ssoKey()): string {
  if (!key) throw new SsoKeyMissingError();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

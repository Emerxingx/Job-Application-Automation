import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Stage 11 — encryption at rest for mailbox and calendar OAuth tokens.
 *
 * AES-256-GCM under a key supplied by the environment
 * (`MAILBOX_ENCRYPTION_KEY`, 32 bytes, base64). The key never touches the
 * database or a log; a missing or malformed key means no real connection can
 * be made — the connector refuses to connect rather than storing a token in
 * the clear. `keyVersion` is stored beside each ciphertext so a rotation can
 * re-encrypt row by row. The authentication tag makes a tampered ciphertext
 * fail closed on decrypt.
 */
export const MAILBOX_KEY_ENV = 'MAILBOX_ENCRYPTION_KEY';
export const CURRENT_KEY_VERSION = 1;

export class MailboxKeyMissingError extends Error {
  constructor() {
    super(`${MAILBOX_KEY_ENV} is not set to a 32-byte base64 key; mailbox tokens cannot be stored.`);
    this.name = 'MailboxKeyMissingError';
  }
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

/** The key from the environment, or null when the platform cannot hold tokens. Never logged. */
export function mailboxKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env[MAILBOX_KEY_ENV];
  if (!raw) return null;
  try {
    // 64 hex characters or 44 base64 characters both name 32 bytes; anything else is not a key.
    const key = /^[0-9a-fA-F]{64}$/.test(raw.trim()) ? Buffer.from(raw.trim(), 'hex') : Buffer.from(raw.trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function encryptSecret(plaintext: string, key: Buffer | null = mailboxKey()): EncryptedSecret {
  if (!key) throw new MailboxKeyMissingError();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), keyVersion: CURRENT_KEY_VERSION };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer | null = mailboxKey()): string {
  if (!key) throw new MailboxKeyMissingError();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

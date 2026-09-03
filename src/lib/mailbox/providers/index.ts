import type { MailboxConnector, MailboxProvider } from './types';
import { GoogleMailboxConnector } from './google';
import { MicrosoftMailboxConnector } from './microsoft';
import { MockMailboxConnector } from './mock';

/**
 * Stage 11 — the connector registry, the provider pattern the rest of the
 * codebase uses: real adapters selected by configuration, a mock for tests
 * and a clean clone, and a loud refusal rather than a silent fallback for
 * a mailbox — a fake mailbox connection would be a lie to the applicant,
 * so unlike the job source there is NO warn-and-degrade to the mock in
 * production. `MAILBOX_CONNECTOR=mock` is honoured outside production only.
 */
const overrides = new Map<MailboxProvider, MailboxConnector>();

/** Test seam: serve this connector for the provider. */
export function setMailboxConnectorForTests(provider: MailboxProvider, connector: MailboxConnector | null): void {
  if (connector) overrides.set(provider, connector);
  else overrides.delete(provider);
}

export class MailboxNotConfiguredError extends Error {
  constructor(provider: MailboxProvider) {
    super(`${provider === 'google' ? 'Google' : 'Microsoft'} sign-in for mailbox and calendar access is not configured on this deployment.`);
    this.name = 'MailboxNotConfiguredError';
  }
}

export function getMailboxConnector(provider: MailboxProvider): MailboxConnector {
  const override = overrides.get(provider);
  if (override) return override;
  if ((process.env.MAILBOX_CONNECTOR || '').toLowerCase() === 'mock' && process.env.NODE_ENV !== 'production') return new MockMailboxConnector(provider);
  const real = provider === 'google' ? new GoogleMailboxConnector() : new MicrosoftMailboxConnector();
  if (!real.configured) throw new MailboxNotConfiguredError(provider);
  return real;
}

export function isMailboxProvider(value: unknown): value is MailboxProvider {
  return value === 'google' || value === 'microsoft';
}

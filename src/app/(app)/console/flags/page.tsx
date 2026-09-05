import { PageHeader } from '@/components/ui';
import { listFeatureFlags } from '@/lib/admin/feature-flags';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { FlagsAdmin } from './flags-admin';

export const metadata = { title: 'Feature flags' };
export const dynamic = 'force-dynamic';

/** /console/flags - the flags the CODE declares (ADR-0019 Tier 1): on/off, a deterministic percentage rollout, an allow-list. No flag names a security control. */
export default async function ConsoleFlagsPage() {
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;
  const flags = await listFeatureFlags();
  return (
    <>
      <PageHeader title="Feature flags" description="Only a flag declared in code can be set here, and the declaration names where it is read. A flag reveals or hides a product feature; no authentication, session, isolation, consent or apply-mode rule reads one (ADR-0019). Rollouts are deterministic per account. Every change is re-authenticated and audited." />
      <FlagsAdmin canChange={gate.staff.role === 'admin'} flags={flags.map((f) => ({ key: f.key, description: f.description, readBy: f.readBy, defaultEnabled: f.defaultEnabled, stored: f.stored ? { enabled: f.stored.enabled, rolloutPercent: f.stored.rolloutPercent, allowlist: f.stored.allowlist, updatedAt: f.stored.updatedAt.toISOString() } : null }))} />
    </>
  );
}

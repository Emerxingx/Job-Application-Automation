import { redirect } from 'next/navigation';
import { requireTenant } from '@/lib/tenancy/request';
import { quantityFor } from '@/lib/entitlements/service';
import { PageHeader } from '@/components/ui';
import { AgentForm } from '@/components/agent-form';

export const metadata = { title: 'New agent' };

export default async function NewAgentPage() {
  const { user, run } = await requireTenant();

  // Don't render a form the plan won't accept.
  const maxAgents = await run((tx) => quantityFor(tx, user.id, 'agents'));
  const count = await run((tx) => tx.agent.count({ where: { userId: user.id } }));
  if (count >= maxAgents) redirect('/dashboard/billing');

  return (
    <>
      <PageHeader
        title="Create a job agent"
        description="Tell your agent what to hunt for. It will scan live postings and score each one against your resume."
      />
      <AgentForm defaultLocation={user.city ?? ''} />
    </>
  );
}

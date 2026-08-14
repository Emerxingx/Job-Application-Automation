import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { PageHeader } from '@/components/ui';
import { AgentForm } from '@/components/agent-form';

export const metadata = { title: 'New agent' };

export default async function NewAgentPage() {
  const user = await requireUser();

  // Don't render a form the plan won't accept.
  const maxAgents = user.subscription?.plan.maxAgents ?? 1;
  const count = await db.agent.count({ where: { userId: user.id } });
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

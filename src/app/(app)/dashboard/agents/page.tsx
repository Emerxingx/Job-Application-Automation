import Link from 'next/link';
import { Plus, Radar } from 'lucide-react';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { parseJson } from '@/lib/types';
import { Card, EmptyState, PageHeader, StatusBadge, formatRelative } from '@/components/ui';
import { ScanButton } from '@/components/scan-button';
import { AgentActions } from '@/components/agent-actions';

export const metadata = { title: 'Job agents' };
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const user = await requireUser();

  const agents = await db.agent.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { matches: true, applications: true } } },
  });

  const maxAgents = user.subscription?.plan.maxAgents ?? 1;
  const atLimit = agents.length >= maxAgents;

  return (
    <>
      <PageHeader
        title="Job agents"
        description="Each agent hunts a different career track. They scan live postings and score every result against your resume."
        action={
          atLimit ? (
            <Link href="/dashboard/billing" className="btn-secondary">
              Upgrade for more agents
            </Link>
          ) : (
            <Link href="/dashboard/agents/new" className="btn-primary">
              <Plus className="h-4 w-4" />
              New agent
            </Link>
          )
        }
      />

      {agents.length === 0 ? (
        <EmptyState
          icon={<Radar className="h-5 w-5" />}
          title="No agents yet"
          description="Create your first agent with the job titles you want. It will scan live postings and score each one against your experience."
          action={
            <Link href="/dashboard/agents/new" className="btn-primary">
              <Plus className="h-4 w-4" />
              Create your first agent
            </Link>
          }
        />
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            Using {agents.length} of {maxAgents} agent{maxAgents === 1 ? '' : 's'} on your{' '}
            {user.subscription?.plan.name ?? 'current'} plan.
          </p>

          <ul className="space-y-4">
            {agents.map((agent) => {
              const titles = parseJson<string[]>(agent.titles, []);
              const locations = parseJson<string[]>(agent.locations, []);

              return (
                <Card as="li" key={agent.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold text-ink">{agent.name}</h2>
                        <StatusBadge status={agent.status} />
                        {agent.autoApply && (
                          <span className="chip bg-brand-500/10 text-brand-600">
                            Auto-apply above {agent.autoApplyThreshold}%
                          </span>
                        )}
                      </div>

                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {titles.map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                      </div>

                      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
                        <div className="flex gap-1">
                          <dt className="text-faint">Locations:</dt>
                          <dd>{locations.join(', ') || 'Anywhere'}</dd>
                        </div>
                        <div className="flex gap-1">
                          <dt className="text-faint">Min match:</dt>
                          <dd>{agent.minMatchScore}%</dd>
                        </div>
                        <div className="flex gap-1">
                          <dt className="text-faint">Scans:</dt>
                          <dd>{agent.scanFrequency.replace(/_/g, ' ')}</dd>
                        </div>
                        <div className="flex gap-1">
                          <dt className="text-faint">Last scan:</dt>
                          <dd>{agent.lastScanAt ? formatRelative(agent.lastScanAt) : 'Never'}</dd>
                        </div>
                      </dl>

                      <div className="mt-3 flex gap-4 text-sm">
                        <span className="text-muted">
                          <strong className="font-semibold text-ink">{agent._count.matches}</strong>{' '}
                          matches found
                        </span>
                        <span className="text-muted">
                          <strong className="font-semibold text-ink">
                            {agent._count.applications}
                          </strong>{' '}
                          applications sent
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <ScanButton agentId={agent.id} label="Scan now" variant="secondary" />
                      <AgentActions agentId={agent.id} status={agent.status} />
                    </div>
                  </div>
                </Card>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

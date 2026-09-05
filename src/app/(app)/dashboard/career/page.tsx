import Link from 'next/link';
import { Compass } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { analysisBudget, listPlans } from '@/lib/career/service';
import { loadedAttributions } from '@/lib/taxonomy/datasets';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { CareerPlanner } from '@/components/career-planner';

export const metadata = { title: 'Career transition' };
export const dynamic = 'force-dynamic';

/**
 * /dashboard/career - Stage 16 (ADR-0031). Versioned transition plans: what
 * transfers, what is missing (by kind), how hard, what the postings held here
 * say, and a pathway of licensed offerings with provenance on every step.
 * Nothing here predicts an outcome; the page says so.
 */
export default async function CareerPage() {
  const { user, run } = await requireTenant();
  const { plans, budget } = await run(async (tx) => ({ plans: await listPlans(tx, user.id), budget: await analysisBudget(tx, user.id) }));
  const attributions = await loadedAttributions();

  return (
    <>
      <PageHeader
        title="Career transition"
        description="Pick a target occupation and JobPilot compares it with your profile: the skills that transfer, the skills and credentials that are missing, how demanding the move is, and a pathway of licensed courses and credentials. Every step names the dataset it came from. No interview, hire or salary is predicted."
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <div className="space-y-6">
          <CareerPlanner remaining={budget.remaining} limit={budget.limit} unlimited={budget.unlimited} />
          <Card className="p-5 text-xs text-muted">
            <p className="font-medium text-ink">Where the data comes from</p>
            {attributions.length === 0 ? (
              <p className="mt-1">No occupation or learning dataset is loaded under a recorded licence yet, so the spine is empty and no offering can appear. An administrator records licences at /console/taxonomy.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {attributions.map((a) => (
                  <li key={a.key}>{a.attribution}</li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div>
          {plans.length === 0 ? (
            <EmptyState icon={<Compass className="h-5 w-5" />} title="No plan yet" description="Start an analysis on the left. The result is stored as a plan with milestones you can move as you progress; re-running it makes a new version rather than overwriting the old one." />
          ) : (
            <ul className="space-y-3">
              {plans.map((p) => (
                <li key={p.id}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={`/dashboard/career/${p.id}`} className="font-semibold text-ink hover:underline">
                        {p.title}
                      </Link>
                      <span className="text-xs text-faint">
                        v{p.version} · {p._count.milestones} milestone{p._count.milestones === 1 ? '' : 's'} · {p.createdAt.toLocaleDateString('en-CA')}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted">Engine {p.engineVersion}</p>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

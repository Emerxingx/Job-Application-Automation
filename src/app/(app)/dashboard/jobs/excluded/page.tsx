import Link from 'next/link';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { listExclusions } from '@/lib/eligibility/service';
import { exclusionReasons } from '@/lib/eligibility/engine';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export const metadata = { title: 'Excluded postings' };
export const dynamic = 'force-dynamic';

/**
 * Stage 07: every posting a hard eligibility rule kept out of the feed, with
 * the reason in words. Nothing is hidden silently: a candidate can always
 * see what was excluded and why, and fix the profile fact if it is wrong.
 */
export default async function ExcludedJobsPage() {
  const { user, run } = await requireTenant();
  const rows = await run((tx) => listExclusions(tx, user.id));

  return (
    <>
      <Link href="/dashboard/jobs" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />
        Job feed
      </Link>
      <PageHeader
        title="Excluded postings"
        description="Postings your agents found that a hard eligibility rule kept out of your feed. Each one says why. If a reason rests on a profile fact that is wrong, correct it under Settings and run a scan again."
      />
      {rows.length === 0 ? (
        <EmptyState icon={<ShieldOff className="h-5 w-5" />} title="Nothing excluded" description="No posting your agents found has been ruled out by an eligibility requirement." />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <Link href={`/dashboard/jobs/${r.job.id}`} className="font-semibold text-ink hover:underline">
                      {r.job.title}
                    </Link>
                    <p className="text-sm text-muted">
                      {r.job.company} · {r.job.location} · {r.job.workMode}
                      {r.job.activeState === 'closed' ? ' · closed' : ''}
                    </p>
                  </div>
                  <span className="text-xs text-faint">Checked {r.evaluatedAt.toLocaleDateString('en-CA')}</span>
                </div>
                <ul className="mt-2 space-y-1">
                  {exclusionReasons(r.verdict).map((reason, i) => (
                    <li key={i} className="text-sm text-danger">
                      {reason}
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

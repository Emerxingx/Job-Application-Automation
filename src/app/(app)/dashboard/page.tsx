import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { getQuota } from '@/lib/subscription';
import { getDashboardLayout } from '@/lib/cms';
import { PageHeader } from '@/components/ui';
import { ScanButton } from '@/components/scan-button';
import {
  renderDashboardWidget,
  widgetColumn,
  type DashboardData,
} from '@/components/dashboard-widgets';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

/**
 * Dashboard overview — the page shell.
 *
 * The shell owns everything a layout edit must never touch: authentication,
 * data loading (every query scoped to the signed-in user), and the page
 * chrome. Which widgets render, in what order, with what copy comes from the
 * CMS's dashboard-layout global — editable by staff in /admin with
 * drag-to-reorder — falling back to the built-in default layout when the CMS
 * has nothing. See src/components/dashboard-widgets/ for the widget library
 * and src/cms/blocks-dashboard.ts for what each widget exposes to editors.
 */
export default async function DashboardPage() {
  const user = await requireUser();

  const [layout, quota, agentCount, applicationCount, topMatches, events, submittedCount, interviewCount] =
    await Promise.all([
      getDashboardLayout(),
      getQuota(user.id),
      db.agent.count({ where: { userId: user.id } }),
      db.application.count({ where: { userId: user.id } }),
      db.jobMatch.findMany({
        where: { agent: { userId: user.id }, status: 'new' },
        orderBy: { matchScore: 'desc' },
        // The widget slices to its configured count; load enough for the max.
        take: 10,
        include: { job: true },
      }),
      db.activityEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      db.application.count({ where: { userId: user.id, status: 'submitted' } }),
      db.application.count({
        where: { userId: user.id, status: { in: ['interviewing', 'offer'] } },
      }),
    ]);

  const data: DashboardData = {
    firstName: user.fullName.split(' ')[0],
    quota,
    agentCount,
    applicationCount,
    submittedCount,
    interviewCount,
    topMatches,
    events,
    agents: [],
  };

  // Full-width widgets render in layout order; main/side widgets flow into
  // the two-column band, also in layout order within their column.
  const fullWidth = layout.filter((w) => widgetColumn(w.blockType) === 'full');
  const mainCol = layout.filter((w) => widgetColumn(w.blockType) === 'main');
  const sideCol = layout.filter((w) => widgetColumn(w.blockType) === 'side');

  return (
    <>
      <PageHeader
        title={`Welcome back, ${data.firstName}`}
        description="Here is where your search stands today."
        action={<ScanButton label="Scan all agents" />}
      />

      {fullWidth.map((w) => renderDashboardWidget(w, data))}

      {(mainCol.length > 0 || sideCol.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-3">
          {mainCol.map((w) => renderDashboardWidget(w, data))}
          {sideCol.length > 0 && (
            <section className="space-y-4">
              {sideCol.map((w) => renderDashboardWidget(w, data))}
            </section>
          )}
        </div>
      )}
    </>
  );
}

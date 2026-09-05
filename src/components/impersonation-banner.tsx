import { currentImpersonation } from '@/lib/auth';

/**
 * Stage 20 (ADR-0035): the banner a staff member sees on EVERY page while
 * impersonating - the dashboard, onboarding, settings, anywhere - naming who
 * is looking, when it ends, that nothing can be written, and the one way out.
 * Rendered by the root layout so no page can lack it (review M7).
 */
export async function ImpersonationBanner() {
  const impersonation = await currentImpersonation();
  if (!impersonation) return null;
  return (
    <div role="status" className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-ink">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <span>
          <strong>Support view (read-only).</strong> {impersonation.staffEmail} is viewing this account as the customer sees it until {impersonation.endsAt.toLocaleTimeString('en-CA', { timeZone: 'UTC' })} UTC. Nothing can be changed, and sensitive, case, mailbox and document data are not shown.
        </span>
        <form method="post" action="/api/console/impersonation/end">
          <button type="submit" className="btn-secondary text-xs">
            End impersonation
          </button>
        </form>
      </div>
    </div>
  );
}

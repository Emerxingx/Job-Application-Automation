import { redirect } from 'next/navigation';
import { consoleGate } from './guard';
import { AccessDenied } from './ui';
import { ConsoleShell } from './console-shell';

export const metadata = {
  title: { default: 'Console', template: '%s · JobPilot Console' },
  // Belt and braces of a different kind: even if a link leaks, nothing under
  // /console should end up in a search index.
  robots: { index: false, follow: false },
};

/**
 * Every page under /console reads other people's personal data — names, email
 * addresses, invoices, application history. This layout is the check that
 * cannot be forgotten: a page added to this directory tomorrow inherits it
 * without anybody remembering to write it.
 *
 * The pages check again themselves. That is not redundancy. Layouts are not
 * re-executed on every client-side navigation within a segment, and Route
 * Handlers (the invoice PDF, the CSV exports) never run layouts at all — so the
 * layout guarantees "no page renders without a gate", and the per-page gate
 * guarantees "no data is read without one".
 *
 * `force-dynamic` because the whole section is per-request, authenticated and
 * uncacheable; a statically rendered console page would be a served snapshot of
 * one customer's data.
 */
export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const gate = await consoleGate('support');

  if (!gate.ok) {
    // An anonymous visitor is sent to sign in; a signed-in customer is told
    // plainly. Bouncing someone who is already authenticated to a login form
    // reads as a broken app, and they would only arrive back here.
    if (!gate.signedIn) redirect('/login');
    return <AccessDenied />;
  }

  return (
    <ConsoleShell
      staff={{ fullName: gate.staff.fullName, email: gate.staff.email, role: gate.staff.role }}
    >
      {children}
    </ConsoleShell>
  );
}

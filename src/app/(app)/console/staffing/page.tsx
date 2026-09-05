import { ensureJurisdictionRegistry } from '@/lib/staffing/service';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { StaffingAdmin } from './staffing-admin';

export const metadata = { title: 'Staffing rules' };
export const dynamic = 'force-dynamic';

/** /console/staffing - the jurisdiction rules counsel recorded (L-4). Admin only. */
export default async function ConsoleStaffingPage() {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;
  const rows = await ensureJurisdictionRegistry();
  return (
    <>
      <PageHeader title="Staffing rules by jurisdiction" description="What counsel recorded for each jurisdiction the staffing product targets. Rules are data; the code asserts nothing about any jurisdiction." />
      <StaffingAdmin jurisdictions={rows.map((r) => ({ jurisdiction: r.jurisdiction, name: r.name, status: r.status, licenceRequired: r.licenceRequired, candidateFeesProhibited: r.candidateFeesProhibited, maxGuaranteeDays: r.maxGuaranteeDays, reference: r.reference, notes: r.notes, recordedByEmail: r.recordedByEmail, recordedAt: r.recordedAt?.toISOString() ?? null }))} />
    </>
  );
}

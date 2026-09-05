import { redirect } from 'next/navigation';
import { currentImpersonation, getCurrentUser } from '@/lib/auth';
import { getQuota } from '@/lib/subscription';
import { serviceProviderMemberships } from '@/lib/cases/service';
import { employerMemberships } from '@/lib/employer/service';
import { agencyMemberships } from '@/lib/staffing/service';
import { DashboardShell } from '@/components/dashboard-shell';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!user.onboardedAt) redirect('/onboarding');

  const [quota, providers, employers, agencies, impersonation] = await Promise.all([getQuota(user.id), serviceProviderMemberships(user.id), employerMemberships(user.id), agencyMemberships(user.id), currentImpersonation()]);

  return (
    <DashboardShell
      user={{ fullName: user.fullName, email: user.email }}
      showCases={providers.length > 0}
      showHiring={employers.length > 0}
      showStaffing={agencies.length > 0}
      impersonation={impersonation ? { staffEmail: impersonation.staffEmail, endsAt: impersonation.endsAt.toISOString() } : null}
      quota={
        quota && {
          used: quota.used,
          limit: quota.limit,
          planName: quota.planName,
          periodEnd: quota.periodEnd.toISOString(),
        }
      }
    >
      {children}
    </DashboardShell>
  );
}

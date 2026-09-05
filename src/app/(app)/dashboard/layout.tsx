import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { getQuota } from '@/lib/subscription';
import { serviceProviderMemberships } from '@/lib/cases/service';
import { DashboardShell } from '@/components/dashboard-shell';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!user.onboardedAt) redirect('/onboarding');

  const [quota, providers] = await Promise.all([getQuota(user.id), serviceProviderMemberships(user.id)]);

  return (
    <DashboardShell
      user={{ fullName: user.fullName, email: user.email }}
      showCases={providers.length > 0}
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

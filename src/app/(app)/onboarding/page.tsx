import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { parseJson } from '@/lib/types';
import type { ResumeContent } from '@/lib/types';
import { Logo } from '@/components/site-header';
import { OnboardingFlow } from '@/components/onboarding-flow';

export const metadata = { title: 'Get started' };

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.onboardedAt) redirect('/dashboard');

  const resume = await db.resume.findFirst({ where: { userId: user.id, isMaster: true } });
  const content = parseJson<ResumeContent | null>(resume?.content, null);

  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-4">
          <Logo />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <OnboardingFlow
          initialResume={
            content ?? {
              fullName: user.fullName,
              headline: user.headline ?? '',
              email: user.email,
              phone: user.phone ?? '',
              location: user.city ?? '',
              linkedinUrl: '',
              portfolioUrl: '',
              summary: '',
              skills: [],
              experience: [],
              education: [],
              certifications: [],
              projects: [],
            }
          }
          defaultLocation={user.city ?? ''}
        />
      </main>
    </div>
  );
}

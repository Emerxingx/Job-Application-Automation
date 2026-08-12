import { requireUser } from '@/lib/auth';
import { Card, PageHeader } from '@/components/ui';
import { SettingsForm } from '@/components/settings-form';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your profile details. These are used on applications and to filter jobs by region."
      />

      <SettingsForm
        initial={{
          fullName: user.fullName,
          email: user.email,
          phone: user.phone ?? '',
          city: user.city ?? '',
          country: user.country,
          headline: user.headline ?? '',
          linkedinUrl: user.linkedinUrl ?? '',
          portfolioUrl: user.portfolioUrl ?? '',
          workAuth: user.workAuth ?? '',
        }}
      />

      <Card className="mt-6 max-w-2xl p-6">
        <h2 className="font-semibold text-ink">Your data</h2>
        <p className="mt-1.5 text-sm text-muted">
          Every application folder — job descriptions, tailored resumes and cover letters — is
          stored against your account and downloadable from the application detail page. Deleting
          your account removes all of it.
        </p>
      </Card>
    </>
  );
}

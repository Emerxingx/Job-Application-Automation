import Link from 'next/link';
import { requireTenant } from '@/lib/tenancy/request';
import { parseJson } from '@/lib/types';
import { loadPreferences, loadWorkAuthorization } from '@/lib/candidate/preferences';
import { Card, PageHeader } from '@/components/ui';
import { SettingsForm } from '@/components/settings-form';
import { JobPreferencesForm, WorkAuthorizationForm } from '@/components/job-preferences-form';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { user, run } = await requireTenant();
  const [preferences, workAuthorization] = await run((tx) =>
    Promise.all([loadPreferences(tx, user.id), loadWorkAuthorization(tx, user.id)]),
  );
  const join = (json: string | undefined) => parseJson<string[]>(json, []).join(', ');

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

      <div className="mt-6">
        <JobPreferencesForm
          initial={{
            targetTitles: join(preferences?.targetTitles),
            adjacentTitles: join(preferences?.adjacentTitles),
            employmentTypes: parseJson<string[]>(preferences?.employmentTypes, []),
            workModes: parseJson<string[]>(preferences?.workModes, []),
            locations: join(preferences?.locations),
            countries: parseJson<string[]>(preferences?.countries, []),
            salaryMin: preferences?.salaryMinCents != null ? String(Math.round(preferences.salaryMinCents / 100)) : '',
            salaryCurrency: (preferences?.salaryCurrency as 'CAD' | 'USD') ?? 'CAD',
            relocation: (preferences?.relocation as 'no' | 'open' | 'yes') ?? 'no',
            recruiterVisibility: (preferences?.recruiterVisibility as 'hidden' | 'anonymous' | 'visible') ?? 'hidden',
            noticePeriodDays: preferences?.noticePeriodDays != null ? String(preferences.noticePeriodDays) : '',
            availableFrom: preferences?.availableFrom ?? '',
          }}
        />
      </div>

      <WorkAuthorizationForm
        initial={{
          country: (workAuthorization?.country as 'CA' | 'US') ?? (user.country as 'CA' | 'US'),
          status: workAuthorization?.status ?? 'unspecified',
          permitType: workAuthorization?.permitType ?? '',
          permitExpiresAt: workAuthorization?.permitExpiresAt ?? '',
          sponsorshipNeeded: workAuthorization?.sponsorshipNeeded ?? false,
          notes: workAuthorization?.notes ?? '',
        }}
      />

      <Card className="mt-6 max-w-2xl p-6">
        <h2 className="font-semibold text-ink">Self-identification (voluntary)</h2>
        <p className="mt-1.5 text-sm text-muted">
          Optional demographic questions, kept apart from your profile and never used in matching.
          Opened separately because every view of these answers is recorded.
        </p>
        <Link href="/dashboard/settings/self-identification" className="btn-secondary mt-3 inline-flex">
          Open self-identification
        </Link>
      </Card>

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

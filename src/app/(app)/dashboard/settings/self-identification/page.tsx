import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { PageHeader } from '@/components/ui';
import { SelfIdentificationForm } from '@/components/self-identification-form';

export const metadata = { title: 'Self-identification' };
export const dynamic = 'force-dynamic';

/**
 * Deliberately its own page, loaded on demand by the client component: the
 * data lives in the sensitive schema and every read is audited, so it is not
 * fetched as a side effect of opening Settings.
 */
export default async function SelfIdentificationPage() {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Self-identification"
        description="Optional. Stored apart from your profile and never used in matching."
      />
      <SelfIdentificationForm />
      <p className="mt-4 text-sm">
        <Link href="/dashboard/settings" className="font-semibold text-brand-500 hover:text-brand-600">
          Back to settings
        </Link>
      </p>
    </>
  );
}

import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { parseJson } from '@/lib/types';
import type { ResumeContent } from '@/lib/types';
import { PageHeader } from '@/components/ui';
import { ResumeEditor } from '@/components/resume-editor';

export const metadata = { title: 'My resume' };
export const dynamic = 'force-dynamic';

export default async function ResumePage() {
  const user = await requireUser();

  const resume = await db.resume.findFirst({
    where: { userId: user.id, isMaster: true },
    orderBy: { updatedAt: 'desc' },
  });

  const content = parseJson<ResumeContent | null>(resume?.content, null);

  return (
    <>
      <PageHeader
        title="My resume"
        description="Your master resume. Every application is tailored from this — keep it complete and accurate, and the AI has more to work with."
      />
      <ResumeEditor
        initial={
          content ?? {
            fullName: user.fullName,
            headline: user.headline ?? '',
            email: user.email,
            phone: user.phone ?? '',
            location: user.city ?? '',
            linkedinUrl: user.linkedinUrl ?? '',
            portfolioUrl: user.portfolioUrl ?? '',
            summary: '',
            skills: [],
            experience: [],
            education: [],
            certifications: [],
            projects: [],
          }
        }
      />
    </>
  );
}

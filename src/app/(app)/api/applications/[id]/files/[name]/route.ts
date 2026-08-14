import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { readFolderFile } from '@/lib/storage';
import { fail, route } from '@/lib/api';

type Params = { params: Promise<{ id: string; name: string }> };

/** Download one file from an application folder. */
export const GET = route(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id, name } = await params;

  const application = await db.application.findFirst({
    where: { id, userId: user.id },
    include: { job: true },
  });
  if (!application) return fail('Application not found.', 404);

  const fileName = decodeURIComponent(name);
  let content = await readFolderFile(user.id, application.folderPath, fileName);

  // Fall back to the database copy so downloads work even without a
  // persistent filesystem (serverless, container restarts).
  if (content === null) {
    if (fileName === 'resume.txt') content = application.tailoredResume;
    else if (fileName === 'cover-letter.txt') content = application.coverLetter;
    else if (fileName === 'job-description.md') content = application.job.description;
  }

  if (content === null) return fail('File not found.', 404);

  const isMarkdown = fileName.endsWith('.md');
  return new Response(content, {
    headers: {
      'Content-Type': `${isMarkdown ? 'text/markdown' : 'text/plain'}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

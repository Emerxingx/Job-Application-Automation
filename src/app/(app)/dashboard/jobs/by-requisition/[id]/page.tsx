import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Stage 18: the apply link a first-party posting carries resolves the requisition to its canonical Job page. Requisition rows are the employer's; only the published job id is read here, on the system client, for a signed-in person. */
export default async function ByRequisitionPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const r = await db.requisition.findUnique({ where: { id }, select: { jobId: true } });
  if (!r?.jobId) notFound();
  redirect(`/dashboard/jobs/${r.jobId}`);
}

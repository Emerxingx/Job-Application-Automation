import { requireTenant } from '@/lib/tenancy/request';
import { listEvidence } from '@/lib/evidence/vault';
import { listQuestions } from '@/lib/evidence/questions';
import { PageHeader } from '@/components/ui';
import { EvidenceVault, type EvidenceView, type QuestionView } from '@/components/evidence-vault';

export const metadata = { title: 'Evidence vault' };
export const dynamic = 'force-dynamic';

/**
 * /dashboard/evidence — the Career Evidence Vault and the application
 * question bank (Stage 03). Everything the AI may say about the candidate
 * traces to an approved item on this page; nothing else can reach a document.
 */
export default async function EvidencePage() {
  const { user, run } = await requireTenant();
  const { evidence, questions } = await run(async (tx) => ({
    evidence: await listEvidence(tx, user.id),
    questions: await listQuestions(tx, user.id),
  }));

  const evidenceView: EvidenceView[] = evidence.map((e) => ({
    id: e.id,
    kind: e.kind,
    sourceType: e.sourceType,
    claim: e.claim,
    status: e.status,
    version: e.version,
    supersedesId: e.supersedesId,
    approvedAt: e.approvedAt?.toISOString() ?? null,
    updatedAt: e.updatedAt.toISOString(),
  }));
  const questionView: QuestionView[] = questions.map((q) => ({
    id: q.id,
    question: q.question,
    category: q.category,
    riskLevel: q.riskLevel,
    policy: q.policy,
    answer: q.answer,
    lastConfirmedAt: q.lastConfirmedAt?.toISOString() ?? null,
    answerUpdatedAt: q.answerUpdatedAt?.toISOString() ?? null,
  }));

  return (
    <>
      <PageHeader
        title="Evidence vault"
        description="Every claim JobPilot's documents can make about you, one line each, with where it came from. Tailored resumes, cover letters and interview material are checked against this list before you see them: a claim that is not here is removed. Keep it accurate, and only approve what you can stand behind."
      />
      <EvidenceVault evidence={evidenceView} questions={questionView} />
    </>
  );
}

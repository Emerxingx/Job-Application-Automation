import { z } from 'zod';
import * as ai from '@/lib/ai/gateway';
import { requireTenant } from '@/lib/tenancy/request';
import { loadResumeContent } from '@/lib/candidate/profile';
import { loadEvidenceForGeneration } from '@/lib/evidence/vault';
import { atsReport } from '@/lib/documents/ats';
import { letterModel } from '@/lib/documents/model';
import { KIND_LABELS, MESSAGE_KINDS, recordDocumentVersion } from '@/lib/documents/versions';
import { toJobContext } from '@/lib/services/scanner';
import { parseJson } from '@/lib/types';
import type { MatchAnalysis } from '@/lib/types';
import { fail, ok, route } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

const schema = z.object({ kind: z.enum(MESSAGE_KINDS) });

/**
 * POST /api/applications/:id/messages { kind } — draft one message about
 * this application (application note, recruiter introduction, outreach,
 * follow-up, thank-you) through the gateway and store it as a versioned
 * document. Evidence-grounded like every other generated text; the
 * applicant edits and sends it themselves — nothing here contacts anyone.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  const { kind } = schema.parse(await request.json());

  const loaded = await run(async (tx) => {
    const application = await tx.application.findFirst({ where: { id, userId: user.id }, include: { job: true } });
    if (!application) return null;
    const [resume, evidence, match] = await Promise.all([
      loadResumeContent(tx, user.id),
      loadEvidenceForGeneration(tx, user.id),
      tx.jobMatch.findFirst({ where: { jobId: application.jobId, agent: { userId: user.id } }, orderBy: { matchScore: 'desc' } }),
    ]);
    return { application, resume, evidence, match };
  });
  if (!loaded) return fail('Application not found.', 404);
  if (!loaded.resume) return fail('Add your resume before drafting a message.', 400);
  const { application, resume, evidence, match } = loaded;

  const context = toJobContext(application.job);
  const ctx = { userId: user.id, evidence, inputRefs: [`application:${application.id}`, `job:${application.jobId}`] };
  // The stored match supplies the matched terms the message leans on; without one, the deterministic analysis does.
  const analysis: MatchAnalysis = match
    ? { matchScore: match.matchScore, breakdown: parseJson(match.scoreBreakdown, { skills: 0, experience: 0, keywords: 0, location: 0, seniority: 0 }), matchedKeywords: parseJson<string[]>(match.matchedKeywords, []), missingKeywords: parseJson<string[]>(match.missingKeywords, []), rationale: match.rationale }
    : (await ai.analyzeMatch(ctx, resume, context)).value;

  const { value: text, run: aiRun } = await ai.compose(ctx, kind, resume, context, analysis);
  const model = letterModel(text, `${user.fullName} — ${KIND_LABELS[kind]} — ${application.job.company}`);
  const row = await run((tx) =>
    recordDocumentVersion(tx, {
      userId: user.id,
      applicationId: application.id,
      jobId: application.jobId,
      kind,
      format: 'txt',
      bytes: Buffer.from(text, 'utf8'),
      evidenceIds: evidence.ids,
      aiRunId: aiRun.id,
      atsReport: atsReport(model, text),
    }),
  );
  return ok({ document: { id: row.id, kind, version: row.version, createdAt: row.createdAt.toISOString() }, text, route: aiRun.route });
});

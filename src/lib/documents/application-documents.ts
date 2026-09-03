import type { DocumentVersion } from '@prisma/client';
import { db } from '../db';
import type { ResumeContent } from '../types';
import { atsReport, type AtsReport } from './ats';
import { letterModel, renderText, resumeModel, type DocumentModel } from './model';
import { extractDocxText, renderDocx } from './render-docx';
import { extractPdfText, renderPdf } from './render-pdf';
import type { DocumentFormat, DocumentKind } from './kinds';
import { recordDocumentVersion, sealApplicationDocuments } from './versions';

/**
 * Stage 09 — the document set an application carries: the tailored résumé
 * and the cover letter, each as TXT, PDF and DOCX, each a hashed
 * `DocumentVersion` with its ATS report (including the parse-back check
 * against the rendered bytes). Sealed at submission; an assisted
 * application is sealed when the applicant confirms.
 */
export interface RenderedDocument {
  format: DocumentFormat;
  bytes: Buffer;
  ats: AtsReport;
}

export async function renderDocumentSet(model: DocumentModel, opts: { author: string; createdAt: Date }): Promise<RenderedDocument[]> {
  const text = renderText(model);
  const pdf = await renderPdf(model, opts);
  const docx = await renderDocx(model, opts);
  return [
    { format: 'txt', bytes: Buffer.from(text, 'utf8'), ats: atsReport(model, text) },
    { format: 'pdf', bytes: pdf, ats: atsReport(model, extractPdfText(pdf)) },
    { format: 'docx', bytes: docx, ats: atsReport(model, await extractDocxText(docx)) },
  ];
}

export interface ApplicationDocumentsInput {
  userId: string;
  applicationId: string;
  jobId: string;
  author: string;
  company: string;
  resume: ResumeContent;
  coverLetter: string;
  evidenceIds: string[];
  aiRunId?: string | null;
  createdAt?: Date;
  /** Seal immediately (the application was submitted programmatically). */
  seal?: boolean;
}

export async function writeApplicationDocuments(input: ApplicationDocumentsInput): Promise<DocumentVersion[]> {
  const createdAt = input.createdAt ?? new Date();
  const sets: { kind: DocumentKind; model: DocumentModel }[] = [{ kind: 'resume', model: resumeModel(input.resume) }];
  if (input.coverLetter.trim()) sets.push({ kind: 'cover_letter', model: letterModel(input.coverLetter, `${input.author} — Cover letter — ${input.company}`) });
  const rows: DocumentVersion[] = [];
  for (const { kind, model } of sets) {
    for (const rendered of await renderDocumentSet(model, { author: input.author, createdAt })) {
      rows.push(
        await recordDocumentVersion(db, {
          userId: input.userId,
          applicationId: input.applicationId,
          jobId: input.jobId,
          kind,
          format: rendered.format,
          bytes: rendered.bytes,
          evidenceIds: input.evidenceIds,
          aiRunId: input.aiRunId ?? null,
          atsReport: rendered.ats,
        }),
      );
    }
  }
  if (!input.seal) return rows;
  await sealApplicationDocuments(db, input.userId, input.applicationId, createdAt);
  // Return the rows as they now are — sealed — not the pre-seal objects.
  return db.documentVersion.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: [{ kind: 'asc' }, { format: 'asc' }] });
}

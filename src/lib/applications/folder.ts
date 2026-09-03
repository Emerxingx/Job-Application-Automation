import type { ApplicationStatus } from '../types';
import { REACHED_EMPLOYER } from './status-machine';

/**
 * Stage 10 — does the folder answer the acceptance question on its own?
 *
 *   "What exactly was sent, to whom, when, and what happened" — without
 *   reference to any other system.
 *
 * Pure: the facts come from the application row, its children and its
 * Stage 09 document versions; the answer is a list of the five questions
 * with what answers each, or what is missing. Nothing here is a score of
 * the application's quality — it is a checklist of the record's completeness.
 */
export interface FolderFacts {
  status: ApplicationStatus;
  appliedAt: Date | null;
  applyChannel: string;
  confirmation: string | null;
  company: string;
  /** Sealed Stage 09 versions (what was actually sent). */
  sealedDocuments: number;
  /** The database copies of the résumé and letter exist. */
  hasTextCopies: boolean;
  contacts: number;
  historyEntries: number;
  interviews: number;
  assessments: number;
  followUps: number;
  outcome: string;
  respondedAt: Date | null;
}

export interface FolderAnswer {
  question: 'what_was_sent' | 'to_whom' | 'when' | 'how' | 'what_happened';
  label: string;
  ok: boolean;
  detail: string;
}

export interface FolderCompleteness {
  answers: FolderAnswer[];
  /** Questions answered, 0–5. */
  answered: number;
  complete: boolean;
}

const UNDISCLOSED = /^(undisclosed|confidential|unknown)\b/i;

export function folderCompleteness(f: FolderFacts): FolderCompleteness {
  const reached = REACHED_EMPLOYER.includes(f.status);
  const answers: FolderAnswer[] = [];

  answers.push(
    f.sealedDocuments > 0
      ? { question: 'what_was_sent', label: 'What was sent', ok: true, detail: `${f.sealedDocuments} sealed file${f.sealedDocuments === 1 ? '' : 's'}, hash-verified` }
      : f.hasTextCopies
        ? { question: 'what_was_sent', label: 'What was sent', ok: reached, detail: reached ? 'the database copies of the résumé and letter (no sealed files)' : 'prepared, not sent yet' }
        : { question: 'what_was_sent', label: 'What was sent', ok: false, detail: 'no documents on record' },
  );

  const employerKnown = f.company.trim() !== '' && !UNDISCLOSED.test(f.company);
  answers.push({
    question: 'to_whom',
    label: 'To whom',
    ok: employerKnown,
    detail: employerKnown ? `${f.company}${f.contacts ? `, ${f.contacts} contact${f.contacts === 1 ? '' : 's'} on file` : ', no named contact yet'}` : 'the employer is undisclosed',
  });

  answers.push(
    f.appliedAt
      ? { question: 'when', label: 'When', ok: true, detail: f.appliedAt.toISOString() }
      : { question: 'when', label: 'When', ok: false, detail: reached ? 'the submission date is missing' : 'not sent yet' },
  );

  const how = f.applyChannel === 'assisted' ? (f.appliedAt ? 'assisted — confirmed by you on the employer form' : 'assisted — awaiting your confirmation') : f.applyChannel === 'ats_api' ? `employer system${f.confirmation ? `, confirmation ${f.confirmation}` : ''}` : f.applyChannel ? f.applyChannel : 'no channel recorded';
  answers.push({ question: 'how', label: 'How', ok: f.applyChannel !== '' && (f.applyChannel !== 'assisted' || f.appliedAt !== null), detail: how });

  const happened = f.outcome !== 'pending' || f.interviews > 0 || f.assessments > 0 || f.respondedAt !== null || ['interviewing', 'offer', 'rejected', 'withdrawn'].includes(f.status);
  answers.push({
    question: 'what_happened',
    label: 'What happened',
    ok: happened,
    detail: happened
      ? [f.interviews ? `${f.interviews} interview${f.interviews === 1 ? '' : 's'}` : '', f.assessments ? `${f.assessments} assessment${f.assessments === 1 ? '' : 's'}` : '', f.followUps ? `${f.followUps} follow-up${f.followUps === 1 ? '' : 's'}` : '', `outcome ${f.outcome}`, `${f.historyEntries} status change${f.historyEntries === 1 ? '' : 's'}`].filter(Boolean).join(', ')
      : reached
        ? 'no response recorded yet'
        : 'nothing yet — the application has not been sent',
  });

  const answered = answers.filter((a) => a.ok).length;
  return { answers, answered, complete: answered === answers.length };
}

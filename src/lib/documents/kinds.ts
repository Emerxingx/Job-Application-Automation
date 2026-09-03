/**
 * Stage 09 — document kinds, formats and labels. A pure module (no database,
 * no storage) so client components and the engine can import it.
 */
export type DocumentKind = 'resume' | 'cover_letter' | 'application_message' | 'recruiter_intro' | 'outreach' | 'follow_up' | 'thank_you' | 'uploaded_resume';
export type DocumentFormat = 'txt' | 'pdf' | 'docx';

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['resume', 'cover_letter', 'application_message', 'recruiter_intro', 'outreach', 'follow_up', 'thank_you', 'uploaded_resume'];
export const MESSAGE_KINDS = ['application_message', 'recruiter_intro', 'outreach', 'follow_up', 'thank_you'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const DOCUMENT_FORMATS: readonly DocumentFormat[] = ['txt', 'pdf', 'docx'];

export const CONTENT_TYPES: Record<DocumentFormat, string> = {
  txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const KIND_LABELS: Record<DocumentKind, string> = {
  resume: 'Tailored resume',
  cover_letter: 'Cover letter',
  application_message: 'Application message',
  recruiter_intro: 'Recruiter introduction',
  outreach: 'Outreach note',
  follow_up: 'Follow-up',
  thank_you: 'Thank-you note',
  uploaded_resume: 'Uploaded resume',
};

export const MESSAGE_HINTS: Record<MessageKind, string> = {
  application_message: 'A short note to paste into an application form.',
  recruiter_intro: 'Introduce yourself to a recruiter about this role.',
  outreach: 'A direct note to someone on the team.',
  follow_up: 'Check in on an application you have sent.',
  thank_you: 'After an interview.',
};

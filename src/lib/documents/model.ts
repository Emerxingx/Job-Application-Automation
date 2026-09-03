import type { ResumeContent } from '../types';

/**
 * Stage 09 — the ATS-safe document model every renderer consumes.
 *
 * One structure, three renderers (text, PDF, DOCX): single column, no
 * tables, no graphics, conventional upper-case section headings in a fixed
 * order, standard date formats. The text renderer reproduces
 * `renderResumeText` byte for byte (tested), so the model is not a second
 * opinion about the résumé's shape — it is the same shape, with the PDF and
 * DOCX renderers reading it instead of re-deriving it.
 */
export interface DocumentEntry {
  heading: string;
  sub?: string;
  bullets: string[];
}

export interface DocumentSection {
  /** Upper-case for a résumé; empty for a letter body. */
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  entries?: DocumentEntry[];
}

export interface DocumentModel {
  /** Metadata title (never printed on the page). */
  title: string;
  /** Header lines: name (upper-cased on a résumé), headline, contact line. */
  header: string[];
  sections: DocumentSection[];
}

export const RESUME_SECTION_ORDER = ['PROFESSIONAL SUMMARY', 'CORE SKILLS', 'PROFESSIONAL EXPERIENCE', 'EDUCATION', 'CERTIFICATIONS', 'PROJECTS'] as const;

export function resumeModel(resume: ResumeContent): DocumentModel {
  const header = [resume.fullName.toUpperCase()];
  if (resume.headline) header.push(resume.headline);
  const contact = [resume.location, resume.phone, resume.email, resume.linkedinUrl, resume.portfolioUrl].filter(Boolean).join(' | ');
  if (contact) header.push(contact);

  const sections: DocumentSection[] = [];
  if (resume.summary) sections.push({ heading: 'PROFESSIONAL SUMMARY', paragraphs: [resume.summary] });
  if (resume.skills.length) sections.push({ heading: 'CORE SKILLS', paragraphs: [resume.skills.join(' | ')] });
  if (resume.experience.length) {
    sections.push({
      heading: 'PROFESSIONAL EXPERIENCE',
      entries: resume.experience.map((role) => ({
        heading: `${role.title} — ${role.company}${role.location ? `, ${role.location}` : ''}`,
        sub: `${role.startDate} – ${role.endDate}`,
        bullets: role.bullets,
      })),
    });
  }
  if (resume.education.length) {
    sections.push({
      heading: 'EDUCATION',
      entries: resume.education.map((ed) => ({ heading: `${ed.credential} — ${ed.institution}${ed.location ? `, ${ed.location}` : ''}`, sub: ed.year, bullets: [] })),
    });
  }
  if (resume.certifications.length) sections.push({ heading: 'CERTIFICATIONS', bullets: resume.certifications });
  if (resume.projects?.length) sections.push({ heading: 'PROJECTS', bullets: resume.projects.map((p) => `${p.name}: ${p.description}`) });
  return { title: `${resume.fullName} — Résumé`, header, sections };
}

/**
 * A letter or message: blocks separated by blank lines; a block may carry
 * line breaks (an address block, a signature). `renderText` gives the
 * normalised text back unchanged.
 */
export function letterModel(text: string, title: string): DocumentModel {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return { title, header: [], sections: [{ heading: '', paragraphs: blocks }] };
}

/** Plain text. For a résumé model this is exactly `renderResumeText(resume)`. */
export function renderText(model: DocumentModel): string {
  const lines: string[] = [...model.header];
  for (const section of model.sections) {
    if (section.heading) lines.push('', section.heading);
    if (section.paragraphs) {
      section.paragraphs.forEach((p, i) => {
        if (section.heading || i > 0) lines.push('');
        lines.push(p);
      });
    }
    if (section.bullets) {
      if (section.heading) lines.push('');
      for (const b of section.bullets) lines.push(`- ${b}`);
    }
    if (section.entries) {
      for (const e of section.entries) {
        lines.push('', e.heading);
        if (e.sub) lines.push(e.sub);
        for (const b of e.bullets) lines.push(`- ${b}`);
      }
    }
  }
  return lines.join('\n');
}

/** Every human-readable string in the model, in reading order — what a parser must recover. */
export function textsOf(model: DocumentModel): string[] {
  const out = [...model.header];
  for (const s of model.sections) {
    if (s.heading) out.push(s.heading);
    out.push(...(s.paragraphs ?? []));
    out.push(...(s.bullets ?? []));
    for (const e of s.entries ?? []) {
      out.push(e.heading);
      if (e.sub) out.push(e.sub);
      out.push(...e.bullets);
    }
  }
  return out;
}

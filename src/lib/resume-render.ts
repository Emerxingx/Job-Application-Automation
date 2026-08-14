import type { ResumeContent } from './types';

/**
 * Render structured resume content to plain text.
 *
 * The format is deliberately ATS-friendly: single column, no tables, no
 * graphics, conventional section headings that parsers recognize, and
 * standard date formats.
 */
export function renderResumeText(resume: ResumeContent): string {
  const lines: string[] = [];

  lines.push(resume.fullName.toUpperCase());
  if (resume.headline) lines.push(resume.headline);

  const contact = [resume.location, resume.phone, resume.email, resume.linkedinUrl, resume.portfolioUrl]
    .filter(Boolean)
    .join(' | ');
  if (contact) lines.push(contact);

  if (resume.summary) {
    lines.push('', 'PROFESSIONAL SUMMARY', '', resume.summary);
  }

  if (resume.skills.length) {
    lines.push('', 'CORE SKILLS', '', resume.skills.join(' | '));
  }

  if (resume.experience.length) {
    lines.push('', 'PROFESSIONAL EXPERIENCE');
    for (const role of resume.experience) {
      lines.push('');
      lines.push(`${role.title} — ${role.company}${role.location ? `, ${role.location}` : ''}`);
      lines.push(`${role.startDate} – ${role.endDate}`);
      for (const bullet of role.bullets) lines.push(`- ${bullet}`);
    }
  }

  if (resume.education.length) {
    lines.push('', 'EDUCATION');
    for (const ed of resume.education) {
      lines.push('');
      lines.push(`${ed.credential} — ${ed.institution}${ed.location ? `, ${ed.location}` : ''}`);
      lines.push(ed.year);
    }
  }

  if (resume.certifications.length) {
    lines.push('', 'CERTIFICATIONS', '');
    for (const cert of resume.certifications) lines.push(`- ${cert}`);
  }

  if (resume.projects?.length) {
    lines.push('', 'PROJECTS', '');
    for (const p of resume.projects) lines.push(`- ${p.name}: ${p.description}`);
  }

  return lines.join('\n');
}

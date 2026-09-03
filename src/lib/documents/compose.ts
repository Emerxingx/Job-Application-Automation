import type { MatchAnalysis, ResumeContent } from '../types';
import type { JobContext } from '../providers/ai/types';
import type { MessageKind } from './kinds';

/**
 * Stage 09 — the deterministic message engine: application messages,
 * recruiter introductions, outreach notes, follow-ups and thank-you notes.
 *
 * Built ONLY from the résumé, the match analysis and the posting's
 * structured fields (title, company). Nothing from the posting's free text
 * is copied — a description is untrusted input and quoting it would put
 * the poster's words in the candidate's mouth — and no fact is asserted
 * that the résumé does not carry, so the grounding checker (letter scope)
 * passes these by construction; the gateway still runs it. The wording is
 * plain and neutral: an applicant edits these, they do not send them blind.
 */
const STRIP_LEVEL = /^(senior|junior|lead|principal|staff|intermediate|associate|sr\.?|jr\.?)\s+/i;

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function sentence(s: string): string {
  const t = s.trim().replace(/[.;:]+$/, '');
  return t ? `${t}.` : '';
}

function roleTitle(title: string): string {
  return title.replace(STRIP_LEVEL, '').trim() || title;
}

export function composeMessage(kind: MessageKind, resume: ResumeContent, job: JobContext, analysis: MatchAnalysis): string {
  const top = analysis.matchedKeywords.slice(0, 3);
  const areas = top.length ? top.join(', ') : 'the areas this role calls for';
  const recent = resume.experience[0];
  const where = recent?.company ?? 'my most recent role';
  const proof = recent?.bullets[0] ? lowerFirst(sentence(recent.bullets[0])) : 'delivered measurable results.';
  const headline = resume.headline ? `${article(resume.headline)} ${resume.headline.toLowerCase()}` : null;
  const signature = [resume.fullName, resume.email, resume.phone ?? ''].filter(Boolean).join('\n');
  const title = roleTitle(job.title);

  switch (kind) {
    case 'application_message':
      return [
        'Dear Hiring Team,',
        '',
        `I am applying for the ${job.title} position at ${job.company}.${headline ? ` As ${headline}, I` : ' I'} bring direct experience in ${areas}. In my most recent role at ${where}, I ${proof} I would welcome the chance to discuss how this background fits your team.`,
        '',
        'Thank you for your consideration.',
        '',
        signature,
      ].join('\n');
    case 'recruiter_intro':
      return [
        'Dear Hiring Team,',
        '',
        `My name is ${resume.fullName}${headline ? ` and I am ${headline}` : ''}. I am reaching out about the ${job.title} role at ${job.company}. My background is in ${areas}; most recently at ${where}, I ${proof} I have attached my resume and would welcome a short conversation about whether my experience fits what you are looking for.`,
        '',
        'Thank you,',
        signature,
      ].join('\n');
    case 'outreach':
      return [
        'Hello,',
        '',
        `I am ${resume.fullName}${headline ? `, ${headline}` : ''}. I noticed the ${job.title} opening at ${job.company} and wanted to reach out directly. My experience with ${areas} maps closely to the ${title} role; at ${where}, I ${proof} If you are open to it, I would value a brief conversation about the team and the role.`,
        '',
        'Thank you for your time,',
        signature,
      ].join('\n');
    case 'follow_up':
      return [
        'Dear Hiring Team,',
        '',
        `I am following up on my application for the ${job.title} position at ${job.company}. I remain very interested in the role: my experience with ${areas} and my work at ${where}, where I ${proof.replace(/\.$/, '')}, are directly relevant. Please let me know if any further information would be helpful.`,
        '',
        'Thank you for your time,',
        signature,
      ].join('\n');
    case 'thank_you':
      return [
        'Dear Hiring Team,',
        '',
        `Thank you for taking the time to speak with me about the ${job.title} role at ${job.company}. Our conversation confirmed my interest in the position and in the team. As discussed, my experience with ${areas} at ${where}, where I ${proof.replace(/\.$/, '')}, is what I would bring from day one. I look forward to hearing about the next steps.`,
        '',
        'With thanks,',
        signature,
      ].join('\n');
  }
}

/**
 * Stage 12 — the question bank, wired into the prepared application.
 *
 * An employer's form asks questions the profile does not hold. Stage 03
 * stored the candidate's answers with a policy each (AUTO_FILL /
 * ASK_IF_CHANGED / REQUIRE_REVIEW / NEVER_AUTOMATE, floored by category).
 * This module turns those rows into what an assisted application may show:
 *
 *   fill    the stored answer, ready to copy;
 *   ask     the stored answer, to be confirmed as still current first;
 *   review  the stored answer (or nothing), to be read before use;
 *   never   the question only — NO value, ever, whatever is stored. A human
 *           answers it live, in every mode (ADR-0016).
 *
 * Pure: no database, no model. The field-mapping register (governed, Stage
 * 12) supplies the canonical key a question maps to, so a profile value
 * can stand in for a missing answer where the policy allows a value at all.
 */
import type { ApplicationQuestion } from '@prisma/client';
import { evidenceIdsOf, resolveAutomation, type AutomationDecision } from '../evidence/questions';
import type { ApplicantProfile } from '../providers/apply/types';
import { matchMapping, type FieldMapping } from './field-mappings';

export interface PreparedQuestion {
  id: string;
  question: string;
  category: string;
  policy: string;
  decision: AutomationDecision;
  /** Empty when the decision is `never`, and when nothing is stored. */
  value: string;
  /** The register key the question maps to, when one does. */
  canonicalKey: string | null;
  /** Approved evidence ids the stored answer relies on — ids only. */
  evidenceIds: string[];
}

const DECISION_ORDER: Record<AutomationDecision, number> = { fill: 0, ask: 1, review: 2, never: 3 };

/** The profile value a canonical key names, when the profile holds one. */
export function profileValueFor(key: string, applicant: ApplicantProfile): string | null {
  switch (key) {
    case 'work_authorization':
      return applicant.workAuthorization ?? null;
    case 'requires_sponsorship':
      return typeof applicant.requiresSponsorship === 'boolean' ? (applicant.requiresSponsorship ? 'Yes' : 'No') : null;
    case 'phone':
      return applicant.phone ?? null;
    case 'linkedin_url':
      return applicant.linkedinUrl ?? null;
    case 'portfolio_url':
      return applicant.portfolioUrl ?? null;
    case 'location':
      return applicant.location ?? null;
    default:
      return null;
  }
}

export function prepareQuestions(questions: ApplicationQuestion[], mappings: FieldMapping[], applicant: ApplicantProfile): PreparedQuestion[] {
  return questions
    .map((q): PreparedQuestion => {
      const decision = resolveAutomation(q);
      const canonicalKey = matchMapping(q.question, mappings)?.canonicalFieldKey ?? null;
      let value = '';
      if (decision !== 'never') {
        // A stored answer wins; the profile stands in only when nothing is stored.
        value = q.answer.trim() || (canonicalKey ? (profileValueFor(canonicalKey, applicant) ?? '') : '');
      }
      return { id: q.id, question: q.question, category: q.category, policy: q.policy, decision, value, canonicalKey, evidenceIds: decision === 'never' ? [] : evidenceIdsOf(q) };
    })
    .sort((a, b) => DECISION_ORDER[a.decision] - DECISION_ORDER[b.decision] || a.question.localeCompare(b.question));
}

/** True when the prepared set carries a value for a question that must never be automated — the invariant a test guards. */
export function carriesNeverAutomatedValue(prepared: PreparedQuestion[]): boolean {
  return prepared.some((p) => (p.decision === 'never' || p.policy === 'NEVER_AUTOMATE') && p.value !== '');
}

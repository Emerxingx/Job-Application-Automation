/**
 * Stage 17 (ADR-0032) - the case-manager copilot. It RECOMMENDS ONLY.
 *
 * Pure: a deterministic reading of non-RESTRICTED signals about a client's
 * job search - counts of applications and responses, the eligibility rules
 * that failed and why, the compatibility dimensions that were weak, the
 * postings this deployment holds for the target, and whether a résumé and a
 * profile exist. It never sees a case note, an assessment or a barrier
 * (a static test refuses any such reference in this file), never calls a
 * model, and produces nothing but a list of patterns with the numbers that
 * triggered them and a suggested action in words. Writing the result is the
 * runner's job (service.ts), and the only table it writes is
 * `CaseRecommendation`; accepting one is a case manager's explicit act.
 */

export const COPILOT_VERSION = '2026-09-05.1';

export interface ClientSignals {
  /** Days since the client last did anything on the platform; null when never. */
  daysSinceActivity: number | null;
  applications: {
    total: number;
    /** Reached `submitted` (or beyond) per the status history. */
    submitted: number;
    /** Reached interviewing / offer per the status history. */
    responded: number;
    interviews: number;
    offers: number;
    /** Submitted in the last 30 days. */
    submitted30d: number;
  };
  eligibility: {
    evaluated: number;
    /** Hard-rule failures by rule id, e.g. { location: 4, licensure: 2 }. */
    failsByRule: Record<string, number>;
    /** The certification names the licensure rule named, most frequent first. */
    certificationsNamed: string[];
  };
  matching: {
    scored: number;
    /** Matches whose seniority dimension scored under 40. */
    seniorityLow: number;
    /** Matches whose skills dimension scored under 40. */
    skillsLow: number;
    /** Matches whose keywords dimension scored under 40. */
    keywordsLow: number;
    /** Most frequently missing required items across the skills dimension. */
    missingSkills: string[];
  };
  profile: {
    hasResume: boolean;
    skillsCount: number;
    hasTargetTitles: boolean;
    locationsCount: number;
    relocation: string;
  };
  market: {
    /** Null when the case has no target occupation or the spine holds nothing for it. */
    targetOccupationSet: boolean;
    postingsOpen: number | null;
  };
}

export type Pattern = 'poor_response_rate' | 'unrealistic_seniority' | 'missing_qualifications' | 'geographic_constraints' | 'resume_problems' | 'weak_demand' | 'certification_gaps' | 'inactive' | 'no_target';
export type Severity = 'info' | 'attention' | 'high';

export interface Recommendation {
  pattern: Pattern;
  severity: Severity;
  /** The numbers that triggered it - counts and names, never a note. */
  detail: Record<string, number | string | string[] | null>;
  suggestedAction: string;
}

const MIN_SAMPLE = 5;

/** Read the signals against fixed thresholds. Order is fixed; the same signals always yield the same list. */
export function assessSignals(s: ClientSignals): Recommendation[] {
  const out: Recommendation[] = [];
  const a = s.applications;

  if (s.daysSinceActivity !== null && s.daysSinceActivity >= 21) {
    out.push({ pattern: 'inactive', severity: s.daysSinceActivity >= 45 ? 'high' : 'attention', detail: { daysSinceActivity: s.daysSinceActivity }, suggestedAction: 'No platform activity for three weeks or more. A check-in is due; ask what changed before assuming disengagement.' });
  }
  if (!s.profile.hasTargetTitles && !s.market.targetOccupationSet) {
    out.push({ pattern: 'no_target', severity: 'attention', detail: { hasTargetTitles: 0, targetOccupationSet: 0 }, suggestedAction: 'No target titles on the profile and no target occupation on the case: recommendations cannot be focused. Agree an employment goal and record the target occupation.' });
  }
  if (a.submitted >= 8 && a.responded / a.submitted < 0.1) {
    out.push({ pattern: 'poor_response_rate', severity: a.submitted >= 20 ? 'high' : 'attention', detail: { submitted: a.submitted, responded: a.responded, rate: Math.round((a.responded / a.submitted) * 100) }, suggestedAction: 'Fewer than one in ten submissions has drawn a response. Review the targeting and the résumé before increasing volume.' });
  }
  if (s.matching.scored >= MIN_SAMPLE && s.matching.seniorityLow / s.matching.scored >= 0.5) {
    out.push({ pattern: 'unrealistic_seniority', severity: 'attention', detail: { scored: s.matching.scored, seniorityLow: s.matching.seniorityLow }, suggestedAction: 'Half or more of the scored postings sit above the experience the profile shows. Discuss the seniority band being targeted.' });
  }
  if (s.matching.scored >= MIN_SAMPLE && s.matching.skillsLow / s.matching.scored >= 0.5) {
    out.push({ pattern: 'missing_qualifications', severity: 'attention', detail: { scored: s.matching.scored, skillsLow: s.matching.skillsLow, missingSkills: s.matching.missingSkills.slice(0, 5) }, suggestedAction: 'The required skills of most scored postings are not on the profile. Check whether they are held and unrecorded, or a training referral is warranted (Career transition lists licensed options).' });
  }
  const locationFails = s.eligibility.failsByRule.location ?? 0;
  if (locationFails >= 3) {
    out.push({ pattern: 'geographic_constraints', severity: locationFails >= 8 ? 'high' : 'attention', detail: { locationFails, locationsCount: s.profile.locationsCount, relocation: s.profile.relocation }, suggestedAction: 'Postings are being excluded on location. Confirm the areas the client can work in and whether relocation or remote work is open.' });
  }
  if (!s.profile.hasResume || (s.matching.scored >= MIN_SAMPLE && s.matching.keywordsLow / s.matching.scored >= 0.5)) {
    out.push({ pattern: 'resume_problems', severity: s.profile.hasResume ? 'attention' : 'high', detail: { hasResume: s.profile.hasResume ? 1 : 0, scored: s.matching.scored, keywordsLow: s.matching.keywordsLow }, suggestedAction: s.profile.hasResume ? 'The résumé shares few of the terms the postings use. Review the wording against the evidence vault.' : 'There is no résumé on the platform. Build one from the profile before anything else is measured.' });
  }
  if (s.market.targetOccupationSet && s.market.postingsOpen !== null && s.market.postingsOpen < 3) {
    out.push({ pattern: 'weak_demand', severity: 'info', detail: { postingsOpen: s.market.postingsOpen }, suggestedAction: 'This deployment holds few open postings for the target occupation. That is what is held here, not the labour market; consider adjacent occupations.' });
  }
  const licensureFails = s.eligibility.failsByRule.licensure ?? 0;
  if (licensureFails >= 2) {
    out.push({ pattern: 'certification_gaps', severity: 'attention', detail: { licensureFails, certificationsNamed: s.eligibility.certificationsNamed.slice(0, 5) }, suggestedAction: 'Postings are being excluded on a licence or certification. The "what if I held it" comparison on a posting shows whether a credential changes the verdict.' });
  }
  return out;
}

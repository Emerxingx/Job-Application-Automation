/**
 * Stage 16 (ADR-0031) - "will this credential materially change my
 * eligibility?", answered by running the Stage 07 eligibility engine twice:
 * once on the candidate's facts as they are, once with the credential added
 * to the certifications the engine reads. Pure; the difference IS the answer,
 * rule by rule, and nothing else is inferred.
 */
import { evaluateEligibility, type CandidateEligibility, type EligibilityVerdict, type JobEligibilityFacts, type RuleResult } from '@/lib/eligibility/engine';

export interface CredentialForCounterfactual {
  name: string;
  spellings: string[];
}

export interface RuleChange {
  rule: RuleResult['rule'];
  from: RuleResult['status'];
  to: RuleResult['status'];
  reasonAfter: string;
}

export interface EligibilityCounterfactual {
  credential: string;
  before: EligibilityVerdict;
  after: EligibilityVerdict;
  changes: RuleChange[];
  outcomeBefore: EligibilityVerdict['outcome'];
  outcomeAfter: EligibilityVerdict['outcome'];
  /** True when the verdict itself moved (e.g. ineligible -> eligible), not merely a reason. */
  materiallyChanged: boolean;
}

export function credentialCounterfactual(candidate: CandidateEligibility, job: JobEligibilityFacts, credential: CredentialForCounterfactual, today = new Date()): EligibilityCounterfactual {
  const before = evaluateEligibility(candidate, job, today);
  const withCredential: CandidateEligibility = { ...candidate, certifications: [...candidate.certifications, credential.name, ...credential.spellings] };
  const after = evaluateEligibility(withCredential, job, today);
  const changes: RuleChange[] = [];
  for (const b of before.rules) {
    const a = after.rules.find((r) => r.rule === b.rule);
    if (a && a.status !== b.status) changes.push({ rule: b.rule, from: b.status, to: a.status, reasonAfter: a.reason });
  }
  return { credential: credential.name, before, after, changes, outcomeBefore: before.outcome, outcomeAfter: after.outcome, materiallyChanged: before.outcome !== after.outcome };
}

/**
 * The pre-Stage-04 title → NOC regex table, kept as the LOW-CONFIDENCE
 * fallback ADR-0009 describes. It used to live inside the Adzuna adapter and
 * was the whole occupational implementation. It is retained because it costs
 * nothing and catches the common titles when no dataset has been ingested
 * yet; every use records `regex_fallback` as the method, never an implied
 * certainty. Dependency-free so the job adapters can call it synchronously.
 *
 * Stage 04 review corrected three mappings against NOC 2021 unit-group
 * titles: DevOps/SRE → 21222 (information systems specialists), network
 * engineer → 21311 (computer engineers), network administrator → 22220
 * (computer network and web technicians). The rest were checked and kept.
 */
export const NOC_BY_TITLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdata\s+analyst\b/i, '21223'],
  [/\bbusiness\s+analyst\b/i, '21221'],
  [/\bdata\s+scientist\b/i, '21211'],
  [/\bdata\s+engineer\b/i, '21231'],
  [/\bmachine\s+learning\b|\bml\s+engineer\b/i, '21211'],
  [/\bsoftware\s+(engineer|developer)\b|\bfull.?stack\b|\bbackend\b|\bfrontend\b/i, '21232'],
  [/\bweb\s+developer\b/i, '21234'],
  [/\bdevops\b|\bsite\s+reliability\b|\bsre\b/i, '21222'],
  [/\bdatabase\s+administrator\b|\bdba\b/i, '21223'],
  [/\bcyber\s*security\b|\binformation\s+security\b/i, '21220'],
  [/\bnetwork\s+engineer\b/i, '21311'],
  [/\bnetwork\s+administrator\b/i, '22220'],
  [/\bproduct\s+manager\b/i, '10029'],
  [/\bproject\s+manager\b/i, '20012'],
  [/\baccountant\b/i, '11100'],
  [/\bfinancial\s+analyst\b/i, '11101'],
  [/\bmarketing\s+manager\b/i, '10022'],
  [/\bregistered\s+nurse\b/i, '31301'],
  [/\bcivil\s+engineer\b/i, '21300'],
  [/\bmechanical\s+engineer\b/i, '21301'],
  [/\belectrical\s+engineer\b/i, '21310'],
];

/** A NOC 2021 unit-group code inferred from a title, or undefined — never a guess. */
export function inferNocCode(title: string): string | undefined {
  for (const [pattern, code] of NOC_BY_TITLE) {
    if (pattern.test(title)) return code;
  }
  return undefined;
}

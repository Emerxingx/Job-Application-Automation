/**
 * The names and vocabulary of RESTRICTED attributes (DATA_CLASSIFICATION.md,
 * ADR-0007). The AI gateway refuses any payload in which one of these appears
 * as a key, so even a future bug that serialised the wrong object could not
 * ship a sensitive attribute to a provider. Kept dependency-free so the check
 * runs before any provider module loads.
 */
export const RESTRICTED_KEYS = [
  'gender',
  'ethnicity',
  'indigenousStatus',
  'indigenous_status',
  'veteranStatus',
  'veteran_status',
  'disabilityStatus',
  'disability_status',
  'selfIdentification',
  'self_identification',
  'caseNotes',
  'case_notes',
  'mailbox',
] as const;

export class RestrictedPayloadError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`AI payload contains a RESTRICTED field: ${key}`);
    this.name = 'RestrictedPayloadError';
    this.key = key;
  }
}

/** Walk any JSON-serialisable value; throw on the first RESTRICTED key. */
export function assertNoRestrictedFields(value: unknown, path = ''): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoRestrictedFields(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((RESTRICTED_KEYS as readonly string[]).includes(k)) throw new RestrictedPayloadError(path ? `${path}.${k}` : k);
    assertNoRestrictedFields(v, path ? `${path}.${k}` : k);
  }
}

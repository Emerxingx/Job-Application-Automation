/**
 * The pure core of the prompt engine: variable validation and substitution.
 *
 * Kept separate from the registry read path (src/lib/ai/prompt-registry.ts,
 * which fetches the deployed version from the database) so this logic — the
 * part with the security properties — has no database dependency and is
 * unit-testable in isolation.
 */

export class MissingPromptVariablesError extends Error {
  readonly missing: string[];
  constructor(slug: string, missing: string[]) {
    super(`Prompt "${slug}" is missing required variable(s): ${missing.join(', ')}.`);
    this.name = 'MissingPromptVariablesError';
    this.missing = missing;
  }
}

/** Matches {{ variable_name }} with optional surrounding whitespace. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Which declared variables were not supplied. A variable counts as supplied
 * only when its value is neither undefined nor null — an empty string is a
 * legitimate value a caller may intentionally pass.
 */
export function missingVariables(
  declared: readonly string[],
  variables: Record<string, string>,
): string[] {
  return declared.filter((name) => variables[name] === undefined || variables[name] === null);
}

/**
 * Replace every {{placeholder}} with its supplied value in a single pass.
 *
 * The security-relevant behaviour, all a consequence of `replace` resolving
 * each match against the ORIGINAL variables map:
 *
 *   - Non-recursive: a value containing "{{other}}" is inserted verbatim and
 *     never re-scanned, so a user-supplied résumé or an injection attempt
 *     cannot smuggle in another variable's content or cause unbounded
 *     expansion.
 *   - Single-pass: overlapping or adjacent placeholders each resolve once.
 *   - Unknown placeholders (in the text but not supplied) are left intact
 *     rather than blanked, surfacing the mistake instead of hiding it.
 */
export function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = variables[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

/** The distinct {{variable}} names that appear in a template. */
export function extractPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) found.add(match[1]);
  return [...found];
}

/**
 * Validate then substitute. Throws MissingPromptVariablesError if any declared
 * variable was not supplied — a prompt that needs {{job_description}} must
 * never be sent with the literal placeholder still in it.
 */
export function renderTemplate(
  slug: string,
  template: string,
  declared: readonly string[],
  variables: Record<string, string>,
): string {
  const missing = missingVariables(declared, variables);
  if (missing.length > 0) throw new MissingPromptVariablesError(slug, missing);
  return interpolate(template, variables);
}

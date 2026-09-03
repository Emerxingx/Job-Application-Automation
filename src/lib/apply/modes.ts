/**
 * Stage 12 — application modes (ADR-0016, ADR-0026).
 *
 * Four modes are modelled. Three are reachable:
 *
 *   recommend_only  surface matches; generate nothing, prepare nothing;
 *   prepare         tailor the documents and prepare the fields; JobPilot
 *                   never sends anything — the applicant confirms on the
 *                   employer's form;
 *   review_submit   prepare, the applicant reviews, and on THEIR instruction
 *                   JobPilot may submit through an ATS API the employer has
 *                   authorised (the default).
 *
 * The fourth, `approved_auto_apply`, is named here so nothing can mistake a
 * typo for it, and REFUSED everywhere it could be set or read: it is Stage 22
 * work gated on lawfulness review and an explicit founder decision. There is
 * no flag, no environment variable and no role that reaches it.
 */
export const APPLICATION_MODES = ['recommend_only', 'prepare', 'review_submit'] as const;
export type ApplicationMode = (typeof APPLICATION_MODES)[number];
export const DEFAULT_APPLICATION_MODE: ApplicationMode = 'review_submit';
/** Modelled, disabled, unreachable until Stage 22 (ADR-0016). */
export const UNREACHABLE_MODE = 'approved_auto_apply';

export const MODE_LABELS: Record<ApplicationMode, string> = {
  recommend_only: 'Recommend only',
  prepare: 'Prepare',
  review_submit: 'Review & submit',
};

export const MODE_DESCRIPTIONS: Record<ApplicationMode, string> = {
  recommend_only: 'JobPilot shows you matches and explains them. Nothing is generated or prepared.',
  prepare: 'JobPilot tailors your documents and prepares every field. You submit on the employer’s form; JobPilot never sends anything.',
  review_submit: 'JobPilot prepares everything; you review it. Where an employer has authorised JobPilot to submit through their applicant-tracking system, you can send it from here with one click — after your review, never before.',
};

export class ApplicationModeError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = 'ApplicationModeError';
  }
}

export function isApplicationMode(value: unknown): value is ApplicationMode {
  return typeof value === 'string' && (APPLICATION_MODES as readonly string[]).includes(value);
}

/**
 * Parse a requested mode. The unreachable mode is refused with a reason that
 * names the decision; any other unknown value is refused too, so a stored
 * row can never quietly drift to a mode nobody chose.
 */
export function parseApplicationMode(value: unknown): ApplicationMode {
  if (value === UNREACHABLE_MODE) throw new ApplicationModeError('Approved Auto-Apply is not available. Autonomous submission is gated on lawfulness review and an explicit founder decision (ADR-0016, Stage 22).', 403);
  if (!isApplicationMode(value)) throw new ApplicationModeError(`Unknown application mode "${String(value)}".`, 422);
  return value;
}

/** A stored value read back: anything that is not a reachable mode is treated as the default, never as more. */
export function storedApplicationMode(value: string | null | undefined): ApplicationMode {
  return isApplicationMode(value) ? value : DEFAULT_APPLICATION_MODE;
}

export type ApplicationAction = 'generate_documents' | 'prepare_fields' | 'submit_on_instruction' | 'submit_unattended';

/**
 * What a mode permits. `submit_unattended` is false in EVERY mode — the row
 * exists so a test can prove it and a reader can see it.
 */
export const MODE_PERMITS: Record<ApplicationMode, Record<ApplicationAction, boolean>> = {
  recommend_only: { generate_documents: false, prepare_fields: false, submit_on_instruction: false, submit_unattended: false },
  prepare: { generate_documents: true, prepare_fields: true, submit_on_instruction: false, submit_unattended: false },
  review_submit: { generate_documents: true, prepare_fields: true, submit_on_instruction: true, submit_unattended: false },
};

export function modePermits(mode: ApplicationMode, action: ApplicationAction): boolean {
  return MODE_PERMITS[mode][action];
}

/** Refuse, with the applicant's own words, when the mode does not permit the action. */
export function assertModePermits(mode: ApplicationMode, action: ApplicationAction): void {
  if (modePermits(mode, action)) return;
  const label = MODE_LABELS[mode];
  const what =
    action === 'submit_unattended'
      ? 'JobPilot never submits an application without your instruction, in any mode.'
      : action === 'submit_on_instruction'
        ? `Your application mode is “${label}”: JobPilot does not submit on your behalf. Use the employer’s form, or switch to “Review & submit” in Settings.`
        : `Your application mode is “${label}”: JobPilot shows matches and prepares nothing. Switch to “Prepare” or “Review & submit” in Settings to prepare applications.`;
  throw new ApplicationModeError(what);
}

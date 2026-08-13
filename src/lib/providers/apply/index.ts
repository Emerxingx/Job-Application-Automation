import { atsDisplayName, detectAts, submitToAts } from './ats';
import type { ApplyOutcome, ApplyProvider, ApplyRequest, PreparedField } from './types';

export type {
  ApplicantProfile,
  ApplyChannel,
  ApplyOutcome,
  ApplyProvider,
  ApplyRequest,
  AtsTarget,
  AtsVendor,
  PreparedField,
} from './types';
export { atsDisplayName, detectAts } from './ats';

/**
 * Build the field set an employer form will ask for. Everything here is
 * already known, so the applicant confirms rather than retypes.
 */
function prepareFields(request: ApplyRequest): PreparedField[] {
  const { applicant } = request;
  const fields: PreparedField[] = [
    { key: 'full_name', label: 'Full name', value: applicant.fullName },
    { key: 'first_name', label: 'First name', value: applicant.firstName },
    { key: 'last_name', label: 'Last name', value: applicant.lastName },
    { key: 'email', label: 'Email', value: applicant.email },
  ];

  if (applicant.phone) fields.push({ key: 'phone', label: 'Phone', value: applicant.phone });
  if (applicant.location) {
    fields.push({ key: 'location', label: 'Location', value: applicant.location });
  }
  if (applicant.linkedinUrl) {
    fields.push({ key: 'linkedin', label: 'LinkedIn', value: applicant.linkedinUrl });
  }
  if (applicant.portfolioUrl) {
    fields.push({ key: 'portfolio', label: 'Portfolio / website', value: applicant.portfolioUrl });
  }
  if (applicant.workAuthorization) {
    fields.push({
      key: 'work_authorization',
      label: 'Are you legally authorized to work in this country?',
      value: applicant.workAuthorization,
    });
  }
  if (typeof applicant.requiresSponsorship === 'boolean') {
    fields.push({
      key: 'sponsorship',
      label: 'Will you now or in the future require sponsorship?',
      value: applicant.requiresSponsorship ? 'Yes' : 'No',
    });
  }

  fields.push(
    { key: 'resume', label: 'Resume (tailored to this posting)', value: request.resumeText, multiline: true },
    { key: 'cover_letter', label: 'Cover letter', value: request.coverLetter, multiline: true },
  );

  return fields;
}

/**
 * The default engine: submit through an authorized ATS API where one is
 * available, and prepare an assisted application everywhere else.
 */
export class DefaultApplyProvider implements ApplyProvider {
  readonly name = 'default';

  async apply(request: ApplyRequest): Promise<ApplyOutcome> {
    const applyUrl = request.job.applyUrl?.trim();

    if (!applyUrl) {
      return {
        ok: false,
        channel: 'unavailable',
        failureReason: 'This posting has no application link. The tailored documents are saved in your folder.',
      };
    }

    const target = detectAts(applyUrl);

    // 1. Authorized programmatic submission, where it is genuinely available.
    if (target) {
      const submitted = await submitToAts(target, request);
      if (submitted) return submitted;
    }

    // 2. Assisted: everything prepared, applicant confirms on the employer's form.
    const via = target ? ` on ${atsDisplayName(target.vendor)}` : '';
    return {
      ok: true,
      channel: 'assisted',
      ats: target?.vendor,
      assisted: {
        applyUrl,
        fields: prepareFields(request),
        guidance:
          `Your tailored resume and cover letter are ready. Open the employer's form${via}, ` +
          'paste each field below, and submit — usually under a minute.',
      },
    };
  }
}

/**
 * A provider that never submits on the applicant's behalf, for deployments
 * that want the strictest possible posture. Selected with APPLY_MODE=assisted.
 */
export class AssistedOnlyApplyProvider implements ApplyProvider {
  readonly name = 'assisted-only';

  async apply(request: ApplyRequest): Promise<ApplyOutcome> {
    const applyUrl = request.job.applyUrl?.trim();
    if (!applyUrl) {
      return {
        ok: false,
        channel: 'unavailable',
        failureReason: 'This posting has no application link. The tailored documents are saved in your folder.',
      };
    }
    const target = detectAts(applyUrl);
    const via = target ? ` on ${atsDisplayName(target.vendor)}` : '';
    return {
      ok: true,
      channel: 'assisted',
      ats: target?.vendor,
      assisted: {
        applyUrl,
        fields: prepareFields(request),
        guidance:
          `Your tailored resume and cover letter are ready. Open the employer's form${via}, ` +
          'paste each field below, and submit — usually under a minute.',
      },
    };
  }
}

/**
 * Simulated submission for the demo build. Keeps the walkthrough end-to-end
 * without contacting any employer, and never claims a real confirmation.
 */
export class MockApplyProvider implements ApplyProvider {
  readonly name = 'mock';

  async apply(request: ApplyRequest): Promise<ApplyOutcome> {
    await new Promise((r) => setTimeout(r, 180));
    let seed = 0;
    const key = `${request.job.company}:${request.job.title}`;
    for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;

    if (seed % 12 === 0) {
      return {
        ok: false,
        channel: 'ats_api',
        failureReason: 'Employer portal requires a manual assessment step — flagged for your review.',
      };
    }
    return {
      ok: true,
      channel: 'ats_api',
      confirmation: `JP-${seed.toString(36).toUpperCase().slice(0, 8)}`,
    };
  }
}

let cached: ApplyProvider | null = null;

/**
 * Resolve the apply engine.
 *
 * APPLY_MODE:
 *   mock     — simulated, for the demo build (default when JOB_PROVIDER=mock)
 *   auto     — ATS API where authorized, assisted everywhere else (default otherwise)
 *   assisted — never submit on the applicant's behalf
 */
export function getApplyProvider(): ApplyProvider {
  if (cached) return cached;

  const jobSource = (process.env.JOB_PROVIDER || 'mock').toLowerCase();
  const configured = (process.env.APPLY_MODE || (jobSource === 'mock' ? 'mock' : 'auto')).toLowerCase();

  switch (configured) {
    case 'assisted':
      cached = new AssistedOnlyApplyProvider();
      break;
    case 'auto':
      cached = new DefaultApplyProvider();
      break;
    case 'mock':
      cached = new MockApplyProvider();
      break;
    default:
      console.warn(`[apply] APPLY_MODE="${configured}" is unknown; using assisted-only.`);
      cached = new AssistedOnlyApplyProvider();
  }
  return cached;
}

/** Test seam — clears the memoized provider. */
export function resetApplyProvider(): void {
  cached = null;
}

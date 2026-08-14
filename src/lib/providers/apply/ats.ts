import type { ApplyRequest, AtsTarget, AtsVendor, ApplyOutcome } from './types';

/**
 * ATS detection and submission.
 *
 * Detection is URL-shape based and cheap. Submission is only attempted where
 * two conditions both hold:
 *
 *   1. the vendor publishes an application-submission API, and
 *   2. this deployment holds a credential the employer issued for that board.
 *
 * Condition 2 is the one people forget. Greenhouse and Lever expose *reading*
 * a job board publicly, but posting an application requires a board token or
 * API key that the employer grants. Without it the correct behaviour is to
 * fall back to assisted apply — not to POST hopefully at an endpoint and
 * report a success we cannot observe.
 */

/** Vendors whose submission API this build can drive when credentialed. */
const SUBMITTABLE: ReadonlySet<AtsVendor> = new Set<AtsVendor>(['greenhouse', 'lever']);

interface DetectRule {
  vendor: AtsVendor;
  hostPattern: RegExp;
  /** Pull { tenant, postingId } out of the URL. */
  parse(url: URL): { tenant?: string; postingId?: string };
}

const RULES: DetectRule[] = [
  {
    vendor: 'greenhouse',
    hostPattern: /(^|\.)(greenhouse\.io|grnh\.se)$/i,
    // boards.greenhouse.io/acme/jobs/4012345  |  job-boards.greenhouse.io/acme/jobs/4012345
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      const jobsAt = parts.indexOf('jobs');
      return {
        tenant: parts[0],
        postingId: jobsAt >= 0 ? parts[jobsAt + 1] : url.searchParams.get('gh_jid') ?? undefined,
      };
    },
  },
  {
    vendor: 'lever',
    hostPattern: /(^|\.)lever\.co$/i,
    // jobs.lever.co/acme/2f1a-uuid
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      return { tenant: parts[0], postingId: parts[1] };
    },
  },
  {
    vendor: 'ashby',
    hostPattern: /(^|\.)ashbyhq\.com$/i,
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      return { tenant: parts[0], postingId: parts[1] };
    },
  },
  {
    vendor: 'workable',
    hostPattern: /(^|\.)workable\.com$/i,
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      const jAt = parts.indexOf('j');
      return { tenant: parts[0], postingId: jAt >= 0 ? parts[jAt + 1] : parts[1] };
    },
  },
  {
    vendor: 'smartrecruiters',
    hostPattern: /(^|\.)smartrecruiters\.com$/i,
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      return { tenant: parts[0], postingId: parts[1] };
    },
  },
  {
    vendor: 'workday',
    hostPattern: /(^|\.)(myworkdayjobs\.com|workday\.com)$/i,
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      return { tenant: url.hostname.split('.')[0], postingId: parts[parts.length - 1] };
    },
  },
  {
    vendor: 'bamboohr',
    hostPattern: /(^|\.)bamboohr\.com$/i,
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      return { tenant: url.hostname.split('.')[0], postingId: parts[parts.length - 1] };
    },
  },
  {
    vendor: 'jazzhr',
    hostPattern: /(^|\.)(applytojob\.com|jazz\.co)$/i,
    parse: (url) => ({
      tenant: url.hostname.split('.')[0],
      postingId: url.pathname.split('/').filter(Boolean).pop(),
    }),
  },
  {
    vendor: 'recruitee',
    hostPattern: /(^|\.)recruitee\.com$/i,
    parse: (url) => {
      const parts = url.pathname.split('/').filter(Boolean);
      return { tenant: url.hostname.split('.')[0], postingId: parts[parts.length - 1] };
    },
  },
];

/** Identify the applicant-tracking system behind an apply URL. */
export function detectAts(applyUrl: string): AtsTarget | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }

  for (const rule of RULES) {
    if (!rule.hostPattern.test(url.hostname)) continue;
    const { tenant, postingId } = rule.parse(url);
    if (!tenant) return null;
    return {
      vendor: rule.vendor,
      tenant,
      postingId,
      submittable: SUBMITTABLE.has(rule.vendor),
    };
  }
  return null;
}

/** Human-readable vendor name for UI copy. */
export function atsDisplayName(vendor: AtsVendor): string {
  const names: Record<AtsVendor, string> = {
    greenhouse: 'Greenhouse',
    lever: 'Lever',
    ashby: 'Ashby',
    workable: 'Workable',
    smartrecruiters: 'SmartRecruiters',
    workday: 'Workday',
    bamboohr: 'BambooHR',
    jazzhr: 'JazzHR',
    recruitee: 'Recruitee',
  };
  return names[vendor];
}

/**
 * Read the credential an employer issued for this board, if this deployment
 * holds one. Keys are namespaced per vendor and tenant, e.g.
 * `ATS_GREENHOUSE_ACME=<token>`, so one deployment can serve many employers
 * without them sharing a credential.
 */
function credentialFor(target: AtsTarget): string | undefined {
  const slug = target.tenant.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return (
    process.env[`ATS_${target.vendor.toUpperCase()}_${slug}`] ||
    process.env[`ATS_${target.vendor.toUpperCase()}_DEFAULT`] ||
    undefined
  );
}

const TIMEOUT_MS = 20_000;

async function postForm(
  url: string,
  body: FormData,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt a programmatic submission.
 *
 * Returns `null` when this posting cannot be submitted programmatically —
 * unsupported vendor, missing posting id, or no employer credential. `null`
 * means "fall back to assisted", and is the common case by design.
 */
export async function submitToAts(
  target: AtsTarget,
  request: ApplyRequest,
): Promise<ApplyOutcome | null> {
  if (!target.submittable || !target.postingId) return null;

  const credential = credentialFor(target);
  if (!credential) return null;

  const resumeBlob = new Blob([request.resumeText], { type: 'text/plain' });
  const coverBlob = new Blob([request.coverLetter], { type: 'text/plain' });
  const { applicant } = request;

  try {
    if (target.vendor === 'greenhouse') {
      const form = new FormData();
      form.set('first_name', applicant.firstName);
      form.set('last_name', applicant.lastName);
      form.set('email', applicant.email);
      if (applicant.phone) form.set('phone', applicant.phone);
      if (applicant.linkedinUrl) form.set('linkedin_url', applicant.linkedinUrl);
      form.set('resume', resumeBlob, 'resume.txt');
      form.set('cover_letter', coverBlob, 'cover-letter.txt');

      const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
        target.tenant,
      )}/jobs/${encodeURIComponent(target.postingId)}`;

      const res = await postForm(endpoint, form, {
        Authorization: `Basic ${Buffer.from(`${credential}:`).toString('base64')}`,
      });

      if (res.ok) {
        let confirmation: string | undefined;
        try {
          confirmation = String(JSON.parse(res.text)?.id ?? '') || undefined;
        } catch {
          /* a non-JSON 2xx still means accepted */
        }
        return { ok: true, channel: 'ats_api', ats: 'greenhouse', confirmation };
      }
      return {
        ok: false,
        channel: 'ats_api',
        ats: 'greenhouse',
        failureReason: `Greenhouse rejected the application (${res.status}).`,
      };
    }

    if (target.vendor === 'lever') {
      const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(
        target.tenant,
      )}/${encodeURIComponent(target.postingId)}?key=${encodeURIComponent(credential)}`;

      const form = new FormData();
      form.set('name', applicant.fullName);
      form.set('email', applicant.email);
      if (applicant.phone) form.set('phone', applicant.phone);
      if (applicant.linkedinUrl) form.set('urls[LinkedIn]', applicant.linkedinUrl);
      form.set('comments', request.coverLetter);
      form.set('resume', resumeBlob, 'resume.txt');

      const res = await postForm(endpoint, form, {});
      if (res.ok) {
        return { ok: true, channel: 'ats_api', ats: 'lever' };
      }
      return {
        ok: false,
        channel: 'ats_api',
        ats: 'lever',
        failureReason: `Lever rejected the application (${res.status}).`,
      };
    }
  } catch (error) {
    console.error('[apply/ats] submission error:', error);
    return {
      ok: false,
      channel: 'ats_api',
      ats: target.vendor,
      failureReason: 'The employer system did not respond. Prepared for manual submission instead.',
    };
  }

  return null;
}

import { createHash } from 'node:crypto';
import type { RawJobPosting } from '@/lib/types';
import { detectAts } from '@/lib/providers/apply';
import type { ApplicationRoute, NormalizedPosting, ValidationResult } from './types';

/**
 * Shared behaviour every adapter gets for free, so the contract suite tests
 * one implementation of normalisation, validation and routing rather than
 * one per source.
 */

const MAX_DESCRIPTION = 50_000;
const MAX_LIST = 60;

/** Map the provider shape to the canonical posting. Pure and total. */
export function normalizePosting(raw: RawJobPosting): NormalizedPosting {
  const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
  const list = (xs: string[] | undefined) => [...new Set((xs ?? []).map((x) => clean(x)).filter(Boolean))].slice(0, MAX_LIST);
  const posted = raw.postedAt instanceof Date ? raw.postedAt : new Date(raw.postedAt);
  return {
    source: raw.source,
    externalId: String(raw.externalId),
    title: clean(raw.title),
    company: clean(raw.company) || 'Employer not disclosed',
    companyLogo: raw.companyLogo || undefined,
    location: clean(raw.location),
    country: raw.country,
    workMode: raw.workMode,
    jobType: raw.jobType,
    salaryMin: raw.salaryMin && raw.salaryMin > 0 ? Math.round(raw.salaryMin) : undefined,
    salaryMax: raw.salaryMax && raw.salaryMax > 0 ? Math.round(raw.salaryMax) : undefined,
    salaryCurrency: raw.salaryCurrency || (raw.country === 'US' ? 'USD' : 'CAD'),
    description: (raw.description ?? '').trim().slice(0, MAX_DESCRIPTION),
    requirements: list(raw.requirements),
    skills: list(raw.skills),
    nocCode: raw.nocCode || undefined,
    applyUrl: clean(raw.applyUrl),
    applyMethod: raw.applyMethod,
    postedAt: (Number.isNaN(posted.getTime()) ? new Date(0) : posted).toISOString(),
  };
}

/**
 * Validation is conservative: a posting that would be stored with a broken
 * apply link, an unparseable date or an impossible salary is rejected with a
 * stable reason code the run report counts.
 */
export function validatePosting(p: NormalizedPosting): ValidationResult {
  const reasons: string[] = [];
  if (!p.externalId) reasons.push('missing_external_id');
  if (!p.title) reasons.push('missing_title');
  if (p.title.length > 300) reasons.push('title_too_long');
  if (!p.applyUrl) reasons.push('missing_apply_url');
  else {
    try {
      const u = new URL(p.applyUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') reasons.push('apply_url_not_http');
    } catch {
      reasons.push('apply_url_invalid');
    }
  }
  if (p.country !== 'CA' && p.country !== 'US') reasons.push('unsupported_country');
  if (p.postedAt === new Date(0).toISOString()) reasons.push('posted_at_invalid');
  else if (new Date(p.postedAt).getTime() > Date.now() + 86_400_000) reasons.push('posted_at_in_future');
  if (p.salaryMin !== undefined && p.salaryMax !== undefined && p.salaryMin > p.salaryMax) reasons.push('salary_range_inverted');
  if (!/^[A-Z]{3}$/.test(p.salaryCurrency)) reasons.push('currency_invalid');
  return { ok: reasons.length === 0, reasons };
}

/** Content hash of a normalised posting: what a JobSnapshot is keyed on. */
export function postingHash(p: NormalizedPosting): string {
  const { source, externalId, ...content } = p;
  void source;
  void externalId;
  return createHash('sha256').update(JSON.stringify(content, Object.keys(content).sort())).digest('hex');
}

/**
 * The route decision feeds the apply engine's channel (ADR-0016): an ATS
 * API only where one is published AND this deployment holds a credential for
 * it — either one issued for that employer's tenant (`ATS_<VENDOR>_<TENANT>`)
 * or the deployment-wide `ATS_<VENDOR>_DEFAULT` the apply engine already
 * honours, which is a deployment decision rather than an employer's;
 * assisted everywhere an ATS is detected without one; external for the rest.
 * Detection reuses the apply engine's rules.
 */
export function applicationRouteFor(p: NormalizedPosting): ApplicationRoute {
  const target = detectAts(p.applyUrl);
  if (!target) return { channel: 'external' };
  const credential = process.env[`ATS_${target.vendor.toUpperCase()}_${(target.tenant ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || process.env[`ATS_${target.vendor.toUpperCase()}_DEFAULT`];
  return { channel: credential ? 'ats_api' : 'assisted', vendor: target.vendor };
}

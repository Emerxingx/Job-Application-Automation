/**
 * Stage 18 (ADR-0033) - the first-party source: requisitions that employer
 * organisations publish ON this platform. Not a third-party source and not
 * a crawl: the rows are the employers' own, authored under the platform's
 * terms, so the register record is complete by construction and the source
 * is enabled by default alongside the mock. It runs through the same gate,
 * pipeline and canonicalisation as every other source (ADR-0008): a
 * published requisition becomes a canonical `Job` (`source: employer`,
 * `externalId: <requisition id>`) that candidates' agents match like any
 * posting, and closure is what the requisition's status SAYS.
 */
import { db } from '@/lib/db';
import { appUrl } from '@/lib/app-url';
import type { JobSearchQuery, RawJobPosting } from '@/lib/types';
import { applicationRouteFor, normalizePosting, validatePosting } from './base';
import type { ApplicationRoute, DiscoveredPosting, HealthReport, JobSourceConnector, NormalizedPosting, RefreshState } from './types';

export const EMPLOYER_SOURCE_KEY = 'employer';

type RequisitionRow = {
  id: string;
  title: string;
  location: string;
  country: string;
  workMode: string;
  jobType: string;
  description: string;
  requiredSkills: string;
  preferredSkills: string;
  certificationRequirements: string;
  experienceYearsMin: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  status: string;
  openedAt: Date | null;
  createdAt: Date;
  organization: { name: string };
};

function list(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The posting a requisition publishes as. Pure given the row. */
export function requisitionToPosting(r: RequisitionRow): RawJobPosting {
  const required = list(r.requiredSkills);
  const preferred = list(r.preferredSkills);
  const certs = list(r.certificationRequirements);
  const requirements = [
    ...required.map((s) => `Required: ${s}`),
    ...preferred.map((s) => `Preferred: ${s}`),
    ...certs.map((c) => `Certification: ${c}`),
    ...(r.experienceYearsMin !== null ? [`${r.experienceYearsMin}+ years of experience`] : []),
  ];
  return {
    source: EMPLOYER_SOURCE_KEY,
    externalId: r.id,
    title: r.title,
    company: r.organization.name,
    location: r.location,
    country: r.country === 'US' ? 'US' : 'CA',
    workMode: r.workMode === 'remote' || r.workMode === 'hybrid' ? r.workMode : 'onsite',
    jobType: r.jobType === 'part_time' || r.jobType === 'contract' || r.jobType === 'internship' ? r.jobType : 'full_time',
    salaryMin: r.salaryMin ?? undefined,
    salaryMax: r.salaryMax ?? undefined,
    salaryCurrency: r.salaryCurrency || 'CAD',
    description: r.description,
    requirements,
    skills: [...required, ...preferred],
    applyUrl: `${appUrl()}/dashboard/jobs/by-requisition/${r.id}`,
    applyMethod: 'ats_form',
    postedAt: r.openedAt ?? r.createdAt,
  };
}

const SELECT = { id: true, title: true, location: true, country: true, workMode: true, jobType: true, description: true, requiredSkills: true, preferredSkills: true, certificationRequirements: true, experienceYearsMin: true, salaryMin: true, salaryMax: true, salaryCurrency: true, status: true, openedAt: true, createdAt: true, organization: { select: { name: true } } } as const;

/**
 * Where the connector reads requisitions from. The database by default; an
 * in-memory catalogue for the contract suite, which runs without one - the
 * connector's behaviour is the same either way, which is the point of the
 * seam.
 */
export interface RequisitionCatalogue {
  open(query: JobSearchQuery): Promise<RequisitionRow[]>;
  byId(id: string): Promise<RequisitionRow | null>;
  statuses(ids: string[]): Promise<{ id: string; status: string }[]>;
  countOpen(): Promise<number>;
}

const databaseCatalogue: RequisitionCatalogue = {
  async open(query) {
    const terms = [...query.titles, ...(query.keywords ?? [])].map((t) => t.trim()).filter(Boolean);
    return db.requisition.findMany({
      // A suspended or closed organisation's postings are not discoverable.
      where: { status: 'open', organization: { status: 'active' }, ...(query.country ? { country: query.country } : {}), ...(terms.length ? { OR: terms.map((t) => ({ title: { contains: t, mode: 'insensitive' as const } })) } : {}) },
      select: SELECT,
      orderBy: { openedAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 50, 1), 200),
    });
  },
  byId: (id) => db.requisition.findUnique({ where: { id }, select: SELECT }),
  statuses: (ids) => db.requisition.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }),
  countOpen: () => db.requisition.count({ where: { status: 'open', organization: { status: 'active' } } }),
};

/** An in-memory catalogue (tests): the same filtering the database applies, over given rows. */
export function inMemoryCatalogue(rows: RequisitionRow[]): RequisitionCatalogue {
  return {
    async open(query) {
      const terms = [...query.titles, ...(query.keywords ?? [])].map((t) => t.trim().toLowerCase()).filter(Boolean);
      return rows
        .filter((r) => r.status === 'open' && (!query.country || r.country === query.country) && (terms.length === 0 || terms.some((t) => r.title.toLowerCase().includes(t))))
        .slice(0, Math.min(Math.max(query.limit ?? 50, 1), 200));
    },
    async byId(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async statuses(ids) {
      return rows.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, status: r.status }));
    },
    async countOpen() {
      return rows.filter((r) => r.status === 'open').length;
    },
  };
}

export class EmployerConnector implements JobSourceConnector {
  readonly key = EMPLOYER_SOURCE_KEY;
  readonly name = 'Employer postings on this platform';
  readonly kind = 'career_page' as const;
  readonly credentialEnvVars: readonly string[] = [];
  private readonly catalogue: RequisitionCatalogue;

  constructor(catalogue: RequisitionCatalogue = databaseCatalogue) {
    this.catalogue = catalogue;
  }

  /** Open requisitions matching the query's titles or keywords (search criteria only, never candidate identity). */
  async discover(query: JobSearchQuery): Promise<DiscoveredPosting[]> {
    return (await this.catalogue.open(query)).map(requisitionToPosting);
  }
  async fetch(externalId: string): Promise<DiscoveredPosting | null> {
    const row = await this.catalogue.byId(externalId);
    return row ? requisitionToPosting(row) : null;
  }
  normalize(raw: DiscoveredPosting): NormalizedPosting {
    return normalizePosting(raw);
  }
  validate(posting: NormalizedPosting) {
    return validatePosting(posting);
  }
  /**
   * Closure is what the requisition's status says: filled or closed is
   * closed; on hold is unknown. An id this source does not hold answers
   * `unknown`, as the connector contract requires of every source (silence
   * never infers closure; Stage 06): a requisition that was DELETED with
   * its organisation leaves a posting freshness marks unconfirmed, and a
   * requisition that was closed says so itself before it goes.
   */
  async refresh(externalIds: string[]): Promise<Record<string, RefreshState>> {
    const rows = await this.catalogue.statuses(externalIds);
    const out: Record<string, RefreshState> = {};
    for (const id of externalIds) {
      const r = rows.find((x) => x.id === id);
      out[id] = !r ? 'unknown' : r.status === 'open' ? 'active' : r.status === 'filled' || r.status === 'closed' ? 'closed' : 'unknown';
    }
    return out;
  }
  async detectClosed(externalId: string): Promise<RefreshState> {
    return (await this.refresh([externalId]))[externalId] ?? 'unknown';
  }
  /**
   * A first-party posting is applied to ON this platform: the candidate's
   * own act creates a disclosure and a submission (employer/service.ts). Any
   * other apply link (a posting this source never issued) is routed like
   * every source's, by the shared detector.
   */
  getApplicationRoute(posting: NormalizedPosting): ApplicationRoute {
    if (posting.applyUrl?.startsWith(`${appUrl()}/dashboard/jobs/by-requisition/`)) return { channel: 'assisted', vendor: 'jobpilot' };
    return applicationRouteFor(posting);
  }
  async healthCheck(): Promise<HealthReport> {
    const started = Date.now();
    const n = await this.catalogue.countOpen();
    return { status: 'ok', latencyMs: Date.now() - started, detail: `${n} open requisition(s)` };
  }
}

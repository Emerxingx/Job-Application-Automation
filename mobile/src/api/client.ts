/**
 * The one HTTP client, typed from the frozen contract.
 *
 * `src/api/schema.d.ts` is GENERATED from ../docs/api/openapi.candidate.v1.json
 * (`npm run api:types`); the types below are aliases into it, so a contract
 * change that removes or renames a field is a compile error here rather than
 * a runtime surprise on a phone (MOBILE_ARCHITECTURE.md). `PATHS` lists every
 * path the app calls, and tests/contract-parity.test.ts fails if one of them
 * is not in the document or the document has an operation nothing here uses.
 *
 * Nothing here is clever about auth: the bearer token is whatever the session
 * holds, and a 401 is reported through `onUnauthorized` so the session can
 * end itself - the app never retries a credential the server refused.
 */
import type { components } from './schema';
import { ApiError, MalformedResponseError, NetworkError, isErrorEnvelope } from './errors';

type S = components['schemas'];
export type Me = S['Me'];
export type MeUpdate = S['MeUpdate'];
export type Job = S['Job'];
export type JobList = S['JobList'];
export type JobDetail = S['JobDetail'];
export type MatchAnalysis = S['MatchAnalysis'];
export type Application = S['Application'];
export type ApplicationList = S['ApplicationList'];
export type ApplicationDetail = S['ApplicationDetail'];
export type Interview = S['Interview'];
export type InterviewList = S['InterviewList'];
export type Notification = S['Notification'];
export type NotificationList = S['NotificationList'];
export type AnalyticsSummary = S['AnalyticsSummary'];
export type DeviceSignIn = S['DeviceSignIn'];
export type DeviceSessionIssued = S['DeviceSessionIssued'];
export type DeviceSession = S['DeviceSession'];
export type DeviceSessionList = S['DeviceSessionList'];
export type Consent = S['Consent'];
export type ConsentList = S['ConsentList'];
export type SavedJob = S['SavedJob'];
export type SavedJobList = S['SavedJobList'];
export type DocumentLink = S['DocumentLink'];
export type Evidence = S['Evidence'];
export type EvidenceList = S['EvidenceList'];
export type Revoked = S['Revoked'];
export type ListPagination = S['ListPagination'];

/** The contract's server prefix (`servers[0].url`) plus the version. */
export const API_PREFIX = '/api';

/** Every contract path the app uses, verbatim, for the parity test. */
export const PATHS = {
  me: '/v1/me',
  recommendations: '/v1/recommendations',
  jobs: '/v1/jobs',
  job: '/v1/jobs/{jobId}',
  jobSaved: '/v1/jobs/{jobId}/saved',
  savedJobs: '/v1/saved-jobs',
  match: '/v1/matches/{matchId}',
  applications: '/v1/applications',
  application: '/v1/applications/{applicationId}',
  confirm: '/v1/applications/{applicationId}/confirm',
  submit: '/v1/applications/{applicationId}/submit',
  documentLink: '/v1/applications/{applicationId}/documents/{documentId}/link',
  interviews: '/v1/interviews',
  notifications: '/v1/notifications',
  analyticsSummary: '/v1/analytics/summary',
  sessions: '/v1/auth/sessions',
  currentSession: '/v1/auth/sessions/current',
  session: '/v1/auth/sessions/{sessionId}',
  consents: '/v1/consents',
  consent: '/v1/consents/{purpose}',
  evidence: '/v1/evidence',
} as const;

export type Page = {
  limit?: number;
  offset?: number;
};

export interface ClientOptions {
  /** e.g. https://app.jobpilot.example - no trailing slash, no /api. */
  baseUrl: string;
  /** The device key, or null before sign-in. */
  token: () => string | null;
  fetchImpl?: typeof fetch;
  /** Called once per 401 so the session can end; the error is still thrown. */
  onUnauthorized?: (error: ApiError) => void;
  /** Milliseconds before a request is abandoned as a network failure. */
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** The request has no key (sign-in). */
  anonymous?: boolean;
}

/** Substitute `{name}` segments, URL-encoded. Throws on a missing value: a path with a hole is never sent. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`Missing path parameter ${name} for ${template}`);
    return encodeURIComponent(value);
  });
}

export function buildUrl(baseUrl: string, path: string, query?: RequestOptions['query']): string {
  const url = new URL(API_PREFIX + path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export class ApiClient {
  constructor(private readonly options: ClientOptions) {}

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!options.anonymous) {
      const token = this.options.token();
      if (!token) {
        const error = new ApiError(401, { type: 'authentication_error', code: 'unauthorized', message: 'Not signed in.' });
        this.options.onUnauthorized?.(error);
        throw error;
      }
      headers.Authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000) : null;
    let response: Response;
    try {
      response = await fetchImpl(buildUrl(this.options.baseUrl, path, options.query), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller?.signal,
      });
    } catch (cause) {
      throw new NetworkError('The server could not be reached.', cause);
    } finally {
      if (timer) clearTimeout(timer);
    }

    let parsed: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new MalformedResponseError(response.status);
      }
    }
    if (response.ok) return parsed as T;
    if (!isErrorEnvelope(parsed)) throw new MalformedResponseError(response.status);
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
    const error = new ApiError(response.status, parsed.error, retryAfter);
    if (error.unauthorized && !options.anonymous) this.options.onUnauthorized?.(error);
    throw error;
  }

  // --- auth ---------------------------------------------------------------
  signIn(body: DeviceSignIn): Promise<DeviceSessionIssued> {
    return this.request('POST', PATHS.sessions, { body, anonymous: true });
  }
  devices(page: Page = {}): Promise<DeviceSessionList> {
    return this.request('GET', PATHS.sessions, { query: page });
  }
  signOut(): Promise<Revoked> {
    return this.request('DELETE', PATHS.currentSession);
  }
  revokeDevice(sessionId: string): Promise<Revoked> {
    return this.request('DELETE', fillPath(PATHS.session, { sessionId }));
  }

  // --- profile, consent, evidence -------------------------------------------
  me(): Promise<Me> {
    return this.request('GET', PATHS.me);
  }
  updateMe(patch: MeUpdate): Promise<Me> {
    return this.request('PATCH', PATHS.me, { body: patch });
  }
  consents(): Promise<ConsentList> {
    return this.request('GET', PATHS.consents);
  }
  setConsent(purpose: Consent['purpose'], granted: boolean): Promise<Consent> {
    return this.request('PUT', fillPath(PATHS.consent, { purpose }), { body: { granted } });
  }
  evidence(page: Page = {}, status?: Evidence['status']): Promise<EvidenceList> {
    return this.request('GET', PATHS.evidence, { query: { ...page, status } });
  }
  analyticsSummary(): Promise<AnalyticsSummary> {
    return this.request('GET', PATHS.analyticsSummary);
  }

  // --- jobs ----------------------------------------------------------------
  recommendations(page: Page = {}): Promise<JobList> {
    return this.request('GET', PATHS.recommendations, { query: page });
  }
  jobs(page: Page = {}, query: { minScore?: number } = {}): Promise<JobList> {
    return this.request('GET', PATHS.jobs, { query: { ...page, ...query } });
  }
  job(jobId: string): Promise<JobDetail> {
    return this.request('GET', fillPath(PATHS.job, { jobId }));
  }
  match(matchId: string): Promise<MatchAnalysis> {
    return this.request('GET', fillPath(PATHS.match, { matchId }));
  }
  saveJob(jobId: string): Promise<SavedJob> {
    return this.request('PUT', fillPath(PATHS.jobSaved, { jobId }));
  }
  unsaveJob(jobId: string): Promise<Revoked> {
    return this.request('DELETE', fillPath(PATHS.jobSaved, { jobId }));
  }
  savedJobs(page: Page = {}): Promise<SavedJobList> {
    return this.request('GET', PATHS.savedJobs, { query: page });
  }

  // --- the folder ---------------------------------------------------------------
  applications(page: Page = {}, query: { status?: string } = {}): Promise<ApplicationList> {
    return this.request('GET', PATHS.applications, { query: { ...page, ...query } });
  }
  application(applicationId: string): Promise<ApplicationDetail> {
    return this.request('GET', fillPath(PATHS.application, { applicationId }));
  }
  /** The applicant records that they submitted on the employer's form (ADR-0016: nothing is sent by JobPilot). */
  confirm(applicationId: string): Promise<ApplicationDetail> {
    return this.request('POST', fillPath(PATHS.confirm, { applicationId }));
  }
  /** The applicant's instructed submission through an employer-authorised ATS, after review (Stage 12). */
  submit(applicationId: string): Promise<ApplicationDetail> {
    return this.request('POST', fillPath(PATHS.submit, { applicationId }));
  }
  documentLink(applicationId: string, documentId: string): Promise<DocumentLink> {
    return this.request('POST', fillPath(PATHS.documentLink, { applicationId, documentId }));
  }
  interviews(page: Page = {}, query: { from?: string } = {}): Promise<InterviewList> {
    return this.request('GET', PATHS.interviews, { query: { ...page, ...query } });
  }
  notifications(page: Page = {}): Promise<NotificationList> {
    return this.request('GET', PATHS.notifications, { query: page });
  }
}

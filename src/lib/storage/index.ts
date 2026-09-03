import path from 'path';
import type { TailoringNotes } from '../types';
import type { StorageProvider } from './provider';
import { LocalStorageProvider } from './local';

export type { StorageProvider, StoredObject } from './provider';

/**
 * Application folder generation.
 *
 * Every submitted application gets its own folder containing the customized
 * resume, the cover letter, the job description as it appeared at apply time,
 * and a summary of what the tailoring changed. This is a promise of the
 * product — the applicant can always see exactly what was sent on their behalf.
 *
 * Layout (a key prefix, whatever the store):
 *   <userId>/applications/<YYYY-MM>/<company>-<title>-<id>/
 *     ├── README.md              overview + index
 *     ├── job-description.md     posting as captured
 *     ├── resume.txt             the tailored resume that was submitted
 *     ├── cover-letter.txt       the cover letter that was submitted
 *     └── tailoring-report.md    what changed and why
 *
 * Stage 05 (ADR-0015): the bytes live behind a StorageProvider. The local
 * filesystem is the default and needs nothing; STORAGE_PROVIDER=s3 selects an
 * S3-compatible store whose region must be on the residency allow-list, with
 * warn-and-degrade to local when its configuration is incomplete.
 */

let provider: StorageProvider | null = null;

/** Tests only: forget the resolved provider so a different environment can be exercised. */
export function resetStorageProviderForTests(): void {
  provider = null;
}

export async function getStorageProvider(): Promise<StorageProvider> {
  if (provider) return provider;
  const configured = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  if (configured === 's3') {
    // Imported lazily so the signer never loads in local deployments.
    const { readS3Config, S3StorageProvider } = await import('./s3');
    const config = readS3Config();
    if (!config) {
      console.warn('[storage] STORAGE_PROVIDER=s3 but STORAGE_S3_* is incomplete; using the local filesystem.');
    } else {
      try {
        provider = new S3StorageProvider(config);
        return provider;
      } catch (error) {
        // A region outside the residency allow-list (ADR-0015). Data stays on
        // this server rather than leaving the country; the error is logged
        // once here and the fallback is remembered so the failure is not
        // re-attempted (and re-logged) on every folder.
        console.error('[storage] S3 provider refused; using the local filesystem:', error instanceof Error ? error.message : error);
      }
    }
  } else if (configured !== 'local') {
    console.warn(`[storage] STORAGE_PROVIDER="${configured}" is not implemented; using the local filesystem.`);
  }
  provider = new LocalStorageProvider();
  return provider;
}

/** Test seam. */
export function resetStorageProvider(): void {
  provider = null;
}

/** Filesystem-safe slug. */
function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'untitled'
  );
}

export interface FolderInput {
  userId: string;
  applicationId: string;
  job: {
    title: string;
    company: string;
    location: string;
    workMode: string;
    jobType: string;
    salaryMin?: number | null;
    salaryMax?: number | null;
    salaryCurrency?: string;
    description: string;
    requirements: string[];
    skills: string[];
    nocCode?: string | null;
    applyUrl: string;
    postedAt: Date;
  };
  matchScore: number;
  resumeText: string;
  coverLetter: string;
  notes: TailoringNotes;
  appliedAt: Date;
}

export interface FolderFile {
  name: string;
  size: number;
  description: string;
}

/**
 * Write the application folder. Returns the path relative to the storage root.
 *
 * Filesystem failures are non-fatal: the documents are also stored in the
 * database, so a read-only or ephemeral filesystem degrades the feature
 * rather than failing the application.
 */
export async function createApplicationFolder(input: FolderInput): Promise<string> {
  const month = input.appliedAt.toISOString().slice(0, 7); // YYYY-MM
  const folderName = `${slug(input.job.company)}-${slug(input.job.title)}-${input.applicationId.slice(-6)}`;
  const relative = path.posix.join('applications', month, folderName);
  const prefix = path.posix.join(input.userId, relative);

  try {
    const store = await getStorageProvider();
    await Promise.all([
      store.put(`${prefix}/README.md`, renderReadme(input)),
      store.put(`${prefix}/job-description.md`, renderJobDescription(input)),
      store.put(`${prefix}/resume.txt`, input.resumeText),
      store.put(`${prefix}/cover-letter.txt`, input.coverLetter),
      store.put(`${prefix}/tailoring-report.md`, renderTailoringReport(input)),
    ]);

    return relative;
  } catch (error) {
    console.error('[storage] could not write application folder:', error);
    return '';
  }
}

/** List the files in a stored application folder. */
export async function listFolder(userId: string, relative: string): Promise<FolderFile[]> {
  if (!relative) return [];

  const DESCRIPTIONS: Record<string, string> = {
    'README.md': 'Overview of this application',
    'job-description.md': 'The posting exactly as it appeared when you applied',
    'resume.txt': 'The customized resume that was submitted',
    'cover-letter.txt': 'The cover letter that was submitted',
    'tailoring-report.md': 'What the AI changed, and why',
  };

  try {
    const objects = await (await getStorageProvider()).list(path.posix.join(userId, relative));
    return objects
      .map((o) => ({ name: path.posix.basename(o.key), size: o.size, description: DESCRIPTIONS[path.posix.basename(o.key)] ?? 'Supporting document' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Read one file from an application folder, guarding against path traversal. */
export async function readFolderFile(
  userId: string,
  relative: string,
  fileName: string,
): Promise<string | null> {
  // The file name comes from a URL — never let it escape the folder: only a
  // bare basename is accepted, and the key is built from parts we own.
  const safeName = path.posix.basename(fileName);
  if (!safeName || safeName === '.' || safeName === '..' || safeName !== fileName) return null;
  const safeRelative = path.posix.normalize(relative);
  if (!safeRelative || safeRelative.startsWith('..') || path.posix.isAbsolute(safeRelative)) return null;

  try {
    return await (await getStorageProvider()).get(path.posix.join(userId, safeRelative, safeName));
  } catch {
    return null;
  }
}

// --- renderers -------------------------------------------------------------

function money(input: FolderInput): string {
  const { salaryMin, salaryMax, salaryCurrency } = input.job;
  if (!salaryMin && !salaryMax) return 'Not disclosed';
  const cur = salaryCurrency || 'CAD';
  if (salaryMin && salaryMax)
    return `${cur} ${salaryMin.toLocaleString()} – ${salaryMax.toLocaleString()}`;
  return `${cur} ${(salaryMin || salaryMax)!.toLocaleString()}`;
}

function renderReadme(input: FolderInput): string {
  return [
    `# ${input.job.title} — ${input.job.company}`,
    '',
    '## Application summary',
    '',
    `| | |`,
    `|---|---|`,
    `| **Company** | ${input.job.company} |`,
    `| **Position** | ${input.job.title} |`,
    `| **Location** | ${input.job.location} (${input.job.workMode}) |`,
    `| **Employment type** | ${input.job.jobType.replace(/_/g, ' ')} |`,
    `| **Compensation** | ${money(input)} |`,
    `| **Posted** | ${input.job.postedAt.toDateString()} |`,
    `| **Applied** | ${input.appliedAt.toDateString()} |`,
    `| **Match score** | ${input.matchScore}% |`,
    `| **ATS score after tailoring** | ${input.notes.atsScore}% |`,
    input.job.nocCode ? `| **NOC code** | ${input.job.nocCode} |` : '',
    `| **Posting URL** | ${input.job.applyUrl} |`,
    '',
    '## Files in this folder',
    '',
    '- `job-description.md` — the posting exactly as it appeared when you applied',
    '- `resume.txt` — the customized resume that was submitted',
    '- `cover-letter.txt` — the cover letter that was submitted',
    '- `tailoring-report.md` — what was changed to align with this posting',
    '',
    '---',
    '',
    '_Generated by JobPilot AI._',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderJobDescription(input: FolderInput): string {
  return [
    `# ${input.job.title}`,
    `## ${input.job.company} — ${input.job.location}`,
    '',
    `**Posted:** ${input.job.postedAt.toDateString()}  `,
    `**Work mode:** ${input.job.workMode}  `,
    `**Employment type:** ${input.job.jobType.replace(/_/g, ' ')}  `,
    `**Compensation:** ${money(input)}  `,
    input.job.nocCode ? `**NOC code:** ${input.job.nocCode}  ` : '',
    `**Source:** ${input.job.applyUrl}`,
    '',
    '---',
    '',
    input.job.description,
    '',
    '---',
    '',
    '## Key requirements',
    '',
    ...input.job.requirements.map((r) => `- ${r}`),
    '',
    '## Skills named in the posting',
    '',
    input.job.skills.join(', ') || 'Not specified',
    '',
    `_Captured by JobPilot AI on ${input.appliedAt.toDateString()}._`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderTailoringReport(input: FolderInput): string {
  return [
    `# Tailoring report`,
    `## ${input.job.title} at ${input.job.company}`,
    '',
    `**Match score:** ${input.matchScore}%  `,
    `**Estimated ATS score after tailoring:** ${input.notes.atsScore}%`,
    '',
    '## What was changed',
    '',
    ...input.notes.changes.map((c) => `- ${c}`),
    '',
    input.notes.keywordsInjected.length
      ? [
          '## Keywords surfaced',
          '',
          'These appeared in the posting and are supported by your existing experience,',
          'so they were surfaced more prominently:',
          '',
          ...input.notes.keywordsInjected.map((k) => `- ${k}`),
          '',
        ].join('\n')
      : '',
    '## Integrity note',
    '',
    'Tailoring only rephrases, reorders and reframes experience already present in your',
    'master resume. No employer, title, date, credential or accomplishment is ever',
    'invented. Review the submitted resume in `resume.txt` at any time.',
    '',
    `_Generated by JobPilot AI on ${input.appliedAt.toDateString()}._`,
  ]
    .filter(Boolean)
    .join('\n');
}

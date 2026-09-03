/**
 * The document library's row shape.
 *
 * A "document" here is anything JobPilot generated on the applicant's behalf.
 * They come from four different tables and one filesystem folder, so the page
 * flattens them into one list rather than making the reader visit four screens
 * to find the cover letter they sent last Tuesday.
 *
 * Dates are pre-formatted on the server for the same reason as everywhere else
 * in this dashboard: a client component renders twice, and `toLocaleDateString`
 * must not be one of the things that can differ between the two passes.
 */

export type DocumentKind =
  | 'master_resume'
  | 'resume'
  | 'cover_letter'
  | 'job_description'
  | 'folder'
  | 'interview_prep'
  | 'message'
  | 'upload'
  | 'invoice';

export interface DocumentRowView {
  /** Unique across kinds — several rows can share an application id. */
  id: string;
  kind: DocumentKind;
  title: string;
  /** Company, role, or invoice period — whatever identifies it at a glance. */
  context: string;
  /** ISO-8601, for sorting only. */
  dateIso: string;
  dateLabel: string;
  /** TXT · MD · PDF · In app */
  formatLabel: string;
  /** Direct file download, when the artifact is a file. */
  downloadUrl: string | null;
  /** Where to read it inside JobPilot, when it is a page rather than a file. */
  viewUrl: string | null;
}

export interface KindOption {
  value: DocumentKind;
  label: string;
  count: number;
}

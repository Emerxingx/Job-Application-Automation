/**
 * Colour tokens with WCAG 2.2 AA contrast on their intended backgrounds
 * (text ≥ 4.5:1, large text and UI ≥ 3:1), light and dark. Checked with a
 * contrast calculator when chosen; recorded in tests/theme.test.ts, which
 * computes the ratios rather than trusting this comment.
 */

export interface Theme {
  bg: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  success: string;
  warning: string;
  danger: string;
  pillBg: string;
}

export const LIGHT: Theme = {
  bg: '#f8fafc',
  card: '#ffffff',
  text: '#111827',
  muted: '#4b5563',
  border: '#6b7280',
  primary: '#1d4ed8',
  onPrimary: '#ffffff',
  success: '#166534',
  warning: '#9a3412',
  danger: '#b91c1c',
  pillBg: '#eef2ff',
};

export const DARK: Theme = {
  bg: '#0b1220',
  card: '#111827',
  text: '#f3f4f6',
  muted: '#cbd5e1',
  border: '#6b7280',
  primary: '#93c5fd',
  onPrimary: '#0b1220',
  success: '#86efac',
  warning: '#fcd34d',
  danger: '#fca5a5',
  pillBg: '#1f2937',
};

/** Minimum touch target (WCAG 2.5.8 AA is 24px; 44 matches both platforms' guidance). */
export const TOUCH = 44;
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const FONT = { sm: 13, md: 16, lg: 18, xl: 22, xxl: 28 } as const;

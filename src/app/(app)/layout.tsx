import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ImpersonationBanner } from '@/components/impersonation-banner';

export const metadata: Metadata = {
  title: {
    default: 'JobPilot AI — Automated job applications for Canada & the US',
    template: '%s · JobPilot AI',
  },
  description:
    'Your AI career co-pilot. Scan live job postings, score your real fit, customize your resume for every role, and apply at scale — with a complete record of every application.',
  keywords: [
    'job application automation',
    'AI resume builder',
    'Canada jobs',
    'ATS optimization',
    'interview preparation',
  ],
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0c0e' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ImpersonationBanner />
        {children}
      </body>
    </html>
  );
}

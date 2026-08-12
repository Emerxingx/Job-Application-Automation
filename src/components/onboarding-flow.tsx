'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, FileText, Radar } from 'lucide-react';
import { Card, cn } from '@/components/ui';
import { ResumeEditor } from '@/components/resume-editor';
import { AgentForm } from '@/components/agent-form';
import type { ResumeContent } from '@/lib/types';

const STEPS = [
  { id: 1, label: 'Your resume', icon: FileText },
  { id: 2, label: 'Your first agent', icon: Radar },
];

export function OnboardingFlow({
  initialResume,
  defaultLocation,
}: {
  initialResume: ResumeContent;
  defaultLocation: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);

  return (
    <div>
      {/* Progress */}
      <ol className="mb-8 flex items-center gap-3">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex flex-1 items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border-2 transition',
                step > s.id
                  ? 'border-success bg-success text-white'
                  : step === s.id
                    ? 'border-brand-500 bg-brand-500 text-white'
                    : 'border-line bg-surface text-faint',
              )}
            >
              {step > s.id ? <CheckCircle2 className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}
            </div>
            <span
              className={cn(
                'text-sm font-medium',
                step >= s.id ? 'text-ink' : 'text-faint',
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line" />}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <>
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-ink">
              Let&apos;s start with your resume
            </h1>
            <p className="mt-1.5 text-muted">
              This is the source of truth every tailored application is built from. The more
              complete it is, the better your match scores and rewrites will be.
            </p>
          </div>

          <Card className="mb-6 border-brand-500/40 bg-brand-500/5 p-4">
            <p className="text-sm text-muted">
              <strong className="text-ink">Tip:</strong> Achievements with numbers convert best —
              &ldquo;cut month-end close from 9 days to 2&rdquo; beats &ldquo;responsible for
              reporting&rdquo;.
            </p>
          </Card>

          <ResumeEditor
            initial={initialResume}
            submitLabel="Save and continue"
            onSaved={() => setStep(2)}
          />
        </>
      )}

      {step === 2 && (
        <>
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-ink">
              Now create your first job agent
            </h1>
            <p className="mt-1.5 text-muted">
              Tell it which titles you want and where. It will scan live postings and score each one
              against the resume you just saved.
            </p>
          </div>

          <AgentForm defaultLocation={defaultLocation} />

          <button
            onClick={() => {
              router.push('/dashboard');
              router.refresh();
            }}
            className="btn-ghost mt-4"
          >
            Skip for now
            <ArrowRight className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}

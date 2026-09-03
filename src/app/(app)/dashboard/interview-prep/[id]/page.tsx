import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Building2, Lightbulb, MessageCircleQuestion, Star } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { parseJson } from '@/lib/types';
import type { InterviewQuestion, StarStory } from '@/lib/types';
import { Card } from '@/components/ui';
import { InterviewPrepButton } from '@/components/interview-prep-button';

export const metadata = { title: 'Interview prep' };
export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<string, string> = {
  behavioural: 'Behavioural',
  technical: 'Technical',
  situational: 'Situational',
  culture: 'Culture fit',
  closing: 'Opening & closing',
};

export default async function PrepDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, run } = await requireTenant();
  const { id } = await params;

  const application = await run((tx) =>
    tx.application.findFirst({
      where: { id, userId: user.id },
      include: { job: true, interviewPrep: true },
    }),
  );
  if (!application) notFound();

  const prep = application.interviewPrep;
  if (!prep) {
    return (
      <>
        <Link
          href="/dashboard/interview-prep"
          className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" />
          Interview prep
        </Link>
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">No prep pack yet</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Build a preparation pack for {application.job.title} at {application.job.company}.
          </p>
          <div className="mx-auto mt-5 max-w-xs">
            <InterviewPrepButton applicationId={application.id} />
          </div>
        </Card>
      </>
    );
  }

  const questions = parseJson<InterviewQuestion[]>(prep.questions, []);
  const stories = parseJson<StarStory[]>(prep.stories, []);
  const questionsToAsk = parseJson<string[]>(prep.questionsToAsk, []);

  return (
    <>
      <Link
        href={`/dashboard/applications/${application.id}`}
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to application
      </Link>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
          Interview preparation
        </h1>
        <p className="mt-1.5 text-muted">
          {application.job.title} at {application.job.company}
        </p>
      </header>

      <div className="space-y-8">
        {/* Questions */}
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-ink">
            <MessageCircleQuestion className="h-5 w-5 text-brand-500" />
            Likely questions
          </h2>

          <div className="space-y-3">
            {questions.map((q, i) => (
              <Card key={i} className="overflow-hidden">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-start gap-3 p-4 hover:bg-raised">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-xs font-bold text-brand-600">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">{q.question}</p>
                      <span className="chip mt-1.5">
                        {CATEGORY_LABELS[q.category] ?? q.category}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-faint group-open:hidden">Show answer</span>
                  </summary>

                  <div className="border-t border-line px-4 pb-4 pt-4">
                    <p className="mb-3 text-sm leading-relaxed text-muted">{q.suggestedAnswer}</p>
                    {q.tips.length > 0 && (
                      <ul className="space-y-1.5">
                        {q.tips.map((tip, j) => (
                          <li key={j} className="flex items-start gap-2 text-sm text-muted">
                            <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                            <span>{tip}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </details>
              </Card>
            ))}
          </div>
        </section>

        {/* STAR stories */}
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-ink">
            <Star className="h-5 w-5 text-brand-500" />
            Your STAR stories
          </h2>
          <p className="mb-4 text-sm text-muted">
            Drafted from your real roles. Fill in the specifics — the numbers are what make these land.
          </p>

          <div className="space-y-4">
            {stories.map((story, i) => (
              <Card key={i} className="p-5">
                <h3 className="font-semibold text-ink">{story.title}</h3>

                <dl className="mt-3 space-y-3">
                  {[
                    { label: 'Situation', value: story.situation },
                    { label: 'Task', value: story.task },
                    { label: 'Action', value: story.action },
                    { label: 'Result', value: story.result },
                  ].map((part) => (
                    <div key={part.label}>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-brand-500">
                        {part.label}
                      </dt>
                      <dd className="mt-0.5 text-sm leading-relaxed text-muted">{part.value}</dd>
                    </div>
                  ))}
                </dl>

                {story.mapsTo.length > 0 && (
                  <div className="mt-4 border-t border-line pt-3">
                    <p className="mb-1.5 text-xs text-faint">Use this story for:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {story.mapsTo.map((m) => (
                        <span key={m} className="chip">
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>

        {/* Company research */}
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-ink">
            <Building2 className="h-5 w-5 text-brand-500" />
            Company research
          </h2>
          <Card className="p-5">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">
              {prep.companyResearch}
            </pre>
          </Card>
        </section>

        {/* Questions to ask */}
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-ink">
            <MessageCircleQuestion className="h-5 w-5 text-brand-500" />
            Questions to ask them
          </h2>
          <Card className="p-5">
            <ul className="space-y-2.5">
              {questionsToAsk.map((q, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm text-muted">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <div className="max-w-xs">
          <InterviewPrepButton applicationId={application.id} label="Regenerate this pack" />
        </div>
      </div>
    </>
  );
}

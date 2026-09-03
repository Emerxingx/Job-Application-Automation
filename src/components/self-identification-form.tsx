'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

/**
 * Voluntary self-identification (ADR-0007). Loaded on demand, never with the
 * rest of settings, because every read of this data is audited. Every
 * question offers "Prefer not to say", which is saved as an answer.
 */
type Options = Record<'gender' | 'ethnicity' | 'indigenousStatus' | 'veteranStatus' | 'disabilityStatus', readonly string[]>;
type Answers = Record<keyof Options, string>;

const QUESTIONS: { key: keyof Options; label: string }[] = [
  { key: 'gender', label: 'Gender' },
  { key: 'ethnicity', label: 'Racialized identity' },
  { key: 'indigenousStatus', label: 'Indigenous identity' },
  { key: 'veteranStatus', label: 'Veteran status' },
  { key: 'disabilityStatus', label: 'Disability' },
];

const humanize = (v: string) => v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function SelfIdentificationForm() {
  const [options, setOptions] = useState<Options | null>(null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/profile/self-identification')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setOptions(data.options);
        const blank = Object.fromEntries(QUESTIONS.map((q) => [q.key, 'prefer_not_to_say'])) as Answers;
        setAnswers(data.current ? { ...blank, ...data.current } : blank);
        setRecorded(Boolean(data.current));
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your answers.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!answers) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/profile/self-identification', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answers),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Could not save.');
      else {
        setSaved(true);
        setRecorded(true);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  async function erase() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/profile/self-identification', { method: 'DELETE' });
      if (!res.ok) setError('Could not delete.');
      else {
        setAnswers(Object.fromEntries(QUESTIONS.map((q) => [q.key, 'prefer_not_to_say'])) as Answers);
        setRecorded(false);
        setSaved(false);
      }
    } finally {
      setSaving(false);
    }
  }

  if (!options || !answers) {
    return (
      <p className="text-sm text-muted" role="status" aria-live="polite">
        {error ?? 'Loading…'}
      </p>
    );
  }

  return (
    <form onSubmit={save} aria-labelledby="selfid-heading">
      <Card className="max-w-2xl p-6">
      <h2 id="selfid-heading" className="font-semibold text-ink">
        Self-identification (voluntary)
      </h2>
      <p className="mt-1 text-sm text-muted" id="selfid-notice">
        Answering is optional and every question has &ldquo;Prefer not to say&rdquo;. These answers are
        stored separately from your profile, are never used to match, rank or recommend jobs, are
        never sent to an AI service, and are never shown to an employer. Only you can see them, and
        each time they are viewed or changed it is recorded. You can delete them at any time.
      </p>
      <div className="mt-4 grid gap-4">
        {QUESTIONS.map((q) => (
          <div key={q.key}>
            <label className="label" htmlFor={`selfid-${q.key}`}>
              {q.label}
            </label>
            <select
              id={`selfid-${q.key}`}
              className="input"
              value={answers[q.key]}
              aria-describedby="selfid-notice"
              onChange={(e) => {
                setAnswers({ ...answers, [q.key]: e.target.value });
                setSaved(false);
              }}
            >
              {options[q.key].map((o) => (
                <option key={o} value={o}>
                  {o === 'prefer_not_to_say' ? 'Prefer not to say' : humanize(o)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3" role="status" aria-live="polite">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Save answers
        </button>
        {recorded && (
          <button type="button" disabled={saving} className="btn-secondary" onClick={erase}>
            Delete my answers
          </button>
        )}
        {saved && (
          <span className="flex items-center gap-1 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Saved
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1 text-sm text-danger" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" /> {error}
          </span>
        )}
      </div>
      </Card>
    </form>
  );
}

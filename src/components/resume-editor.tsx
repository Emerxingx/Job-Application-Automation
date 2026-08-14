'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, Plus, Trash2, X } from 'lucide-react';
import { Card } from '@/components/ui';
import type { ResumeContent, ResumeEducation, ResumeExperience } from '@/lib/types';

const EMPTY_ROLE: ResumeExperience = {
  company: '',
  title: '',
  location: '',
  startDate: '',
  endDate: '',
  bullets: [''],
};

const EMPTY_EDUCATION: ResumeEducation = {
  institution: '',
  credential: '',
  year: '',
  location: '',
};

export function ResumeEditor({
  initial,
  onSaved,
  submitLabel = 'Save resume',
}: {
  initial: ResumeContent;
  onSaved?: () => void;
  submitLabel?: string;
}) {
  const router = useRouter();
  const [resume, setResume] = useState<ResumeContent>(initial);
  const [skillDraft, setSkillDraft] = useState('');
  const [certDraft, setCertDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ResumeContent>(key: K, value: ResumeContent[K]) {
    setResume((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function updateRole(index: number, patch: Partial<ResumeExperience>) {
    set(
      'experience',
      resume.experience.map((role, i) => (i === index ? { ...role, ...patch } : role)),
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const res = await fetch('/api/resume', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resume),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Could not save your resume.');
        setSaving(false);
        return;
      }

      setSaved(true);
      setSaving(false);
      router.refresh();
      onSaved?.();
    } catch {
      setError('Could not reach the server. Please try again.');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-3xl space-y-5">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Contact */}
      <Card className="space-y-4 p-6">
        <h2 className="font-semibold text-ink">Contact details</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="fullName">
              Full name
            </label>
            <input
              id="fullName"
              value={resume.fullName}
              onChange={(e) => set('fullName', e.target.value)}
              required
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="headline">
              Professional headline
            </label>
            <input
              id="headline"
              value={resume.headline}
              onChange={(e) => set('headline', e.target.value)}
              placeholder="Senior Data Analyst"
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={resume.email}
              onChange={(e) => set('email', e.target.value)}
              required
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="phone">
              Phone
            </label>
            <input
              id="phone"
              value={resume.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="location">
              Location
            </label>
            <input
              id="location"
              value={resume.location ?? ''}
              onChange={(e) => set('location', e.target.value)}
              placeholder="Toronto, ON"
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="linkedin">
              LinkedIn
            </label>
            <input
              id="linkedin"
              value={resume.linkedinUrl ?? ''}
              onChange={(e) => set('linkedinUrl', e.target.value)}
              className="input"
            />
          </div>
        </div>
      </Card>

      {/* Summary */}
      <Card className="p-6">
        <label className="label" htmlFor="summary">
          Professional summary
        </label>
        <p className="-mt-1 mb-2 text-xs text-faint">
          Two or three sentences on what you do and the impact you have had. This gets rewritten
          for each application.
        </p>
        <textarea
          id="summary"
          rows={4}
          value={resume.summary}
          onChange={(e) => set('summary', e.target.value)}
          className="input resize-y"
        />
      </Card>

      {/* Skills */}
      <Card className="p-6">
        <label className="label" htmlFor="skills">
          Skills
        </label>
        <p className="-mt-1 mb-2 text-xs text-faint">
          Tools, technologies and competencies. These are reordered per posting.
        </p>

        {resume.skills.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {resume.skills.map((skill) => (
              <span key={skill} className="chip bg-brand-500/10 text-brand-600">
                {skill}
                <button
                  type="button"
                  onClick={() => set('skills', resume.skills.filter((s) => s !== skill))}
                  aria-label={`Remove ${skill}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            id="skills"
            value={skillDraft}
            onChange={(e) => setSkillDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const parts = skillDraft.split(',').map((s) => s.trim()).filter(Boolean);
                if (parts.length) set('skills', [...new Set([...resume.skills, ...parts])]);
                setSkillDraft('');
              }
            }}
            placeholder="SQL, Python, Tableau"
            className="input"
          />
          <button
            type="button"
            onClick={() => {
              const parts = skillDraft.split(',').map((s) => s.trim()).filter(Boolean);
              if (parts.length) set('skills', [...new Set([...resume.skills, ...parts])]);
              setSkillDraft('');
            }}
            className="btn-secondary shrink-0 px-3"
          >
            Add
          </button>
        </div>
      </Card>

      {/* Experience */}
      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-ink">Work experience</h2>
          <button
            type="button"
            onClick={() => set('experience', [...resume.experience, { ...EMPTY_ROLE }])}
            className="btn-secondary px-3 py-1.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Add role
          </button>
        </div>

        {resume.experience.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">
            Add your roles — this is what tailoring works from.
          </p>
        )}

        <div className="space-y-5">
          {resume.experience.map((role, index) => (
            <div key={index} className="rounded-xl border border-line p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-faint">
                  Role {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    set('experience', resume.experience.filter((_, i) => i !== index))
                  }
                  aria-label={`Remove role ${index + 1}`}
                  className="rounded-lg p-1 text-faint hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  value={role.title}
                  onChange={(e) => updateRole(index, { title: e.target.value })}
                  placeholder="Job title"
                  className="input"
                  aria-label="Job title"
                />
                <input
                  value={role.company}
                  onChange={(e) => updateRole(index, { company: e.target.value })}
                  placeholder="Company"
                  className="input"
                  aria-label="Company"
                />
                <input
                  value={role.startDate}
                  onChange={(e) => updateRole(index, { startDate: e.target.value })}
                  placeholder="Start (e.g. 2022-03)"
                  className="input"
                  aria-label="Start date"
                />
                <input
                  value={role.endDate}
                  onChange={(e) => updateRole(index, { endDate: e.target.value })}
                  placeholder="End (or Present)"
                  className="input"
                  aria-label="End date"
                />
              </div>

              <div className="mt-3">
                <label className="label text-xs">Achievements</label>
                <p className="-mt-1 mb-2 text-xs text-faint">
                  One per line. Lead with impact and include numbers where you can.
                </p>
                <textarea
                  rows={4}
                  value={role.bullets.join('\n')}
                  onChange={(e) =>
                    updateRole(index, { bullets: e.target.value.split('\n') })
                  }
                  placeholder="Rebuilt the reporting model, cutting month-end close from 9 days to 2."
                  className="input resize-y font-mono text-xs"
                />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Education */}
      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-ink">Education</h2>
          <button
            type="button"
            onClick={() => set('education', [...resume.education, { ...EMPTY_EDUCATION }])}
            className="btn-secondary px-3 py-1.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>

        <div className="space-y-3">
          {resume.education.map((edu, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_100px_auto]">
              <input
                value={edu.credential}
                onChange={(e) =>
                  set(
                    'education',
                    resume.education.map((x, i) =>
                      i === index ? { ...x, credential: e.target.value } : x,
                    ),
                  )
                }
                placeholder="Credential"
                className="input"
                aria-label="Credential"
              />
              <input
                value={edu.institution}
                onChange={(e) =>
                  set(
                    'education',
                    resume.education.map((x, i) =>
                      i === index ? { ...x, institution: e.target.value } : x,
                    ),
                  )
                }
                placeholder="Institution"
                className="input"
                aria-label="Institution"
              />
              <input
                value={edu.year}
                onChange={(e) =>
                  set(
                    'education',
                    resume.education.map((x, i) =>
                      i === index ? { ...x, year: e.target.value } : x,
                    ),
                  )
                }
                placeholder="Year"
                className="input"
                aria-label="Year"
              />
              <button
                type="button"
                onClick={() => set('education', resume.education.filter((_, i) => i !== index))}
                aria-label={`Remove education ${index + 1}`}
                className="rounded-lg p-2 text-faint hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </Card>

      {/* Certifications */}
      <Card className="p-6">
        <label className="label" htmlFor="certs">
          Certifications
        </label>

        {resume.certifications.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {resume.certifications.map((c) => (
              <span key={c} className="chip">
                {c}
                <button
                  type="button"
                  onClick={() =>
                    set('certifications', resume.certifications.filter((x) => x !== c))
                  }
                  aria-label={`Remove ${c}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            id="certs"
            value={certDraft}
            onChange={(e) => setCertDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (certDraft.trim())
                  set('certifications', [...resume.certifications, certDraft.trim()]);
                setCertDraft('');
              }
            }}
            placeholder="PMP, AWS Solutions Architect…"
            className="input"
          />
          <button
            type="button"
            onClick={() => {
              if (certDraft.trim())
                set('certifications', [...resume.certifications, certDraft.trim()]);
              setCertDraft('');
            }}
            className="btn-secondary shrink-0 px-3"
          >
            Add
          </button>
        </div>
      </Card>

      <div className="flex items-center gap-3 pb-4">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </button>
        {saved && (
          <span role="status" className="flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" />
            Saved
          </span>
        )}
      </div>
    </form>
  );
}

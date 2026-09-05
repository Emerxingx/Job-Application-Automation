'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

interface CredentialOption {
  id: string;
  name: string;
  requirement: string;
  recognition: string;
}

interface WhatIfResult {
  credential: string;
  outcomeBefore: string;
  outcomeAfter: string;
  materiallyChanged: boolean;
  changes: { rule: string; from: string; to: string; reasonAfter: string }[];
  recognition: string;
  provenance: { datasetKey: string; attribution: string } | null;
}

const OUTCOME: Record<string, string> = { eligible: 'eligible', ineligible: 'not eligible', unknown: 'unconfirmed' };

/**
 * Stage 16 (ADR-0031): on a posting, "would holding this credential change
 * my eligibility?" - answered by the eligibility engine before and after,
 * never by a promise. Shown only for credentials the posting's occupation
 * lists under a recorded licence.
 */
export function CredentialWhatIf({ jobId, credentials }: { jobId: string; credentials: CredentialOption[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, WhatIfResult>>({});
  const [error, setError] = useState<string | null>(null);

  async function ask(credentialId: string) {
    setBusy(credentialId);
    setError(null);
    try {
      const res = await fetch('/api/career/whatif', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId, jobId }) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not run the comparison.');
        return;
      }
      setResults((prev) => ({ ...prev, [credentialId]: data.whatIf as WhatIfResult }));
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5" aria-labelledby="whatif-heading">
      <h2 id="whatif-heading" className="text-base font-semibold text-ink">
        Would a credential change your eligibility?
      </h2>
      <p className="mt-1 text-xs text-muted">The eligibility rules run again with the credential added to your profile. The difference, rule by rule, is the answer; recognition is what the dataset states.</p>
      <ul className="mt-3 space-y-2">
        {credentials.map((c) => {
          const r = results[c.id];
          return (
            <li key={c.id} className="rounded-md border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink">
                  {c.name} <span className="text-xs text-muted">({c.requirement}, recognition: {c.recognition})</span>
                </span>
                <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => ask(c.id)}>
                  {busy === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  What if I held it?
                </button>
              </div>
              {r ? (
                <div className="mt-2 text-xs">
                  <p className={r.materiallyChanged ? 'text-success' : 'text-muted'}>
                    {r.materiallyChanged ? `Verdict would move from ${OUTCOME[r.outcomeBefore] ?? r.outcomeBefore} to ${OUTCOME[r.outcomeAfter] ?? r.outcomeAfter}.` : `Verdict stays ${OUTCOME[r.outcomeAfter] ?? r.outcomeAfter}: this credential does not change the hard requirements this posting states.`}
                  </p>
                  {r.changes.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-muted">
                      {r.changes.map((ch) => (
                        <li key={ch.rule}>
                          {ch.rule.replace(/_/g, ' ')}: {ch.from} → {ch.to}. {ch.reasonAfter}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {r.provenance ? <p className="mt-1 text-faint">Source: {r.provenance.attribution}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

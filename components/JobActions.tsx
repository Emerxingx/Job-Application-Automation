"use client";

import { useState } from "react";
import type { Job } from "@/lib/types";

type GenerationKind = "coverLetter" | "resumeBullets";

export default function JobActions({ job }: { job: Job }) {
  const [tracking, setTracking] = useState(false);
  const [trackedMessage, setTrackedMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState<GenerationKind | null>(null);
  const [result, setResult] = useState<{ kind: GenerationKind; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTrack() {
    setTracking(true);
    setTrackedMessage(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save job");
      setTrackedMessage("Saved to your applications tracker.");
    } catch (err) {
      setTrackedMessage(err instanceof Error ? err.message : "Failed to save job");
    } finally {
      setTracking(false);
    }
  }

  async function handleGenerate(kind: GenerationKind) {
    setLoading(kind);
    setError(null);
    setResult(null);
    try {
      const endpoint =
        kind === "coverLetter" ? "/api/generate/cover-letter" : "/api/generate/resume-bullets";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setResult({ kind, text: data.coverLetter ?? data.resumeBullets ?? "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleTrack}
          disabled={tracking}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {tracking ? "Saving…" : "Save to tracker"}
        </button>
        <button
          onClick={() => handleGenerate("coverLetter")}
          disabled={loading !== null}
          className="rounded-md border border-red-700 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          {loading === "coverLetter" ? "Writing…" : "✨ Generate cover letter"}
        </button>
        <button
          onClick={() => handleGenerate("resumeBullets")}
          disabled={loading !== null}
          className="rounded-md border border-red-700 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          {loading === "resumeBullets" ? "Writing…" : "✨ Tailor resume bullets"}
        </button>
      </div>

      {trackedMessage && <p className="text-sm text-slate-600">{trackedMessage}</p>}
      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {result && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              {result.kind === "coverLetter" ? "Draft cover letter" : "Tailored resume bullets"}
            </h3>
            <button
              onClick={() => navigator.clipboard.writeText(result.text)}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Copy
            </button>
          </div>
          <textarea
            readOnly
            value={result.text}
            rows={12}
            className="w-full rounded-md border border-slate-300 p-3 text-sm text-slate-800"
          />
        </div>
      )}
    </div>
  );
}

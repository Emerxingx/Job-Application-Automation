"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import type { Application, ApplicationStatus, Job } from "@/lib/types";

type EnrichedApplication = Application & { job: Job | null };

const STATUSES: ApplicationStatus[] = ["saved", "applied", "interviewing", "offer", "rejected"];

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<EnrichedApplication[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/applications")
      .then((res) => res.json())
      .then((data) => setApplications(data.applications ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function updateStatus(id: string, status: ApplicationStatus) {
    setApplications((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
    await fetch(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async function remove(id: string) {
    setApplications((prev) => prev.filter((a) => a.id !== id));
    await fetch(`/api/applications/${id}`, { method: "DELETE" });
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading your applications…</p>;
  }

  if (applications.length === 0) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Applications</h1>
        <p className="text-slate-600">
          You haven&apos;t saved any jobs yet.{" "}
          <Link href="/jobs" className="font-medium text-red-700 hover:underline">
            Browse jobs
          </Link>{" "}
          to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Applications</h1>
      <div className="grid gap-3">
        {applications.map((app) => (
          <div key={app.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Link href={`/jobs/${app.jobId}`} className="font-semibold text-slate-900 hover:underline">
                  {app.job?.title ?? "Job no longer available"}
                </Link>
                <p className="text-sm text-slate-600">
                  {app.job ? `${app.job.company} · ${app.job.location}` : ""}
                </p>
              </div>
              <StatusBadge status={app.status} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={app.status}
                onChange={(e) => updateStatus(app.id, e.target.value as ApplicationStatus)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => remove(app.id)}
                className="text-sm font-medium text-slate-400 hover:text-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

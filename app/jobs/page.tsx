"use client";

import { useEffect, useState } from "react";
import JobCard from "@/components/JobCard";
import type { Job } from "@/lib/types";

export default function JobsPage() {
  const [q, setQ] = useState("");
  const [location, setLocation] = useState("");
  const [type, setType] = useState("all");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (location) params.set("location", location);
    if (type !== "all") params.set("type", type);

    const timeout = setTimeout(() => {
      setLoading(true);
      fetch(`/api/jobs?${params.toString()}`)
        .then((res) => res.json())
        .then((data) => setJobs(data.jobs ?? []))
        .finally(() => setLoading(false));
    }, 200); // small debounce so we don't hammer the API on every keystroke

    return () => clearTimeout(timeout);
  }, [q, location, type]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Find jobs</h1>
        <p className="mt-1 text-slate-600">
          Search curated postings across Canada. (Demo data today — plug in a real source via{" "}
          <code className="rounded bg-slate-100 px-1">lib/jobs.ts</code>.)
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <input
          className="input"
          placeholder="Title or keyword"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="input"
          placeholder="City or 'remote'"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All job types</option>
          <option value="full-time">Full-time</option>
          <option value="part-time">Part-time</option>
          <option value="contract">Contract</option>
          <option value="internship">Internship</option>
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading jobs…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-slate-500">No jobs match your search.</p>
      ) : (
        <div className="grid gap-3">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

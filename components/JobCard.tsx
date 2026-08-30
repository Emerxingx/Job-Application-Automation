import Link from "next/link";
import type { Job } from "@/lib/types";

export default function JobCard({ job }: { job: Job }) {
  return (
    <Link
      href={`/jobs/${job.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-slate-900">{job.title}</h3>
          <p className="text-sm text-slate-600">
            {job.company} · {job.location}
          </p>
        </div>
        {job.salaryRange && (
          <span className="whitespace-nowrap text-sm font-medium text-emerald-700">
            {job.salaryRange}
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          {job.type}
        </span>
        {job.remote && (
          <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
            Remote-friendly
          </span>
        )}
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          via {job.source}
        </span>
      </div>
    </Link>
  );
}

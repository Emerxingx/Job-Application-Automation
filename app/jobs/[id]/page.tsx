import { notFound } from "next/navigation";
import { getJobById } from "@/lib/jobs";
import JobActions from "@/components/JobActions";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{job.title}</h1>
        <p className="mt-1 text-slate-600">
          {job.company} · {job.location}
          {job.remote ? " · Remote-friendly" : ""}
        </p>
        {job.salaryRange && <p className="mt-1 font-medium text-emerald-700">{job.salaryRange}</p>}
      </div>

      <JobActions job={job} />

      <section>
        <h2 className="text-lg font-semibold">Description</h2>
        <p className="mt-2 whitespace-pre-line text-slate-700">{job.description}</p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Requirements</h2>
        <ul className="mt-2 list-inside list-disc space-y-1 text-slate-700">
          {job.requirements.map((req) => (
            <li key={req}>{req}</li>
          ))}
        </ul>
      </section>

      <button
        disabled
        title="Live apply links arrive once a real job-board integration (Indeed, Job Bank Canada) is connected"
        className="cursor-not-allowed rounded-md bg-slate-200 px-4 py-2 text-sm font-medium text-slate-500"
      >
        Apply via {job.source} (demo data)
      </button>
    </div>
  );
}

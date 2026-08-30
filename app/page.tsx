import Link from "next/link";
import { MOCK_JOBS } from "@/lib/jobs";
import { readApplications, readProfile } from "@/lib/store";
import JobCard from "@/components/JobCard";

export default function DashboardPage() {
  const profile = readProfile();
  const applications = readApplications();
  const featuredJobs = MOCK_JOBS.slice(0, 3);

  const counts = {
    saved: applications.filter((a) => a.status === "saved").length,
    applied: applications.filter((a) => a.status === "applied").length,
    interviewing: applications.filter((a) => a.status === "interviewing").length,
    offer: applications.filter((a) => a.status === "offer").length,
  };

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold">
          Welcome{profile.fullName ? `, ${profile.fullName}` : ""} 👋
        </h1>
        <p className="mt-1 text-slate-600">
          Your AI-powered career co-pilot for Canada&apos;s job market.
        </p>
        {!profile.resumeText && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Add your resume and skills on your{" "}
            <Link href="/profile" className="font-medium underline">
              profile
            </Link>{" "}
            to get AI-tailored cover letters and resume suggestions.
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Saved" value={counts.saved} />
        <StatTile label="Applied" value={counts.applied} />
        <StatTile label="Interviewing" value={counts.interviewing} />
        <StatTile label="Offers" value={counts.offer} />
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Featured jobs</h2>
          <Link href="/jobs" className="text-sm font-medium text-red-700 hover:underline">
            Browse all jobs →
          </Link>
        </div>
        <div className="mt-3 grid gap-3">
          {featuredJobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="text-sm text-slate-600">{label}</div>
    </div>
  );
}

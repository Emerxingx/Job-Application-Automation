import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getJobById } from "@/lib/jobs";
import { readApplications, writeApplications } from "@/lib/store";
import type { Application } from "@/lib/types";

export async function GET() {
  const applications = readApplications();
  const enriched = applications
    .map((application) => ({
      ...application,
      job: getJobById(application.jobId) ?? null,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return NextResponse.json({ applications: enriched });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const jobId = body?.jobId;
  if (!jobId || typeof jobId !== "string") {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  if (!getJobById(jobId)) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const applications = readApplications();
  if (applications.some((application) => application.jobId === jobId)) {
    return NextResponse.json({ error: "This job is already in your tracker" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const application: Application = {
    id: randomUUID(),
    jobId,
    status: "saved",
    createdAt: now,
    updatedAt: now,
  };

  writeApplications([...applications, application]);
  return NextResponse.json({ application }, { status: 201 });
}

import { NextRequest, NextResponse } from "next/server";
import { getJobById } from "@/lib/jobs";
import { readProfile } from "@/lib/store";
import { generateCoverLetter } from "@/lib/claude";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const jobId = body?.jobId;
  if (!jobId || typeof jobId !== "string") {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const job = getJobById(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const profile = readProfile();

  try {
    const coverLetter = await generateCoverLetter(profile, job);
    return NextResponse.json({ coverLetter });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate cover letter";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

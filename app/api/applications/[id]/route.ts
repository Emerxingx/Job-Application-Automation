import { NextRequest, NextResponse } from "next/server";
import { readApplications, writeApplications } from "@/lib/store";
import type { ApplicationStatus } from "@/lib/types";

const VALID_STATUSES: ApplicationStatus[] = ["saved", "applied", "interviewing", "offer", "rejected"];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const applications = readApplications();
  const index = applications.findIndex((application) => application.id === id);
  if (index === -1) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  const updated = { ...applications[index] };

  if (body?.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updated.status = body.status;
  }
  if (body?.notes !== undefined) {
    updated.notes = String(body.notes);
  }
  if (body?.coverLetter !== undefined) {
    updated.coverLetter = String(body.coverLetter);
  }
  updated.updatedAt = new Date().toISOString();

  applications[index] = updated;
  writeApplications(applications);
  return NextResponse.json({ application: updated });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const applications = readApplications();
  const next = applications.filter((application) => application.id !== id);
  if (next.length === applications.length) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }
  writeApplications(next);
  return NextResponse.json({ ok: true });
}

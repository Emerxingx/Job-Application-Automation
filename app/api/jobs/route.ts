import { NextRequest, NextResponse } from "next/server";
import { searchJobs } from "@/lib/jobs";
import type { JobType } from "@/lib/types";

const VALID_TYPES: JobType[] = ["full-time", "part-time", "contract", "internship"];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? undefined;
  const location = searchParams.get("location") ?? undefined;
  const typeParam = searchParams.get("type");

  const type =
    typeParam && VALID_TYPES.includes(typeParam as JobType) ? (typeParam as JobType) : undefined;

  const jobs = searchJobs({ q, location, type });
  return NextResponse.json({ jobs });
}

import { NextRequest, NextResponse } from "next/server";
import { readProfile, writeProfile } from "@/lib/store";
import type { Profile } from "@/lib/types";

export async function GET() {
  return NextResponse.json({ profile: readProfile() });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid profile payload" }, { status: 400 });
  }

  const profile: Profile = {
    fullName: String(body.fullName ?? ""),
    email: String(body.email ?? ""),
    location: String(body.location ?? ""),
    targetRoles: Array.isArray(body.targetRoles) ? body.targetRoles.map(String) : [],
    skills: Array.isArray(body.skills) ? body.skills.map(String) : [],
    yearsOfExperience:
      body.yearsOfExperience !== undefined && body.yearsOfExperience !== null && body.yearsOfExperience !== ""
        ? Number(body.yearsOfExperience)
        : undefined,
    resumeText: String(body.resumeText ?? ""),
    updatedAt: new Date().toISOString(),
  };

  writeProfile(profile);
  return NextResponse.json({ profile });
}

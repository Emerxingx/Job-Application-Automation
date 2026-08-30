import fs from "fs";
import path from "path";
import type { Application, Profile } from "./types";

/**
 * Minimal JSON-file persistence for local/demo use.
 *
 * This intentionally avoids a database dependency so the app runs with zero
 * setup. It is single-user and not safe for concurrent writers — swap these
 * functions for a real database (Postgres via Prisma, etc.) before deploying
 * for multiple users, keeping the same function signatures.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const PROFILE_FILE = path.join(DATA_DIR, "profile.json");
const APPLICATIONS_FILE = path.join(DATA_DIR, "applications.json");

const DEFAULT_PROFILE: Profile = {
  fullName: "",
  email: "",
  location: "",
  targetRoles: [],
  skills: [],
  resumeText: "",
  updatedAt: new Date(0).toISOString(),
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonFile<T>(file: string, fallback: T): T {
  ensureDataDir();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf-8");
    return fallback;
  }
  const raw = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile<T>(file: string, data: T): T {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  return data;
}

export function readProfile(): Profile {
  return readJsonFile(PROFILE_FILE, DEFAULT_PROFILE);
}

export function writeProfile(profile: Profile): Profile {
  return writeJsonFile(PROFILE_FILE, profile);
}

export function readApplications(): Application[] {
  return readJsonFile<Application[]>(APPLICATIONS_FILE, []);
}

export function writeApplications(applications: Application[]): Application[] {
  return writeJsonFile(APPLICATIONS_FILE, applications);
}

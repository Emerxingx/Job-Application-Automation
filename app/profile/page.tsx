"use client";

import { useEffect, useState } from "react";
import type { Profile } from "@/lib/types";

const EMPTY: Profile = {
  fullName: "",
  email: "",
  location: "",
  targetRoles: [],
  skills: [],
  resumeText: "",
  updatedAt: "",
};

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [targetRolesText, setTargetRolesText] = useState("");
  const [skillsText, setSkillsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/profile")
      .then((res) => res.json())
      .then((data) => {
        setProfile(data.profile);
        setTargetRolesText((data.profile.targetRoles ?? []).join(", "));
        setSkillsText((data.profile.skills ?? []).join(", "));
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    const payload = {
      ...profile,
      targetRoles: targetRolesText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      skills: skillsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setProfile(data.profile);
    setSaving(false);
    setSaved(true);
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading your profile…</p>;
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Your profile</h1>
        <p className="mt-1 text-slate-600">
          This information is used to tailor AI-generated cover letters and resume suggestions.
          It&apos;s stored locally in this app&apos;s data folder — nothing is sent anywhere except to
          Claude when you click a generate button.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <Field label="Full name">
          <input
            className="input"
            value={profile.fullName}
            onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            className="input"
            value={profile.email}
            onChange={(e) => setProfile({ ...profile, email: e.target.value })}
          />
        </Field>
        <Field label="Location">
          <input
            className="input"
            placeholder="e.g. Toronto, ON"
            value={profile.location}
            onChange={(e) => setProfile({ ...profile, location: e.target.value })}
          />
        </Field>
        <Field label="Years of experience">
          <input
            type="number"
            min={0}
            className="input"
            value={profile.yearsOfExperience ?? ""}
            onChange={(e) =>
              setProfile({
                ...profile,
                yearsOfExperience: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Target roles (comma-separated)">
          <input
            className="input"
            placeholder="e.g. Software Engineer, Product Manager"
            value={targetRolesText}
            onChange={(e) => setTargetRolesText(e.target.value)}
          />
        </Field>
        <Field label="Skills (comma-separated)">
          <input
            className="input"
            placeholder="e.g. TypeScript, React, SQL"
            value={skillsText}
            onChange={(e) => setSkillsText(e.target.value)}
          />
        </Field>
        <Field label="Base resume (plain text)">
          <textarea
            rows={12}
            className="input font-mono text-xs"
            value={profile.resumeText}
            onChange={(e) => setProfile({ ...profile, resumeText: e.target.value })}
          />
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save profile"}
          </button>
          {saved && <span className="text-sm text-emerald-700">Saved!</span>}
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

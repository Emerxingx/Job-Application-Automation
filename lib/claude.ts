import Anthropic from "@anthropic-ai/sdk";
import type { Job, Profile } from "./types";

// Per project convention, default to Claude Opus 5 for generation quality.
// Override with ANTHROPIC_MODEL if you want to trade quality for cost.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key to enable " +
        "AI-generated cover letters and resume suggestions.",
    );
  }
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

function profileSummary(profile: Profile): string {
  return [
    `Name: ${profile.fullName || "(not provided)"}`,
    `Location: ${profile.location || "(not provided)"}`,
    `Years of experience: ${profile.yearsOfExperience ?? "(not provided)"}`,
    `Target roles: ${profile.targetRoles.join(", ") || "(not provided)"}`,
    `Skills: ${profile.skills.join(", ") || "(not provided)"}`,
    "",
    "Base resume:",
    profile.resumeText || "(no resume text provided)",
  ].join("\n");
}

function jobSummary(job: Job): string {
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}${job.remote ? " (remote-friendly)" : ""}`,
    `Type: ${job.type}`,
    job.salaryRange ? `Salary: ${job.salaryRange}` : "",
    "",
    "Description:",
    job.description,
    "",
    "Requirements:",
    job.requirements.map((r) => `- ${r}`).join("\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Extracts and concatenates all text blocks from a Claude response. */
function extractText(content: Anthropic.ContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

export async function generateCoverLetter(profile: Profile, job: Job): Promise<string> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system:
      "You are a career coach helping a job seeker in Canada write a concise, specific, and honest cover " +
      "letter. Write in first person as the candidate. Ground every claim in the candidate's actual " +
      "background from their profile — never invent employers, credentials, metrics, or experience that " +
      "isn't there. Keep it to 3-4 short paragraphs, no headers or placeholder brackets, ready to send as-is.",
    messages: [
      {
        role: "user",
        content:
          `Candidate profile:\n${profileSummary(profile)}\n\n` +
          `Job posting:\n${jobSummary(job)}\n\n` +
          "Write a tailored cover letter for this candidate applying to this job.",
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to generate this cover letter.");
  }

  const text = extractText(response.content);
  if (!text) {
    throw new Error("Claude did not return any text content.");
  }
  return text;
}

export async function generateResumeBullets(profile: Profile, job: Job): Promise<string> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system:
      "You are a resume coach helping a job seeker in Canada tailor their resume to a specific job posting. " +
      "Only reorganize, rephrase, and prioritize achievements the candidate actually has — never fabricate " +
      "metrics, employers, or skills that aren't in their profile. Output 5-8 tailored resume bullet points " +
      "(plain text, one per line, each starting with a strong action verb) that emphasize the parts of their " +
      "background most relevant to this job.",
    messages: [
      {
        role: "user",
        content:
          `Candidate profile:\n${profileSummary(profile)}\n\n` +
          `Job posting:\n${jobSummary(job)}\n\n` +
          "Suggest tailored resume bullet points for this candidate applying to this job.",
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to generate these resume suggestions.");
  }

  const text = extractText(response.content);
  if (!text) {
    throw new Error("Claude did not return any text content.");
  }
  return text;
}

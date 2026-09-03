import { createHash } from 'node:crypto';
import type { ApplicationQuestion, Prisma } from '@prisma/client';
import { parseJson } from '../types';

/**
 * The application question bank (MASTER_BUILD_PLAN Stage 03).
 *
 * Employers ask the same screening questions in different words. The bank
 * stores each question once per candidate with a normalised key, a category,
 * a risk level and an AUTOMATION POLICY that says what an assisted
 * application (Stage 12) may do with the stored answer:
 *
 *   AUTO_FILL       — fill silently (contact details, a LinkedIn URL)
 *   ASK_IF_CHANGED  — fill, but confirm when the question or answer changed
 *   REQUIRE_REVIEW  — present the stored answer; the candidate confirms it
 *   NEVER_AUTOMATE  — never filled by software; the candidate answers each time
 *
 * The policy is not free choice. Each category has a FLOOR — the least strict
 * policy it permits — and `enforcePolicy` raises anything below it. Sensitive
 * questions (demographic self-identification, health, criminal record, age,
 * family status, SIN/SSN) are pinned to NEVER_AUTOMATE, cannot be relaxed by
 * the candidate, are never linked to evidence, and THEIR ANSWERS ARE NEVER
 * STORED: this table is a public-schema Prisma model, and ADR-0007 keeps
 * every RESTRICTED value out of those. The question is kept so the candidate
 * can see it was recognised and will always be asked live. Only `contact`
 * questions (an email, a URL) may AUTO_FILL.
 *
 * Stage 22 is not this: nothing here submits anything (ADR-0016).
 */

type Client = Prisma.TransactionClient;

export const QUESTION_CATEGORIES = ['eligibility', 'contact', 'logistics', 'compensation', 'experience', 'motivation', 'screening', 'sensitive', 'other'] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const AUTOMATION_POLICIES = ['AUTO_FILL', 'ASK_IF_CHANGED', 'REQUIRE_REVIEW', 'NEVER_AUTOMATE'] as const;
export type AutomationPolicy = (typeof AUTOMATION_POLICIES)[number];

const STRICTNESS: Record<AutomationPolicy, number> = { AUTO_FILL: 0, ASK_IF_CHANGED: 1, REQUIRE_REVIEW: 2, NEVER_AUTOMATE: 3 };

/** The least strict policy each category permits. */
export const POLICY_FLOOR: Record<QuestionCategory, AutomationPolicy> = {
  sensitive: 'NEVER_AUTOMATE',
  eligibility: 'REQUIRE_REVIEW',
  compensation: 'REQUIRE_REVIEW',
  screening: 'REQUIRE_REVIEW',
  motivation: 'REQUIRE_REVIEW',
  experience: 'ASK_IF_CHANGED',
  contact: 'AUTO_FILL',
  logistics: 'ASK_IF_CHANGED',
  other: 'REQUIRE_REVIEW',
};

export const DEFAULT_RISK: Record<QuestionCategory, RiskLevel> = {
  sensitive: 'high',
  eligibility: 'high',
  compensation: 'medium',
  screening: 'medium',
  motivation: 'medium',
  experience: 'low',
  contact: 'low',
  logistics: 'low',
  other: 'medium',
};

export class QuestionError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'QuestionError';
    this.status = status;
  }
}

/**
 * Normalise question text to a stable key: lower-case, punctuation-free,
 * single-spaced. A long question keeps its first 180 characters plus a digest
 * of the whole, so two long questions that share a prefix stay distinct.
 */
export function questionKey(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (norm.length <= 200) return norm;
  return `${norm.slice(0, 180)}#${createHash('sha256').update(norm).digest('hex').slice(0, 12)}`;
}

const RULES: { category: QuestionCategory; pattern: RegExp }[] = [
  // Sensitive first: a question that mentions both a visa and a disability is sensitive.
  {
    category: 'sensitive',
    pattern:
      /\b(gender|transgender|non-?binary|sex\b|pronouns?|ethnic|race\b|racial|hispanic|latin[oax]|indigenous|aboriginal|first nations|m[ée]tis|inuit|visible minority|disabilit|disabled|accommodat|impairment|veteran|military service|religio|marital|married|spouse|pregnan|children|childcare|caregiv|dependants?|dependents?|family status|\bage\b|aged?\b|date of birth|birth ?date|\bborn\b|how old|\b(18|19|21|40|65) or (older|over)|criminal|convict|arrest|charged|offen[cs]e|background check|medical|health|condition|\bhiv\b|mental|sexual orientation|lgbt|social insurance|\bsin\b|social security|\bssn\b|citizen|national origin|nationality|where were you born|union member|political|lift \d|physical (demands|requirements|ability)|stand for)/i,
  },
  { category: 'eligibility', pattern: /\b(authori[sz]ed to work|legally (able|entitled|eligible)|work (permit|authori[sz]ation|visa)|visa|sponsorship|sponsor|permanent resident|eligib|security clearance|relocat|driver'?s licen[cs]e|licen[cs]ed to)/i },
  { category: 'compensation', pattern: /\b(salary|compensation|pay\b|rate\b|hourly|wage|expected (pay|earnings)|remuneration|bonus)/i },
  // Contact details are the only AUTO_FILL category: a URL or an address is not a claim.
  { category: 'contact', pattern: /\b(phone|mobile|email|e-mail|linkedin|portfolio|website|github|address|city|postal code|zip code|province|state of residence)\b/i },
  { category: 'logistics', pattern: /\b(start date|available|availability|notice period|when (can|could|would) you|earliest|hours|shift|weekends?|travel|on-?site|remote|hybrid|commute)/i },
  { category: 'experience', pattern: /\b(years? of experience|how many years|experience with|proficien|familiar with|worked with|certif|degree|education|qualification|skills?)/i },
  { category: 'motivation', pattern: /\b(why (do you|are you|would you|this)|interest(ed)? in|motivat|what (attracts|excites)|career goals?|where do you see)/i },
  { category: 'screening', pattern: /\b(describe|tell us|explain|example|situation|how (did|would) you|what would you|cover letter|summary|about yourself)/i },
];

export interface Classification {
  category: QuestionCategory;
  riskLevel: RiskLevel;
  policy: AutomationPolicy;
}

/** Deterministic, keyword-based; the candidate can tighten but never loosen the result. */
export function classifyQuestion(text: string): Classification {
  const category = RULES.find((r) => r.pattern.test(text))?.category ?? 'other';
  return { category, riskLevel: DEFAULT_RISK[category], policy: POLICY_FLOOR[category] };
}

/** The policy actually applied: the requested one, raised to the category's floor. */
export function enforcePolicy(category: QuestionCategory, requested: AutomationPolicy | null | undefined): AutomationPolicy {
  const floor = POLICY_FLOOR[category];
  if (!requested || !(requested in STRICTNESS)) return floor;
  return STRICTNESS[requested] >= STRICTNESS[floor] ? requested : floor;
}

/** What an assisted application may do with a stored answer. */
export type AutomationDecision = 'fill' | 'ask' | 'review' | 'never';

export function resolveAutomation(q: Pick<ApplicationQuestion, 'policy' | 'answer' | 'lastConfirmedAt' | 'answerUpdatedAt'>): AutomationDecision {
  if (q.policy === 'NEVER_AUTOMATE') return 'never';
  if (!q.answer.trim()) return 'review';
  if (q.policy === 'REQUIRE_REVIEW') return 'review';
  if (q.policy === 'ASK_IF_CHANGED') {
    const confirmed = q.lastConfirmedAt && q.answerUpdatedAt && q.lastConfirmedAt >= q.answerUpdatedAt;
    return confirmed ? 'fill' : 'ask';
  }
  return 'fill';
}

export interface UpsertQuestionInput {
  question: string;
  answer?: string;
  policy?: AutomationPolicy | null;
  evidenceIds?: string[];
}

export async function listQuestions(tx: Client, userId: string): Promise<ApplicationQuestion[]> {
  return tx.applicationQuestion.findMany({ where: { userId }, orderBy: [{ category: 'asc' }, { updatedAt: 'desc' }] });
}

/**
 * Create or update by normalised key. Classification is recomputed from the
 * text on every save; the policy floor is enforced; evidence links must be
 * the candidate's own APPROVED evidence, and a sensitive question carries
 * none.
 */
export async function upsertQuestion(tx: Client, userId: string, input: UpsertQuestionInput): Promise<ApplicationQuestion> {
  const question = input.question.trim();
  if (question.length < 3 || question.length > 1000) throw new QuestionError('A question is 3 to 1000 characters.');
  const key = questionKey(question);
  if (!key) throw new QuestionError('A question needs some words in it.');
  const answer = (input.answer ?? '').trim();
  if (answer.length > 4000) throw new QuestionError('An answer is at most 4000 characters.');
  if (input.policy && !AUTOMATION_POLICIES.includes(input.policy)) throw new QuestionError('Unknown automation policy.');

  const classification = classifyQuestion(question);
  const policy = enforcePolicy(classification.category, input.policy);
  // A sensitive answer is never written to this table (ADR-0007): the row
  // records that the question exists and will always be asked live.
  const storedAnswer = classification.category === 'sensitive' ? '' : answer;

  let evidenceIds: string[] = [];
  if (classification.category !== 'sensitive' && input.evidenceIds?.length) {
    const unique = [...new Set(input.evidenceIds)];
    const owned = await tx.careerEvidence.findMany({ where: { userId, id: { in: unique }, status: 'approved' }, select: { id: true } });
    if (owned.length !== unique.length) throw new QuestionError('Every linked evidence item must be your own approved evidence.');
    evidenceIds = unique;
  }

  const existing = await tx.applicationQuestion.findFirst({ where: { userId, key } });
  const now = new Date();
  const answerChanged = !existing || existing.answer !== storedAnswer;
  const data = {
    question,
    category: classification.category,
    riskLevel: classification.riskLevel,
    policy,
    answer: storedAnswer,
    evidenceIds: JSON.stringify(evidenceIds),
    ...(answerChanged ? { answerUpdatedAt: now } : {}),
  };
  if (existing) return tx.applicationQuestion.update({ where: { id: existing.id, userId }, data });
  return tx.applicationQuestion.create({ data: { userId, key, ...data, answerUpdatedAt: now } });
}

/** The candidate confirms the stored answer is current (ASK_IF_CHANGED bookkeeping). */
export async function confirmAnswer(tx: Client, userId: string, id: string): Promise<ApplicationQuestion> {
  const row = await tx.applicationQuestion.findFirst({ where: { id, userId } });
  if (!row) throw new QuestionError('Question not found.', 404);
  return tx.applicationQuestion.update({ where: { id, userId }, data: { lastConfirmedAt: new Date() } });
}

export async function deleteQuestion(tx: Client, userId: string, id: string): Promise<void> {
  const row = await tx.applicationQuestion.findFirst({ where: { id, userId }, select: { id: true } });
  if (!row) throw new QuestionError('Question not found.', 404);
  await tx.applicationQuestion.delete({ where: { id, userId } });
}

/** The evidence ids an answer relies on, parsed. */
export function evidenceIdsOf(q: Pick<ApplicationQuestion, 'evidenceIds'>): string[] {
  return parseJson<string[]>(q.evidenceIds, []);
}

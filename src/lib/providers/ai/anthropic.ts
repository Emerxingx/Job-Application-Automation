import type {
  InterviewPrepPackage,
  MatchAnalysis,
  ResumeContent,
  TailoredDocuments,
} from '@/lib/types';
import { renderResumeText } from '@/lib/resume-render';
import type { AIProvider, JobContext } from './types';
import { MockAIProvider } from './mock';

/**
 * Claude-backed intelligence layer.
 *
 * Enabled with AI_PROVIDER=anthropic and an ANTHROPIC_API_KEY. Each method
 * constrains the model to a JSON schema via `output_config.format`, so the
 * responses parse deterministically instead of being scraped out of prose.
 *
 * The deterministic engine still runs first: its keyword analysis is fed to
 * the model as grounding, and it serves as the fallback if a call fails, so a
 * transient API problem degrades quality rather than breaking an application.
 */
export class AnthropicAIProvider implements AIProvider {
  readonly name = 'anthropic';

  private readonly model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
  private readonly fallback = new MockAIProvider();

  private async client() {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Resolves ANTHROPIC_API_KEY (or an `ant auth login` profile) from the env.
    return new Anthropic();
  }

  /**
   * Single request helper. Returns parsed JSON matching `schema`, or null so
   * the caller can fall back rather than surfacing an error to the applicant.
   */
  private async ask<T>(input: {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }): Promise<T | null> {
    try {
      const client = await this.client();

      const message = await client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? 16000,
        system: input.system,
        output_config: {
          effort: input.effort ?? 'high',
          format: { type: 'json_schema', schema: input.schema },
        },
        messages: [{ role: 'user', content: input.prompt }],
      });

      // Safety classifiers can decline with HTTP 200 — check before reading content.
      if (message.stop_reason === 'refusal') return null;

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return text ? (JSON.parse(text) as T) : null;
    } catch (error) {
      console.error('[anthropic] request failed, falling back to local engine:', error);
      return null;
    }
  }

  async analyzeMatch(resume: ResumeContent, job: JobContext): Promise<MatchAnalysis> {
    // Ground the model in the deterministic keyword analysis so its scoring is
    // anchored to real overlap rather than vibes.
    const baseline = await this.fallback.analyzeMatch(resume, job);

    const result = await this.ask<MatchAnalysis>({
      effort: 'medium',
      maxTokens: 4000,
      system:
        'You are an expert technical recruiter and ATS specialist for the Canadian and US job markets. ' +
        'You predict, honestly and without inflation, whether a candidate will clear automated resume ' +
        'screening and a recruiter review. You never invent experience the candidate does not have.',
      prompt: [
        'Score this candidate against the posting.',
        '',
        '## Posting',
        `Title: ${job.title}`,
        `Company: ${job.company}`,
        `Location: ${job.location} (${job.workMode})`,
        `Required skills: ${job.skills.join(', ')}`,
        `Requirements:\n${job.requirements.map((r) => `- ${r}`).join('\n')}`,
        '',
        '## Candidate resume',
        renderResumeText(resume),
        '',
        '## Deterministic keyword analysis (ground truth for overlap)',
        `Matched: ${baseline.matchedKeywords.join(', ') || 'none'}`,
        `Missing: ${baseline.missingKeywords.join(', ') || 'none'}`,
        `Baseline score: ${baseline.matchScore}`,
        '',
        'Return the calibrated score, sub-scores (0-100 each), the keyword lists, and a rationale ' +
          'of two to four sentences written directly to the candidate.',
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          matchScore: { type: 'integer' },
          breakdown: {
            type: 'object',
            properties: {
              skills: { type: 'integer' },
              experience: { type: 'integer' },
              keywords: { type: 'integer' },
              location: { type: 'integer' },
              seniority: { type: 'integer' },
            },
            required: ['skills', 'experience', 'keywords', 'location', 'seniority'],
            additionalProperties: false,
          },
          matchedKeywords: { type: 'array', items: { type: 'string' } },
          missingKeywords: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['matchScore', 'breakdown', 'matchedKeywords', 'missingKeywords', 'rationale'],
        additionalProperties: false,
      },
    });

    return result ?? baseline;
  }

  async tailor(
    resume: ResumeContent,
    job: JobContext,
    analysis: MatchAnalysis,
  ): Promise<TailoredDocuments> {
    const baseline = await this.fallback.tailor(resume, job, analysis);

    const result = await this.ask<{
      summary: string;
      headline: string;
      skills: string[];
      experience: { company: string; title: string; bullets: string[] }[];
      coverLetter: string;
      changes: string[];
      atsScore: number;
    }>({
      effort: 'high',
      maxTokens: 16000,
      system:
        'You tailor resumes for specific job postings. Absolute rule: never fabricate employers, ' +
        'titles, dates, credentials, or accomplishments. You may only rephrase, reorder, and ' +
        'reframe what the candidate already has, and surface skills their experience genuinely ' +
        'demonstrates. Write in plain, ATS-parseable language with quantified impact where the ' +
        'source material supports it.',
      prompt: [
        'Tailor this resume and write a cover letter for the posting below.',
        '',
        '## Posting',
        `Title: ${job.title} at ${job.company} (${job.location})`,
        `Requirements:\n${job.requirements.map((r) => `- ${r}`).join('\n')}`,
        `Description:\n${job.description}`,
        '',
        '## Gap analysis',
        `Already demonstrated: ${analysis.matchedKeywords.join(', ') || 'none'}`,
        `Named in posting but absent: ${analysis.missingKeywords.join(', ') || 'none'}`,
        '',
        '## Current resume (JSON)',
        JSON.stringify(resume, null, 2),
        '',
        'Return: a rewritten summary targeting this role; a headline mirroring the posting title; ' +
          'the skills list reordered so posting-relevant skills lead; the two most recent roles with ' +
          'bullets reordered and rephrased for relevance (same facts, same companies, same titles); ' +
          'a cover letter of three to four paragraphs; a plain-language list of the changes you made; ' +
          'and an estimated ATS score 0-100 after tailoring.',
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          headline: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
          experience: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                company: { type: 'string' },
                title: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
              },
              required: ['company', 'title', 'bullets'],
              additionalProperties: false,
            },
          },
          coverLetter: { type: 'string' },
          changes: { type: 'array', items: { type: 'string' } },
          atsScore: { type: 'integer' },
        },
        required: ['summary', 'headline', 'skills', 'experience', 'coverLetter', 'changes', 'atsScore'],
        additionalProperties: false,
      },
    });

    if (!result) return baseline;

    // Merge the model's rewrites onto the real resume, matching roles by
    // company+title so employment history can never be replaced wholesale.
    const experience = resume.experience.map((role) => {
      const rewritten = result.experience.find(
        (r) =>
          r.company.toLowerCase() === role.company.toLowerCase() &&
          r.title.toLowerCase() === role.title.toLowerCase(),
      );
      return rewritten?.bullets?.length ? { ...role, bullets: rewritten.bullets } : role;
    });

    const content: ResumeContent = {
      ...resume,
      headline: result.headline || resume.headline,
      summary: result.summary || resume.summary,
      skills: result.skills?.length ? result.skills : resume.skills,
      experience,
    };

    return {
      resumeText: renderResumeText(content),
      resumeContent: content,
      coverLetter: result.coverLetter || baseline.coverLetter,
      notes: {
        summaryRewritten: true,
        bulletsAdjusted: experience.filter((role, i) => role.bullets !== resume.experience[i]?.bullets)
          .length,
        skillsReordered: true,
        keywordsInjected: analysis.missingKeywords.filter((k) =>
          result.skills?.some((s) => s.toLowerCase() === k.toLowerCase()),
        ),
        atsScore: Math.max(0, Math.min(100, result.atsScore ?? baseline.notes.atsScore)),
        changes: result.changes?.length ? result.changes : baseline.notes.changes,
      },
    };
  }

  async prepareInterview(resume: ResumeContent, job: JobContext): Promise<InterviewPrepPackage> {
    const baseline = await this.fallback.prepareInterview(resume, job);

    const result = await this.ask<InterviewPrepPackage>({
      effort: 'high',
      maxTokens: 16000,
      system:
        'You are an interview coach. You produce specific, usable preparation material grounded in ' +
        "the candidate's actual history — never generic advice. STAR stories must be drafted from " +
        'the real roles and accomplishments provided.',
      prompt: [
        `Prepare this candidate for an interview for ${job.title} at ${job.company}.`,
        '',
        '## Posting',
        `Requirements:\n${job.requirements.map((r) => `- ${r}`).join('\n')}`,
        `Description:\n${job.description}`,
        '',
        '## Candidate resume',
        renderResumeText(resume),
        '',
        'Return 8-10 likely questions with suggested answers and tips, 3-4 STAR stories drafted from ' +
          'their real experience, a company research brief, and questions they should ask.',
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                category: {
                  type: 'string',
                  enum: ['behavioural', 'technical', 'situational', 'culture', 'closing'],
                },
                suggestedAnswer: { type: 'string' },
                tips: { type: 'array', items: { type: 'string' } },
              },
              required: ['question', 'category', 'suggestedAnswer', 'tips'],
              additionalProperties: false,
            },
          },
          stories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                situation: { type: 'string' },
                task: { type: 'string' },
                action: { type: 'string' },
                result: { type: 'string' },
                mapsTo: { type: 'array', items: { type: 'string' } },
              },
              required: ['title', 'situation', 'task', 'action', 'result', 'mapsTo'],
              additionalProperties: false,
            },
          },
          companyResearch: { type: 'string' },
          questionsToAsk: { type: 'array', items: { type: 'string' } },
        },
        required: ['questions', 'stories', 'companyResearch', 'questionsToAsk'],
        additionalProperties: false,
      },
    });

    return result ?? baseline;
  }
}

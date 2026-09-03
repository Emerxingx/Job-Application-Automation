import type {
  InterviewPrepPackage,
  InterviewQuestion,
  MatchAnalysis,
  ResumeContent,
  StarStory,
  TailoredDocuments,
} from '@/lib/types';
import { renderResumeText } from '@/lib/resume-render';
import type { AIProvider, JobContext, MatchOptions } from './types';
import {
  displayKeyword,
  extractSkills,
  normalize,
  overlapRatio,
  requiredYears,
  seniorityOf,
  tokenize,
  yearsOfExperience,
} from './keywords';

/**
 * A deterministic analysis engine.
 *
 * Every score is derived from actual text comparison between the resume and
 * the posting — no randomness — so the same pairing always produces the same
 * number and the "why" shown to the user is truthful.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  async analyzeMatch(resume: ResumeContent, job: JobContext, options: MatchOptions = {}): Promise<MatchAnalysis> {
    const canonical = options.canonical ?? ((s: string) => s);
    const weights = options.weights ?? { skills: 0.34, keywords: 0.22, experience: 0.22, seniority: 0.14, location: 0.08 };
    const jobText = `${job.title} ${job.description} ${job.requirements.join(' ')} ${job.skills.join(' ')}`;
    const resumeText = [
      resume.headline,
      resume.summary,
      resume.skills.join(' '),
      resume.experience.map((e) => `${e.title} ${e.company} ${e.bullets.join(' ')}`).join(' '),
      resume.education.map((e) => `${e.credential} ${e.institution}`).join(' '),
      resume.certifications.join(' '),
    ].join(' ');

    // Stage 08: both sides are compared under the equivalence map, so a
    // posting's "Postgres" is satisfied by a résumé's "PostgreSQL". The
    // posting's own spelling is what is reported as matched or missing.
    const jobSkills = new Set([...extractSkills(jobText), ...job.skills.map((s) => normalize(s))]);
    const resumeSkills = new Set([...extractSkills(resumeText), ...resume.skills.map((s) => normalize(s))].map(canonical));

    const matched: string[] = [];
    const missing: string[] = [];
    for (const skill of jobSkills) {
      if (resumeSkills.has(canonical(skill))) matched.push(skill);
      else missing.push(skill);
    }

    // --- Sub-scores --------------------------------------------------------

    // Skills: proportion of the posting's named skills the resume evidences.
    const skillsScore = jobSkills.size
      ? Math.round((matched.length / jobSkills.size) * 100)
      : 70;

    // Keywords: overlap against the signal-bearing parts of the posting only.
    // Scoring against the full description would measure the resume against
    // benefits blurbs and EEO boilerplate, which no resume ever contains, and
    // drag every candidate's score down uniformly.
    const jobSignalText = `${job.title} ${job.requirements.join(' ')} ${job.skills.join(' ')}`;
    const jobTokens = [...new Set(tokenize(jobSignalText))];
    const resumeTokens = [...new Set(tokenize(resumeText))];
    const keywordsScore = Math.round(overlapRatio(jobTokens, resumeTokens) * 135);

    // Experience: candidate years vs. the posting's stated requirement.
    const need = requiredYears(job.requirements);
    const have = yearsOfExperience(resume.experience);
    let experienceScore: number;
    if (!need) experienceScore = 78;
    else if (have >= need) experienceScore = Math.min(100, 85 + Math.round((have - need) * 4));
    else experienceScore = Math.max(25, Math.round((have / need) * 82));

    // Seniority: distance between the resume's top title and the job title.
    const jobLevel = seniorityOf(job.title);
    const resumeLevel = resume.experience.length
      ? Math.max(...resume.experience.map((e) => seniorityOf(e.title)))
      : 2;
    const levelGap = Math.abs(jobLevel - resumeLevel);
    const seniorityScore = [100, 88, 68, 45, 30][Math.min(levelGap, 4)];

    // Location: remote is always reachable; otherwise compare city/province.
    const locationScore = this.scoreLocation(resume.location ?? '', job.location, job.workMode);

    const breakdown = {
      skills: clamp(skillsScore),
      experience: clamp(experienceScore),
      keywords: clamp(keywordsScore),
      location: clamp(locationScore),
      seniority: clamp(seniorityScore),
    };

    // Weighted toward what actually gates a screening decision. The weights
    // are governed data since Stage 08 (src/lib/matching/weights.ts); these
    // constants are the built-in baseline, recorded as "builtin:1".
    const weighted =
      breakdown.skills * weights.skills +
      breakdown.keywords * weights.keywords +
      breakdown.experience * weights.experience +
      breakdown.seniority * weights.seniority +
      breakdown.location * weights.location;

    // Experience, seniority and location are only worth anything if the
    // candidate can actually do the job. Without this, a 6-year analyst scores
    // ~45 on a backend engineering role purely for being senior and local —
    // which would be a dishonest number to show someone deciding where to apply.
    const domainFit = Math.min(1, 0.5 + (breakdown.skills / 100) * 0.7);
    const matchScore = clamp(Math.round(weighted * domainFit));

    return {
      matchScore,
      breakdown,
      matchedKeywords: matched.map(displayKeyword).sort(),
      missingKeywords: missing.map(displayKeyword).sort(),
      rationale: this.explain(matchScore, breakdown, matched.length, jobSkills.size, have, need),
    };
  }

  private scoreLocation(resumeLocation: string, jobLocation: string, workMode: string): number {
    if (workMode === 'remote' || /remote/i.test(jobLocation)) return 100;
    if (!resumeLocation) return 70;

    const a = normalize(resumeLocation).split(/[, ]+/).filter(Boolean);
    const b = normalize(jobLocation).split(/[, ]+/).filter(Boolean);
    if (a.some((part) => b.includes(part))) return 100; // same city or province
    return workMode === 'hybrid' ? 45 : 55;
  }

  private explain(
    score: number,
    b: { skills: number; experience: number; keywords: number; location: number; seniority: number },
    matchedCount: number,
    totalSkills: number,
    have: number,
    need: number,
  ): string {
    const parts: string[] = [];

    if (score >= 85) parts.push('Excellent fit — this profile should clear both ATS filters and a recruiter screen.');
    else if (score >= 70) parts.push('Strong fit — competitive with targeted resume tailoring.');
    else if (score >= 55) parts.push('Moderate fit — worth applying if you address the gaps below.');
    else parts.push('Stretch application — significant gaps against the posting.');

    parts.push(`You match ${matchedCount} of ${totalSkills} named skills.`);

    if (need && have >= need) parts.push(`Your ${have} years of experience meets the ${need}-year requirement.`);
    else if (need) parts.push(`The posting asks for ${need} years; your resume shows ${have}.`);

    if (b.seniority < 70) parts.push('Title seniority differs from the posting, which recruiters weigh heavily.');
    if (b.location < 60) parts.push('Location is a constraint for this on-site or hybrid role.');
    if (b.keywords < 55) parts.push('Keyword density is low — tailoring will lift the ATS score materially.');

    return parts.join(' ');
  }

  async tailor(
    resume: ResumeContent,
    job: JobContext,
    analysis: MatchAnalysis,
  ): Promise<TailoredDocuments> {
    const changes: string[] = [];

    // 1. Reorder skills so posting-relevant ones lead — ATS parsers and human
    //    skimmers both weight the first items most.
    const matchedLc = new Set(analysis.matchedKeywords.map((k) => normalize(k)));
    const prioritized = [...resume.skills].sort((a, b) => {
      const aHit = matchedLc.has(normalize(a)) ? 1 : 0;
      const bHit = matchedLc.has(normalize(b)) ? 1 : 0;
      return bHit - aHit;
    });
    const skillsReordered = prioritized.join('|') !== resume.skills.join('|');
    if (skillsReordered) changes.push('Reordered the skills section to lead with the requirements named in this posting.');

    // 2. Surface missing keywords the résumé ALREADY EVIDENCES outside the
    //    skills list — a technology named in a bullet, a project or a
    //    certification but never listed as a skill. Nothing else is ever
    //    added: a keyword the résumé does not mention anywhere is a claim the
    //    candidate has not made, and the grounding checker would reject it
    //    (AI_GOVERNANCE.md — the truthfulness rule applies to this engine too).
    const injectable = analysis.missingKeywords
      .filter((k) => this.isEvidencedElsewhere(k, resume))
      .slice(0, 5);
    const finalSkills = [...prioritized, ...injectable.filter((k) => !prioritized.some((s) => normalize(s) === normalize(k)))];
    if (injectable.length) {
      changes.push(`Listed ${injectable.length} skill${injectable.length > 1 ? 's' : ''} your experience already evidences: ${injectable.join(', ')}.`);
    }

    // 3. Rewrite the professional summary around the target title and company.
    const topSkills = analysis.matchedKeywords.slice(0, 4);
    const years = yearsOfExperience(resume.experience);
    const targetRole = stripLevel(job.title);
    const summary = [
      `${targetRole} with ${years >= 1 ? `${Math.floor(years)}+ years` : 'hands-on'} of experience`,
      topSkills.length ? ` across ${topSkills.slice(0, 3).join(', ')}` : '',
      `. ${resume.summary.split('. ').slice(-1)[0] || ''}`,
      ` Seeking to bring this track record to ${job.company} as ${article(targetRole)} ${targetRole}.`,
    ]
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    changes.push(`Rewrote the professional summary to target the ${job.title} role at ${job.company}.`);

    // 4. Promote bullets that reference the posting's language.
    const jobTokens = new Set(tokenize(`${job.title} ${job.requirements.join(' ')} ${job.skills.join(' ')}`));
    let bulletsAdjusted = 0;
    const experience = resume.experience.map((role, idx) => {
      // Only re-rank the two most recent roles; older history stays chronological.
      if (idx > 1) return role;
      const ranked = [...role.bullets].sort(
        (a, b) => relevanceOf(b, jobTokens) - relevanceOf(a, jobTokens),
      );
      if (ranked.join('|') !== role.bullets.join('|')) bulletsAdjusted += 1;
      return { ...role, bullets: ranked };
    });
    if (bulletsAdjusted) {
      changes.push(`Re-ordered achievement bullets in your ${bulletsAdjusted} most recent role${bulletsAdjusted > 1 ? 's' : ''} to lead with posting-relevant impact.`);
    }

    // 5. Mirror the job title in the headline — a well-known ATS win. Posting
    //    qualifiers ("(Bilingual)", "— New Grad Welcome") are stripped: they
    //    describe the vacancy, and asserting them about the candidate would be
    //    a claim their resume does not support.
    const headline = stripLevel(job.title);
    changes.push(`Set the resume headline to "${headline}" to mirror the posting's job title.`);

    const tailoredContent: ResumeContent = {
      ...resume,
      headline,
      summary,
      skills: finalSkills,
      experience,
    };

    // ATS score reflects the improved keyword coverage after tailoring.
    const coverageBefore = analysis.breakdown.skills;
    const atsScore = clamp(Math.round(coverageBefore + injectable.length * 4 + (skillsReordered ? 5 : 0) + 8));

    return {
      resumeText: renderResumeText(tailoredContent),
      resumeContent: tailoredContent,
      coverLetter: this.coverLetter(tailoredContent, job, analysis),
      notes: {
        summaryRewritten: true,
        bulletsAdjusted,
        skillsReordered,
        keywordsInjected: injectable,
        atsScore,
        changes,
      },
    };
  }

  /**
   * A missing keyword may be surfaced only if the résumé itself evidences it
   * somewhere other than the skills list — the candidate wrote it, so listing
   * it is a reorganisation, not an assertion.
   */
  private isEvidencedElsewhere(keyword: string, resume: ResumeContent): boolean {
    const kw = normalize(keyword);
    if (!kw) return false;
    const haystack = normalize(
      [
        resume.headline,
        resume.summary,
        ...resume.certifications,
        ...(resume.projects ?? []).flatMap((p) => [p.name, p.description]),
        ...resume.experience.flatMap((e) => [e.title, ...e.bullets]),
      ].join(' '),
    );
    // Word-bounded so "r" does not match "react" and "go" does not match "google".
    return new RegExp(`(^|[^a-z0-9+#])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#])`).test(haystack);
  }

  private coverLetter(resume: ResumeContent, job: JobContext, analysis: MatchAnalysis): string {
    const top = analysis.matchedKeywords.slice(0, 3);
    const recent = resume.experience[0];
    const proof = recent?.bullets[0] ?? 'delivered measurable results in my most recent role';

    return [
      `${resume.fullName}`,
      `${resume.location ?? ''}${resume.location ? ' | ' : ''}${resume.email}${resume.phone ? ` | ${resume.phone}` : ''}`,
      ``,
      `Hiring Team`,
      `${job.company}`,
      `${job.location}`,
      ``,
      `Dear Hiring Team,`,
      ``,
      `I am writing to apply for the ${job.title} position at ${job.company}. ${resume.headline ? `As ${article(resume.headline)} ${resume.headline.toLowerCase()}, ` : ''}I bring direct experience in ${top.length ? top.join(', ') : 'the core areas this role calls for'} — the capabilities your posting places at the centre of the role.`,
      ``,
      `In my most recent role at ${recent?.company ?? 'my current organization'}, I ${lowerFirst(proof)} That work maps closely to what this position requires${top.length ? `: ${top.join(', ')}` : ''}.`,
      ``,
      // Nothing from the posting's free text is copied into the letter: a
      // description is untrusted input (it can carry instructions or claims),
      // and quoting it would put the poster's words in the candidate's mouth.
      `What draws me to ${job.company} specifically is the chance to apply ${top.length ? top.slice(0, 2).join(' and ') : 'this experience'} to the problems your posting describes. I am confident I would contribute quickly, and I would welcome the chance to discuss how my background fits your team's priorities.`,
      ``,
      `Thank you for your time and consideration.`,
      ``,
      `Sincerely,`,
      `${resume.fullName}`,
    ].join('\n');
  }

  async prepareInterview(resume: ResumeContent, job: JobContext): Promise<InterviewPrepPackage> {
    const skills = job.skills.length ? job.skills : extractSkills(job.description).map(displayKeyword);
    const recent = resume.experience[0];
    const company = job.company;

    const questions: InterviewQuestion[] = [
      {
        question: `Walk me through your background and why you're interested in the ${job.title} role at ${company}.`,
        category: 'closing',
        suggestedAnswer: `Open with your current title and years of experience, then trace a two- or three-step arc that lands on this role. Anchor on ${skills.slice(0, 2).join(' and ') || 'the core skills in the posting'}, cite one quantified result from ${recent?.company ?? 'your most recent role'}, and close on why ${company} specifically — reference something concrete about their product or market.`,
        tips: [
          'Keep it to 90 seconds — this is a trailer, not the film.',
          'End on why this company, not just why this role.',
          'Rehearse aloud; this is the one question you can fully script.',
        ],
      },
      {
        question: `Tell me about a time you had to deliver a project under a tight deadline with incomplete information.`,
        category: 'behavioural',
        suggestedAnswer: `Use STAR. Situation: name the constraint and stakes. Task: your specific ownership. Action: how you sequenced decisions and what you deliberately deprioritized. Result: quantify it. Interviewers are testing judgement under ambiguity, so make the trade-off reasoning explicit.`,
        tips: [
          'Quantify the result — percentage, dollar, or time saved.',
          'Own the decision; avoid "we" when the choice was yours.',
          'Name one thing you would do differently — it signals maturity.',
        ],
      },
      {
        question: `How do you approach ${skills[0] ?? 'the core technical work'} in a production setting?`,
        category: 'technical',
        suggestedAnswer: `Describe your actual workflow end to end: how you scope the problem, the tools you reach for, how you validate correctness, and how you hand off or document. Reference a specific example from ${recent?.company ?? 'your experience'} rather than describing the process abstractly.`,
        tips: [
          'Show the reasoning, not just the tool name.',
          'Mention how you verify your own work.',
          `Tie it back to ${company}'s scale or domain if you can.`,
        ],
      },
      {
        question: `Describe a time you disagreed with a stakeholder or manager. How did you handle it?`,
        category: 'behavioural',
        suggestedAnswer: `Pick a disagreement you resolved with evidence rather than authority. Show that you sought to understand their position first, brought data, and committed fully once a decision was made — even if it went against you.`,
        tips: [
          'Never make the other party the villain.',
          'Emphasize the shared goal you both cared about.',
          'Close with the working relationship afterwards.',
        ],
      },
      {
        question: `You're given a project with an ambiguous scope and competing priorities from two teams. What do you do?`,
        category: 'situational',
        suggestedAnswer: `Lay out a concrete sequence: clarify the outcome each team actually needs, identify the overlap, surface the trade-off explicitly to a decision-maker with options and costs, then document the decision. Emphasize that you escalate with recommendations, not just problems.`,
        tips: [
          'Structure the answer as numbered steps — it reads as clear thinking.',
          'Show you escalate early rather than silently absorbing the conflict.',
        ],
      },
      {
        question: `What do you know about ${company}, and why us?`,
        category: 'culture',
        suggestedAnswer: `Name their product and market position, one recent development you have genuinely read about, and connect it to your own motivation. Then link it to a specific responsibility in the posting so the answer lands as considered rather than generic.`,
        tips: [
          'Research their last quarter of news before the interview.',
          'Avoid praising them generically — be specific or skip it.',
        ],
      },
      {
        question: `Where do you see the biggest challenge in this ${job.title} role in the first 90 days?`,
        category: 'situational',
        suggestedAnswer: `Show you have read the posting closely. Name a real challenge implied by the requirements — ramping on their domain, or a stakeholder landscape — then describe your 30/60/90 approach: learn, contribute, own.`,
        tips: [
          'Frame it as a plan, not a worry.',
          'A 30/60/90 structure is memorable and rare.',
        ],
      },
      {
        question: `What are your salary expectations?`,
        category: 'closing',
        suggestedAnswer: `Give a researched range rather than a single number, grounded in market data for this title and city, and state that you are flexible on the whole package. If asked early, it is reasonable to ask what range they have budgeted first.`,
        tips: [
          'Research the market band for this title in this city beforehand.',
          'Anchor slightly above your target — the range sets the negotiation floor.',
        ],
      },
    ];

    const stories: StarStory[] = (resume.experience.slice(0, 3) as ResumeContent['experience']).map((role, i) => {
      const bullet = role.bullets[0] ?? 'Delivered a critical project for the team.';
      const templates = [
        {
          title: `Delivering impact at ${role.company}`,
          maps: ['Tell me about a time you delivered results', 'Biggest accomplishment', 'Working under pressure'],
        },
        {
          title: `Solving a hard problem at ${role.company}`,
          maps: ['Tell me about a difficult problem', 'How do you approach ambiguity', 'Technical depth'],
        },
        {
          title: `Leading through change at ${role.company}`,
          maps: ['Influencing without authority', 'Handling disagreement', 'Leadership example'],
        },
      ];
      const t = templates[i % templates.length];

      return {
        title: t.title,
        situation: `While working as ${article(role.title)} ${role.title} at ${role.company}, the team faced a situation that required decisive ownership. (Replace this with the specific context — the constraint, the stakes, and who was affected.)`,
        task: `You were responsible for the outcome. State precisely what was yours to solve, and what success was defined as.`,
        action: `${/[.!?]$/.test(bullet) ? bullet : `${bullet}.`} Break this into the two or three decisions you personally made, and why you chose each.`,
        result: `Close with the quantified outcome — the number, the timeline, and what changed for the business afterwards.`,
        mapsTo: t.maps,
      };
    });

    return {
      questions,
      stories,
      companyResearch: [
        `Research checklist for ${company}`,
        ``,
        `Business & market`,
        `- What does ${company} sell, and who is the customer? Be able to say it in one sentence.`,
        `- Who are their two closest competitors, and what is their edge?`,
        `- Any funding, earnings, launches or leadership changes in the last 6 months?`,
        ``,
        `The role`,
        `- This posting emphasizes: ${skills.slice(0, 5).join(', ') || 'the responsibilities listed in the description'}.`,
        `- Location and arrangement: ${job.location} (${job.workMode}).`,
        `- Map each requirement to one concrete example from your history before the call.`,
        ``,
        `People`,
        `- Look up your interviewers on LinkedIn — tenure, background, what they've posted.`,
        `- Check the team's recent engineering blog, case studies or conference talks.`,
        ``,
        `Culture signals`,
        `- Read recent Glassdoor and Indeed reviews for recurring themes.`,
        `- Note the language in the posting: it signals what they reward.`,
      ].join('\n'),
      questionsToAsk: [
        `What does success look like in this role at the 90-day and one-year marks?`,
        `How is the team structured, and who would I work with most closely?`,
        `What's the biggest challenge the team is facing right now?`,
        `How does the team make decisions when priorities conflict?`,
        `What's your favourite part about working at ${company} — and what would you change?`,
        `What's the next step in the process, and when can I expect to hear back?`,
      ],
    };
  }
}

// --- helpers ---------------------------------------------------------------

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function relevanceOf(bullet: string, jobTokens: Set<string>): number {
  const tokens = tokenize(bullet);
  const hits = tokens.filter((t) => jobTokens.has(t)).length;
  // Quantified bullets ("increased X by 30%") earn a bonus — they convert better.
  const quantified = /\d+\s*%|\$\s*\d|\b\d{2,}\b/.test(bullet) ? 2 : 0;
  return hits + quantified;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? 'an' : 'a';
}

function lowerFirst(s: string): string {
  const trimmed = s.trim();
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function stripLevel(title: string): string {
  return title.replace(/\s*\(.*?\)\s*/g, '').replace(/\s+—.*$/, '').trim();
}

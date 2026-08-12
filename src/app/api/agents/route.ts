import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';

const agentSchema = z.object({
  name: z.string().min(2, 'Give your agent a name.').max(80),
  titles: z.array(z.string().min(1)).min(1, 'Add at least one job title to search for.').max(10),
  keywords: z.array(z.string()).max(20).default([]),
  excludeKeywords: z.array(z.string()).max(20).default([]),
  locations: z.array(z.string()).min(1, 'Add at least one location.').max(10),
  workMode: z.enum(['onsite', 'hybrid', 'remote', 'any']).default('any'),
  jobType: z.enum(['full_time', 'part_time', 'contract', 'internship', 'any']).default('any'),
  minSalary: z.number().int().min(0).max(1_000_000).nullable().default(null),
  seniority: z.string().default('any'),
  minMatchScore: z.number().int().min(0).max(100).default(65),
  autoApply: z.boolean().default(false),
  autoApplyThreshold: z.number().int().min(0).max(100).default(85),
  scanFrequency: z.enum(['hourly', 'twice_daily', 'daily', 'manual']).default('daily'),
});

export const GET = route(async () => {
  const user = await requireUser();

  const agents = await db.agent.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { matches: true, applications: true } } },
  });

  return ok({ agents });
});

export const POST = route(async (request: Request) => {
  const user = await requireUser();
  const body = agentSchema.parse(await request.json());

  // Enforce the plan's agent ceiling.
  const maxAgents = user.subscription?.plan.maxAgents ?? 1;
  const count = await db.agent.count({ where: { userId: user.id } });
  if (count >= maxAgents) {
    return fail(
      `Your ${user.subscription?.plan.name ?? 'current'} plan includes ${maxAgents} agent${maxAgents === 1 ? '' : 's'}. Upgrade to run more searches in parallel.`,
      403,
    );
  }

  const agent = await db.agent.create({
    data: {
      userId: user.id,
      name: body.name,
      titles: JSON.stringify(body.titles),
      keywords: JSON.stringify(body.keywords),
      excludeKeywords: JSON.stringify(body.excludeKeywords),
      locations: JSON.stringify(body.locations),
      workMode: body.workMode,
      jobType: body.jobType,
      minSalary: body.minSalary,
      seniority: body.seniority,
      minMatchScore: body.minMatchScore,
      autoApply: body.autoApply,
      autoApplyThreshold: body.autoApplyThreshold,
      scanFrequency: body.scanFrequency,
    },
  });

  await db.activityEvent.create({
    data: {
      userId: user.id,
      type: 'agent',
      message: `Created the agent "${agent.name}".`,
      meta: JSON.stringify({ agentId: agent.id }),
    },
  });

  return ok({ agent }, { status: 201 });
});

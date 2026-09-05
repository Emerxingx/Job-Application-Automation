import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { quantityFor } from '@/lib/entitlements/service';
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
  const { user, run } = await requireTenant();

  const agents = await run((tx) =>
    tx.agent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { matches: true, applications: true } } },
    }),
  );

  return ok({ agents });
});

export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = agentSchema.parse(await request.json());

  // Stage 15: the ceiling is the `agents` entitlement (the plan's grant, or a comp on top), read on the tenant path.
  const [maxAgents, count] = await run(async (tx) => [await quantityFor(tx, user.id, 'agents'), await tx.agent.count({ where: { userId: user.id } })] as const);
  if (count >= maxAgents) {
    return fail(
      `Your ${user.subscription?.plan.name ?? 'current'} plan includes ${maxAgents} agent${maxAgents === 1 ? '' : 's'}. Upgrade to run more searches in parallel.`,
      403,
    );
  }

  const agent = await run(async (tx) => {
    const created = await tx.agent.create({
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

    await tx.activityEvent.create({
      data: {
        userId: user.id,
        type: 'agent',
        message: `Created the agent "${created.name}".`,
        meta: JSON.stringify({ agentId: created.id }),
      },
    });
    return created;
  });

  return ok({ agent }, { status: 201 });
});

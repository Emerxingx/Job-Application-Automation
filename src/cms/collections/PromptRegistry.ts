import type { CollectionConfig } from 'payload';

/**
 * AI Prompt & Generation Registry.
 *
 * Version-controls the system and user prompts that drive resume tailoring,
 * cover-letter generation and question answering, so the LLM orchestrator
 * fetches a prompt by slug at runtime rather than shipping it in code. That
 * makes prompt iteration and A/B testing an operator action, not a deploy.
 *
 * Design decisions:
 *
 *  - One document per (slug, version). `isDefault` marks the version the
 *    orchestrator serves for a slug; a hook enforces one default per slug so
 *    promoting v2 retires v1 automatically — same rollback story as ATS
 *    rulesets.
 *  - Interpolation variables are declared explicitly in `requiredVariables`,
 *    not inferred from the text, so the interpolation engine can fail loudly
 *    when a caller forgets one (see src/lib/prompt-engine.ts). A save-time
 *    check verifies every declared variable actually appears in the prompt,
 *    catching the reverse mistake.
 *  - `modelParameters` is JSON — temperature, max_tokens, top_p,
 *    response_format — validated on save so a malformed number can't reach the
 *    provider.
 */
export const PromptRegistry: CollectionConfig = {
  slug: 'prompt-registry',
  labels: { singular: 'Prompt', plural: 'Prompt Registry' },
  admin: {
    useAsTitle: 'label',
    defaultColumns: ['promptSlug', 'version', 'targetModel', 'isDefault', 'updatedAt'],
    description:
      'Versioned system/user prompts for the LLM orchestrator. Editing a prompt takes effect without a deploy. One default per slug.',
  },
  access: {
    read: () => true,
    create: ({ req }) => isStaff(req.user),
    update: ({ req }) => isStaff(req.user),
    delete: ({ req }) => isStaff(req.user),
  },
  fields: [
    {
      name: 'label',
      type: 'text',
      hooks: {
        beforeValidate: [
          ({ value, siblingData }) =>
            value || `${siblingData?.promptSlug ?? 'prompt'} v${siblingData?.version ?? '?'}`,
        ],
      },
    },
    {
      name: 'promptSlug',
      type: 'text',
      required: true,
      index: true,
      admin: {
        description: 'Stable identifier the orchestrator fetches by, e.g. "resume-tailor-v2", "qa-salary-expectation".',
      },
    },
    {
      name: 'version',
      type: 'number',
      required: true,
      defaultValue: 1,
      min: 1,
    },
    {
      name: 'isDefault',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: { description: 'The version served for this slug. Setting this retires the previous default.' },
    },
    {
      name: 'modelProvider',
      type: 'select',
      required: true,
      defaultValue: 'anthropic',
      options: [
        { label: 'Anthropic', value: 'anthropic' },
        { label: 'OpenAI', value: 'openai' },
      ],
    },
    {
      name: 'targetModel',
      type: 'text',
      required: true,
      admin: { description: 'Exact model id, e.g. "claude-sonnet-5", "gpt-4o".' },
    },
    {
      name: 'systemPrompt',
      type: 'textarea',
      required: true,
      admin: {
        description: 'System prompt. Use {{variable}} placeholders, e.g. {{master_resume}}, {{job_description}}.',
      },
    },
    {
      name: 'userPromptTemplate',
      type: 'textarea',
      admin: { description: 'Optional user-message template, same {{variable}} syntax.' },
    },
    {
      name: 'requiredVariables',
      type: 'array',
      admin: {
        description:
          'Every interpolation variable this prompt needs. The interpolation engine refuses to run if a caller omits one.',
      },
      fields: [{ name: 'name', type: 'text', required: true }],
    },
    {
      name: 'modelParameters',
      type: 'json',
      admin: {
        description: 'JSON: temperature, max_tokens, top_p, response_format. Validated on save.',
      },
      defaultValue: { temperature: 0.7, max_tokens: 2048 },
      validate: (value: unknown) => validateModelParameters(value),
    },
    {
      name: 'notes',
      type: 'textarea',
    },
  ],
  hooks: {
    afterChange: [
      async ({ doc, previousDoc }) => {
        const { invalidatePrompt } = await import('@/lib/prompt-engine');
        const slugs = new Set(
          [doc?.promptSlug, previousDoc?.promptSlug].filter(Boolean) as string[],
        );
        await Promise.all([...slugs].map((s) => invalidatePrompt(s)));
      },
    ],
    afterDelete: [
      async ({ doc }) => {
        if (doc?.promptSlug) {
          const { invalidatePrompt } = await import('@/lib/prompt-engine');
          await invalidatePrompt(doc.promptSlug as string);
        }
      },
    ],
    beforeValidate: [
      ({ data }) => {
        // Catch the mismatch: a declared variable that doesn't appear in either
        // template is almost always a typo that would make the engine reject
        // valid calls.
        if (!data) return data;
        const declared: string[] = Array.isArray(data.requiredVariables)
          ? data.requiredVariables
              .map((v: { name?: string }) => v?.name)
              .filter((n): n is string => Boolean(n))
          : [];
        const haystack = `${data.systemPrompt ?? ''}\n${data.userPromptTemplate ?? ''}`;
        const orphan = declared.find((name) => !haystack.includes(`{{${name}}}`));
        if (orphan) {
          throw new Error(
            `requiredVariables lists "${orphan}" but no {{${orphan}}} placeholder appears in the prompt.`,
          );
        }
        return data;
      },
    ],
    beforeChange: [
      async ({ data, req, operation, originalDoc }) => {
        if (data.isDefault) {
          const slug = data.promptSlug ?? originalDoc?.promptSlug;
          if (slug) {
            await req.payload.update({
              collection: 'prompt-registry',
              where: {
                and: [
                  { promptSlug: { equals: slug } },
                  { isDefault: { equals: true } },
                  ...(operation === 'update' && originalDoc?.id
                    ? [{ id: { not_equals: originalDoc.id } }]
                    : []),
                ],
              },
              data: { isDefault: false },
              overrideAccess: true,
            });
          }
        }
        return data;
      },
    ],
  },
};

function isStaff(user: unknown): boolean {
  return (user as { role?: string } | null)?.role
    ? (user as { role?: string }).role !== 'member'
    : false;
}

/** modelParameters must be a plain object with sane numeric ranges where present. */
function validateModelParameters(value: unknown): true | string {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'modelParameters must be a JSON object.';
  }
  const p = value as Record<string, unknown>;
  if ('temperature' in p && (typeof p.temperature !== 'number' || p.temperature < 0 || p.temperature > 2)) {
    return 'temperature must be a number between 0 and 2.';
  }
  if ('top_p' in p && (typeof p.top_p !== 'number' || p.top_p < 0 || p.top_p > 1)) {
    return 'top_p must be a number between 0 and 1.';
  }
  if ('max_tokens' in p && (typeof p.max_tokens !== 'number' || p.max_tokens < 1 || !Number.isInteger(p.max_tokens))) {
    return 'max_tokens must be a positive integer.';
  }
  return true;
}

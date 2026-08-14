import type { CollectionConfig } from 'payload';

/**
 * ATS Selectors & Automation Rulesets.
 *
 * Lets engineers update how the automation engine drives each job board's
 * application form without a code redeploy: when Greenhouse or Workday shifts
 * a selector, an operator edits the ruleset here and the engine picks it up on
 * its next cache miss (see src/lib/cms-fast/ats.ts).
 *
 * Design decisions worth knowing:
 *
 *  - One document per (platform, version). `isActive` is what the engine
 *    reads by; a `beforeChange` hook enforces that only one version per
 *    platform is active at a time, so activating v3 automatically retires v2.
 *    That makes rollback a one-field edit rather than a data cleanup.
 *  - `selectorMap` and `fallbackSelectors` are JSON, not sub-fields, because
 *    the shape is engine-owned and evolves faster than a CMS schema should.
 *    They are validated on save (below) so a typo can't ship a broken ruleset.
 *  - Read access is public so the engine can fetch without a session, but
 *    write access is staff-only — a bad ruleset drives real submissions.
 */

/** The selector keys the engine expects. Kept in sync with the automation code. */
const REQUIRED_SELECTOR_KEYS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'resume_upload',
  'cover_letter_input',
  'submit_button',
  'next_step_button',
] as const;

export const AtsRulesets: CollectionConfig = {
  slug: 'ats-rulesets',
  labels: { singular: 'ATS Ruleset', plural: 'ATS Rulesets' },
  admin: {
    useAsTitle: 'label',
    defaultColumns: ['label', 'atsPlatformName', 'version', 'isActive', 'updatedAt'],
    description:
      'How the automation engine fills each ATS application form. Editing a ruleset takes effect without a code deploy. Only one version per platform can be active at a time.',
  },
  access: {
    // The engine reads without a session; only staff may change how real
    // applications are submitted.
    read: () => true,
    create: ({ req }) => isStaff(req.user),
    update: ({ req }) => isStaff(req.user),
    delete: ({ req }) => isStaff(req.user),
  },
  fields: [
    {
      name: 'label',
      type: 'text',
      admin: { description: 'Human-readable name, e.g. "Greenhouse — multi-step v3".' },
      hooks: {
        // Auto-fill a label from platform + version if the operator leaves it blank.
        beforeValidate: [
          ({ value, siblingData }) =>
            value || `${siblingData?.atsPlatformName ?? 'ATS'} v${siblingData?.version ?? '?'}`,
        ],
      },
    },
    {
      name: 'atsPlatformName',
      type: 'select',
      required: true,
      index: true,
      options: [
        { label: 'Greenhouse', value: 'greenhouse' },
        { label: 'Lever', value: 'lever' },
        { label: 'Workday', value: 'workday' },
        { label: 'Workable', value: 'workable' },
        { label: 'Taleo', value: 'taleo' },
        { label: 'Ashby', value: 'ashby' },
        { label: 'SmartRecruiters', value: 'smartrecruiters' },
        { label: 'iCIMS', value: 'icims' },
        { label: 'LinkedIn (Easy Apply)', value: 'linkedin' },
      ],
    },
    {
      name: 'version',
      type: 'number',
      required: true,
      defaultValue: 1,
      min: 1,
      admin: { description: 'Increment when you change selectors. Keep old versions for rollback.' },
    },
    {
      name: 'isActive',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: {
        description: 'The engine uses the single active ruleset per platform. Activating this retires the others.',
      },
    },
    {
      name: 'navigationFlowType',
      type: 'select',
      required: true,
      defaultValue: 'single_page',
      options: [
        { label: 'Single page', value: 'single_page' },
        { label: 'Multi-step wizard', value: 'multi_step' },
        { label: 'Account creation required', value: 'account_required' },
      ],
    },
    {
      name: 'antiBotMitigationLevel',
      type: 'select',
      required: true,
      defaultValue: 'standard',
      options: [
        { label: 'Standard', value: 'standard' },
        { label: 'Heavy stealth', value: 'heavy_stealth' },
        { label: 'Human delay required', value: 'human_delay' },
      ],
      admin: {
        description:
          'Signals how carefully the engine should pace itself. "Human delay required" also means assisted-apply only.',
      },
    },
    {
      name: 'selectorMap',
      type: 'json',
      required: true,
      admin: {
        description:
          'Primary selectors keyed by field: ' +
          REQUIRED_SELECTOR_KEYS.join(', ') +
          '. CSS or XPath strings.',
      },
      validate: (value: unknown) => validateSelectorMap(value),
    },
    {
      name: 'fallbackSelectors',
      type: 'json',
      admin: {
        description:
          'Optional secondary selectors tried when a primary fails. Same keys as selectorMap; each value is an array of CSS/XPath strings.',
      },
      validate: (value: unknown) => validateFallbackSelectors(value),
    },
    {
      name: 'notes',
      type: 'textarea',
      admin: { description: 'Why this version exists, quirks of the platform, etc.' },
    },
  ],
  hooks: {
    afterChange: [
      async ({ doc, previousDoc }) => {
        // Invalidate the engine's cache for any platform this write touched,
        // so an activation is reflected immediately rather than after the TTL.
        // Both current and previous platform, in case the platform changed.
        const { invalidateAtsRuleset } = await import('@/lib/cms-fast/ats');
        const platforms = new Set(
          [doc?.atsPlatformName, previousDoc?.atsPlatformName].filter(Boolean) as string[],
        );
        await Promise.all([...platforms].map((p) => invalidateAtsRuleset(p)));
      },
    ],
    afterDelete: [
      async ({ doc }) => {
        if (doc?.atsPlatformName) {
          const { invalidateAtsRuleset } = await import('@/lib/cms-fast/ats');
          await invalidateAtsRuleset(doc.atsPlatformName as string);
        }
      },
    ],
    beforeChange: [
      async ({ data, req, operation, originalDoc }) => {
        // Enforce single-active-per-platform. When this document is being set
        // active, deactivate every other version of the same platform.
        if (data.isActive) {
          const platform = data.atsPlatformName ?? originalDoc?.atsPlatformName;
          if (platform) {
            await req.payload.update({
              collection: 'ats-rulesets',
              where: {
                and: [
                  { atsPlatformName: { equals: platform } },
                  { isActive: { equals: true } },
                  ...(operation === 'update' && originalDoc?.id
                    ? [{ id: { not_equals: originalDoc.id } }]
                    : []),
                ],
              },
              data: { isActive: false },
              overrideAccess: true,
            });
          }
        }
        return data;
      },
    ],
  },
};

// --- validation ------------------------------------------------------------

function isStaff(user: unknown): boolean {
  return (user as { role?: string } | null)?.role
    ? (user as { role?: string }).role !== 'member'
    : false;
}

/** A selectorMap must be an object containing every required field key as a non-empty string. */
function validateSelectorMap(value: unknown): true | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'selectorMap must be a JSON object.';
  }
  const map = value as Record<string, unknown>;
  const missing = REQUIRED_SELECTOR_KEYS.filter(
    (k) => typeof map[k] !== 'string' || !(map[k] as string).trim(),
  );
  if (missing.length) {
    return `selectorMap is missing selectors for: ${missing.join(', ')}.`;
  }
  return true;
}

/** fallbackSelectors, when present, must map keys to arrays of strings. */
function validateFallbackSelectors(value: unknown): true | string {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'fallbackSelectors must be a JSON object of { key: string[] }.';
  }
  for (const [key, arr] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(arr) || arr.some((s) => typeof s !== 'string')) {
      return `fallbackSelectors["${key}"] must be an array of strings.`;
    }
  }
  return true;
}

export { REQUIRED_SELECTOR_KEYS };

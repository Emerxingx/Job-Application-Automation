import type { CollectionConfig } from 'payload';

/**
 * Universal Form & Q&A Field Mapping.
 *
 * Standardises how the open-ended questions ATS forms ask ("Are you legally
 * allowed to work in the US?", "Will you require sponsorship?") map back to a
 * structured, canonical key on the user profile. The engine matches a form
 * label against every mapping's `fuzzyQuestionPatterns`; the first hit gives it
 * the canonical key to pull from the profile, the data type to coerce to, and
 * a fallback rule for the LLM when the profile has no answer.
 *
 * Why patterns live in the CMS: ATS question wording is endlessly variable and
 * changes without notice. An operator adding a new phrasing here is far faster
 * and safer than a code change, and the matching stays testable because the
 * patterns are plain strings/regex, validated on save.
 */
export const FieldMappings: CollectionConfig = {
  slug: 'field-mappings',
  labels: { singular: 'Field Mapping', plural: 'Field Mappings' },
  admin: {
    useAsTitle: 'canonicalFieldKey',
    defaultColumns: ['canonicalFieldKey', 'dataType', 'updatedAt'],
    description:
      'Maps the free-text questions ATS forms ask onto canonical profile keys, so the engine can answer them consistently.',
  },
  access: {
    read: () => true,
    create: ({ req }) => isStaff(req.user),
    update: ({ req }) => isStaff(req.user),
    delete: ({ req }) => isStaff(req.user),
  },
  fields: [
    {
      name: 'canonicalFieldKey',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        description: 'Stable key on the user profile, e.g. "work_authorization_us", "salary_expectation_usd".',
      },
    },
    {
      name: 'label',
      type: 'text',
      admin: { description: 'Human-readable name for operators, e.g. "US work authorization".' },
    },
    {
      name: 'dataType',
      type: 'select',
      required: true,
      defaultValue: 'text',
      options: [
        { label: 'Boolean (yes/no)', value: 'boolean' },
        { label: 'Numeric', value: 'numeric' },
        { label: 'Text', value: 'text' },
        { label: 'Dropdown / select', value: 'select' },
      ],
    },
    {
      name: 'fuzzyQuestionPatterns',
      type: 'array',
      required: true,
      minRows: 1,
      admin: {
        description:
          'Patterns matched against an ATS form label. Choose "contains" for a substring, or "regex" for a full regular expression.',
      },
      fields: [
        {
          name: 'kind',
          type: 'select',
          required: true,
          defaultValue: 'contains',
          options: [
            { label: 'Contains (case-insensitive substring)', value: 'contains' },
            { label: 'Regex', value: 'regex' },
          ],
        },
        {
          name: 'pattern',
          type: 'text',
          required: true,
          validate: (value: unknown, { siblingData }: { siblingData?: { kind?: string } }) => {
            if (typeof value !== 'string' || !value.trim()) return 'Pattern is required.';
            if (siblingData?.kind === 'regex') {
              try {
                new RegExp(value);
              } catch (e) {
                return `Invalid regex: ${(e as Error).message}`;
              }
            }
            return true;
          },
        },
      ],
    },
    {
      name: 'selectOptions',
      type: 'array',
      admin: {
        description: 'For dropdown fields: the canonical option values the engine may choose from.',
        condition: (data) => data?.dataType === 'select',
      },
      fields: [{ name: 'value', type: 'text', required: true }],
    },
    {
      name: 'defaultFallbackRule',
      type: 'textarea',
      required: true,
      admin: {
        description:
          'Instruction for the LLM when the profile has no value for this key, e.g. "If unknown, answer No and do not fabricate authorization." Never invents credentials.',
      },
    },
  ],
};

function isStaff(user: unknown): boolean {
  return (user as { role?: string } | null)?.role
    ? (user as { role?: string }).role !== 'member'
    : false;
}

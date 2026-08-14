import type { CollectionConfig } from 'payload';

/** The "Learning Paths" future module named in the original brief. */
export const LearningPaths: CollectionConfig = {
  slug: 'learning-paths',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'level', 'updatedAt'] },
  access: { read: () => true },
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true },
    { name: 'summary', type: 'textarea' },
    { name: 'coverImage', type: 'upload', relationTo: 'media' },
    {
      name: 'level',
      type: 'select',
      options: [
        { label: 'Beginner', value: 'beginner' },
        { label: 'Intermediate', value: 'intermediate' },
        { label: 'Advanced', value: 'advanced' },
      ],
    },
    {
      name: 'nocCodes',
      type: 'array',
      label: 'Related NOC codes',
      fields: [{ name: 'code', type: 'text', required: true }],
    },
    {
      name: 'modules',
      type: 'array',
      minRows: 1,
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'description', type: 'textarea' },
        { name: 'resourceUrl', type: 'text' },
        { name: 'estimatedHours', type: 'number' },
      ],
    },
  ],
};

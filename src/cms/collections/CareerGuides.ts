import type { CollectionConfig } from 'payload';

/** The "Change your Career" future module named in the original brief. */
export const CareerGuides: CollectionConfig = {
  slug: 'career-guides',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'fromRole', 'toRole'] },
  access: { read: () => true },
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true },
    { name: 'fromRole', type: 'text', label: 'Transitioning from' },
    { name: 'toRole', type: 'text', label: 'Transitioning to' },
    { name: 'summary', type: 'textarea' },
    { name: 'content', type: 'richText' },
    { name: 'coverImage', type: 'upload', relationTo: 'media' },
    {
      name: 'relatedNocCodes',
      type: 'array',
      fields: [{ name: 'code', type: 'text', required: true }],
    },
  ],
};

import type { CollectionConfig } from 'payload';

/**
 * Programmatic SEO landing pages.
 *
 * Powers the "AI Resume Builder for {role} in {city}" style pages the
 * marketing team spins up at scale. Distinct from the `pages` collection
 * (hand-built marketing pages composed from blocks): these are templated,
 * high-volume, and keyed by a job-title/industry pair so they can be generated
 * and managed in bulk.
 */
export const SeoPages: CollectionConfig = {
  slug: 'seo-pages',
  labels: { singular: 'SEO Page', plural: 'SEO Pages' },
  admin: {
    useAsTitle: 'pageTitle',
    defaultColumns: ['pageTitle', 'slug', 'targetJobTitle', 'industry', '_status'],
    description:
      'Programmatic SEO landing pages, e.g. "AI Resume Builder for Data Analyst in Toronto". Templated and high-volume.',
  },
  access: { read: () => true },
  versions: { drafts: true },
  fields: [
    { name: 'pageTitle', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: { description: 'URL path, e.g. "ai-resume-builder/data-analyst/toronto".' },
    },
    { name: 'seoMetaDescription', type: 'textarea', admin: { description: 'Meta description, ~155 chars.' } },
    {
      type: 'row',
      fields: [
        { name: 'targetJobTitle', type: 'text', index: true, admin: { width: '50%' } },
        { name: 'industry', type: 'text', index: true, admin: { width: '50%' } },
      ],
    },
    { name: 'heroHeadline', type: 'text' },
    { name: 'bodyContent', type: 'richText' },
    {
      name: 'sampleTailoredBullets',
      type: 'array',
      admin: {
        description:
          'Before/after examples shown as social proof — a weak input bullet next to the tailored output.',
      },
      fields: [
        { name: 'input', type: 'textarea', required: true, admin: { description: 'The applicant’s original bullet.' } },
        { name: 'output', type: 'textarea', required: true, admin: { description: 'The tailored version.' } },
      ],
    },
    {
      name: 'seo',
      type: 'group',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'ogImage', type: 'upload', relationTo: 'media' },
      ],
    },
  ],
};

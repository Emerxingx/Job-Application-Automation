import type { CollectionConfig } from 'payload';
import { PAGE_BLOCKS } from '../blocks';

/**
 * Marketing pages, built from blocks so an editor can compose a page without
 * a code change. The landing page is the document with slug "home" — see
 * `src/lib/cms.ts` for how the app fetches and falls back on it.
 */
export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'slug', 'updatedAt'] },
  access: { read: () => true },
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      admin: { description: 'Use "home" for the landing page.' },
    },
    { name: 'layout', type: 'blocks', blocks: PAGE_BLOCKS },
    {
      name: 'seo',
      type: 'group',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'description', type: 'textarea' },
      ],
    },
  ],
};

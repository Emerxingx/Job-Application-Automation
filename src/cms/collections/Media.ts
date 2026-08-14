import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectionConfig } from 'payload';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Uploaded images for pages, blog posts, learning paths, and certifications. */
export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    // Images need to render on the public site without an auth token.
    read: () => true,
  },
  upload: {
    // Sibling to `storage/` (application folders) at the repo root, kept out
    // of git the same way — see .gitignore.
    staticDir: path.resolve(dirname, '../../../media'),
    imageSizes: [
      { name: 'thumbnail', width: 400, height: 300, position: 'centre' },
      { name: 'card', width: 768, height: 512, position: 'centre' },
      { name: 'hero', width: 1600, height: 900, position: 'centre' },
    ],
    mimeTypes: ['image/*'],
  },
  fields: [
    { name: 'alt', type: 'text', required: true, admin: { description: 'Describe the image for screen readers and SEO.' } },
  ],
};

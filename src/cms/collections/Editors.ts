import type { CollectionConfig } from 'payload';

/**
 * CMS staff accounts. Deliberately separate from Prisma's `User` model
 * (job-seeker accounts) — an editor login is an internal-staff credential
 * with write access to public content, and conflating it with the product's
 * own auth would blur a boundary that matters for security review.
 */
export const Editors: CollectionConfig = {
  slug: 'editors',
  auth: true,
  admin: { useAsTitle: 'email', defaultColumns: ['name', 'email', 'role'] },
  access: {
    // Payload's own bootstrap flow (creating the first editor when none
    // exist) bypasses these checks automatically — nothing to special-case.
    // Cast explicitly: req.user's precise shape depends on payload-types.ts,
    // which is generated after this file is written, not before.
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => (req.user as { role?: string } | null)?.role === 'admin',
    update: ({ req }) => (req.user as { role?: string } | null)?.role === 'admin',
    delete: ({ req }) => (req.user as { role?: string } | null)?.role === 'admin',
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'editor',
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'Editor', value: 'editor' },
      ],
    },
  ],
};

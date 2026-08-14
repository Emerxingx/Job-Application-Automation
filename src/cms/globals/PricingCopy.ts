import type { GlobalConfig } from 'payload';

/**
 * Page-level framing copy for the pricing section only — the heading above
 * the table and a reassurance FAQ. Deliberately does NOT include per-plan
 * price, quota, or feature data: that lives in Prisma's `Plan` table, which
 * drives real checkout and quota enforcement (see src/lib/subscription.ts).
 * Duplicating it here would let a content edit silently disagree with what
 * a customer is actually charged.
 */
export const PricingCopy: GlobalConfig = {
  slug: 'pricing-copy',
  access: { read: () => true },
  fields: [
    { name: 'heading', type: 'text', defaultValue: 'Pick your application volume' },
    { name: 'subheading', type: 'textarea' },
    {
      name: 'faq',
      type: 'array',
      fields: [
        { name: 'question', type: 'text', required: true },
        { name: 'answer', type: 'textarea', required: true },
      ],
    },
  ],
};

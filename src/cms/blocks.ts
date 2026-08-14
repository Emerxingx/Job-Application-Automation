import type { Block } from 'payload';

/**
 * Reusable page-building blocks.
 *
 * Pages are composed from these rather than a single rigid template, so an
 * editor can reorder, add, or drop sections without a code change — the
 * "full expansion" ask from the brief. Keep new block types here as the
 * marketing site grows.
 */

export const HeroBlock: Block = {
  slug: 'hero',
  labels: { singular: 'Hero', plural: 'Heroes' },
  fields: [
    { name: 'eyebrow', type: 'text', admin: { description: 'Small label above the headline, e.g. "Built for the Canadian & US job market".' } },
    { name: 'headline', type: 'text', required: true },
    {
      name: 'headlineAccent',
      type: 'text',
      admin: { description: 'Optional second line, rendered in the accent color — e.g. "Start getting interviews."' },
    },
    { name: 'subheadline', type: 'textarea' },
    { name: 'primaryCtaLabel', type: 'text', defaultValue: 'Start your search' },
    { name: 'primaryCtaHref', type: 'text', defaultValue: '/signup' },
    { name: 'secondaryCtaLabel', type: 'text', defaultValue: 'Try the live demo' },
    { name: 'secondaryCtaHref', type: 'text', defaultValue: '/dashboard' },
  ],
};

export const FeatureGridBlock: Block = {
  slug: 'featureGrid',
  labels: { singular: 'Feature Grid', plural: 'Feature Grids' },
  fields: [
    { name: 'heading', type: 'text' },
    { name: 'subheading', type: 'textarea' },
    {
      name: 'features',
      type: 'array',
      minRows: 1,
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'description', type: 'textarea' },
        {
          name: 'icon',
          type: 'text',
          admin: { description: 'A lucide-react icon name, e.g. "Target", "FileText", "MessagesSquare".' },
        },
      ],
    },
  ],
};

export const RichTextBlock: Block = {
  slug: 'richText',
  labels: { singular: 'Rich Text', plural: 'Rich Text Blocks' },
  fields: [{ name: 'content', type: 'richText' }],
};

export const CtaBlock: Block = {
  slug: 'cta',
  labels: { singular: 'Call to Action', plural: 'Calls to Action' },
  fields: [
    { name: 'heading', type: 'text', required: true },
    { name: 'body', type: 'textarea' },
    { name: 'buttonLabel', type: 'text', defaultValue: 'Create your account' },
    { name: 'buttonHref', type: 'text', defaultValue: '/signup' },
  ],
};

export const PAGE_BLOCKS = [HeroBlock, FeatureGridBlock, RichTextBlock, CtaBlock];

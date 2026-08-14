import type { Block } from 'payload';

/**
 * Dashboard widget blocks — the editable-layout system for app pages.
 *
 * The contract that keeps this safe: a block configures WHICH widgets render,
 * in WHAT order, with WHAT copy — never what a widget does. Every widget is
 * real, tested application code in `src/components/dashboard-widgets/`;
 * authentication, data scoping and business logic live in the page shell and
 * inside each widget, out of reach of any layout edit. Deleting every block
 * in the admin cannot expose another user's data or break the apply flow —
 * the worst possible edit is an empty dashboard, and even that falls back to
 * the built-in default layout.
 *
 * Payload renders a `blocks` field with drag-to-reorder, add and delete in
 * its admin UI out of the box, which is exactly the layout-editing surface
 * this needs — no custom canvas required.
 */

export const StatsRowBlock: Block = {
  slug: 'statsRow',
  labels: { singular: 'Stats row', plural: 'Stats rows' },
  fields: [
    {
      name: 'stats',
      type: 'select',
      hasMany: true,
      defaultValue: ['applications', 'agents', 'matches', 'interviewRate'],
      options: [
        { label: 'Applications sent', value: 'applications' },
        { label: 'Active agents', value: 'agents' },
        { label: 'New matches', value: 'matches' },
        { label: 'Interview rate', value: 'interviewRate' },
      ],
      admin: { description: 'Which stat tiles appear, in this order.' },
    },
  ],
};

export const GettingStartedBlock: Block = {
  slug: 'gettingStarted',
  labels: { singular: 'Getting-started card', plural: 'Getting-started cards' },
  fields: [
    { name: 'heading', type: 'text', defaultValue: 'Create your first job agent' },
    {
      name: 'body',
      type: 'textarea',
      defaultValue:
        'Tell JobPilot which titles you want and where. Your agent will scan live postings and score each one against your resume.',
    },
    { name: 'ctaLabel', type: 'text', defaultValue: 'Create an agent' },
  ],
};

export const TopMatchesBlock: Block = {
  slug: 'topMatches',
  labels: { singular: 'Best matches', plural: 'Best-matches widgets' },
  fields: [
    { name: 'heading', type: 'text', defaultValue: 'Your best matches' },
    {
      name: 'count',
      type: 'number',
      defaultValue: 4,
      min: 1,
      max: 10,
      admin: { description: 'How many matches to show (1–10).' },
    },
  ],
};

export const RecentActivityBlock: Block = {
  slug: 'recentActivity',
  labels: { singular: 'Recent activity', plural: 'Recent-activity widgets' },
  fields: [
    { name: 'heading', type: 'text', defaultValue: 'Recent activity' },
    {
      name: 'count',
      type: 'number',
      defaultValue: 6,
      min: 1,
      max: 20,
      admin: { description: 'How many events to show (1–20).' },
    },
  ],
};

export const PipelineBlock: Block = {
  slug: 'pipeline',
  labels: { singular: 'Pipeline summary', plural: 'Pipeline summaries' },
  fields: [{ name: 'heading', type: 'text', defaultValue: 'Pipeline' }],
};

/**
 * A CMS-native widget: an announcement banner every user sees on their
 * dashboard until it is removed. The one widget whose entire existence is
 * editorial, so it belongs to the CMS completely.
 */
export const AnnouncementBlock: Block = {
  slug: 'announcement',
  labels: { singular: 'Announcement banner', plural: 'Announcement banners' },
  fields: [
    { name: 'heading', type: 'text', required: true },
    { name: 'body', type: 'textarea' },
    {
      name: 'tone',
      type: 'select',
      defaultValue: 'info',
      options: [
        { label: 'Info (blue)', value: 'info' },
        { label: 'Success (green)', value: 'success' },
        { label: 'Warning (amber)', value: 'warning' },
      ],
    },
    { name: 'linkLabel', type: 'text' },
    { name: 'linkHref', type: 'text' },
  ],
};

export const DASHBOARD_BLOCKS = [
  StatsRowBlock,
  GettingStartedBlock,
  TopMatchesBlock,
  RecentActivityBlock,
  PipelineBlock,
  AnnouncementBlock,
];

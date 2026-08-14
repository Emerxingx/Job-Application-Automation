import type { GlobalConfig } from 'payload';
import { DASHBOARD_BLOCKS } from '../blocks-dashboard';

/**
 * The layout of the customer dashboard overview page (/dashboard).
 *
 * Editors drag to reorder, add, remove and configure widgets here; the page
 * renders whatever this global holds. When the global has never been saved
 * (fresh install) the page falls back to a built-in default that mirrors the
 * original hardcoded layout exactly — see DEFAULT_DASHBOARD_LAYOUT in
 * src/lib/cms.ts.
 *
 * Deliberately a *global*, not a collection: there is one dashboard layout
 * for the whole product. Per-user layout customisation would be a product
 * feature (stored per user in Prisma), not a CMS concern.
 */
export const DashboardLayout: GlobalConfig = {
  slug: 'dashboard-layout',
  label: 'Dashboard Layout',
  access: { read: () => true },
  admin: {
    description:
      'Order and configuration of the widgets on every user’s dashboard overview. ' +
      'Drag to reorder. Widgets are pre-built and safe: layout edits cannot change what a widget does or whose data it sees.',
  },
  fields: [
    {
      name: 'widgets',
      type: 'blocks',
      blocks: DASHBOARD_BLOCKS,
      admin: { initCollapsed: true },
    },
  ],
};

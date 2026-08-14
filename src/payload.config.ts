import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from 'payload';
import { sqliteAdapter } from '@payloadcms/db-sqlite';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import sharp from 'sharp';

import { resolvePayloadSecret } from './lib/cms-secret';
import { Editors } from './cms/collections/Editors';
import { Media } from './cms/collections/Media';
import { Pages } from './cms/collections/Pages';
import { BlogPosts } from './cms/collections/BlogPosts';
import { LearningPaths } from './cms/collections/LearningPaths';
import { CareerGuides } from './cms/collections/CareerGuides';
import { Certifications } from './cms/collections/Certifications';
import { AtsRulesets } from './cms/collections/AtsRulesets';
import { PromptRegistry } from './cms/collections/PromptRegistry';
import { FieldMappings } from './cms/collections/FieldMappings';
import { SeoPages } from './cms/collections/SeoPages';
import { SiteSettings } from './cms/globals/SiteSettings';
import { PricingCopy } from './cms/globals/PricingCopy';
import { DashboardLayout } from './cms/globals/DashboardLayout';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * JobPilot AI's headless CMS.
 *
 * Runs inside this same Next.js app (Payload 3's native Next integration —
 * no separate service to deploy) and owns its own database, deliberately
 * kept apart from Prisma's:
 *
 *  - Prisma owns transactional product data (users, jobs, applications,
 *    subscriptions) — the tables that drive billing and quota enforcement.
 *  - Payload owns editorial content (marketing pages, blog, Learning Paths,
 *    Career Guides, Certifications) — the tables an editor changes without
 *    a deploy.
 *
 * Two systems, two lifecycles, two backup/restore stories. Nothing here
 * reads or writes a Prisma table, and nothing in the app's business logic
 * depends on Payload being configured — the marketing pages fall back to
 * their existing hardcoded copy if no CMS content exists yet (see
 * src/lib/cms.ts), the same "works with zero config, upgrades when
 * credentials appear" pattern used for the job/AI/payment providers.
 */
export default buildConfig({
  admin: {
    user: Editors.slug,
    meta: { titleSuffix: ' — JobPilot AI CMS' },
  },
  editor: lexicalEditor({}),
  // Required for the Media collection's imageSizes to actually generate;
  // without it Payload silently skips resizing.
  sharp,
  collections: [
    Editors,
    Media,
    Pages,
    BlogPosts,
    LearningPaths,
    CareerGuides,
    Certifications,
    // Automation-platform collections: read by the engine and orchestrator,
    // written by staff.
    AtsRulesets,
    PromptRegistry,
    FieldMappings,
    SeoPages,
  ],
  globals: [SiteSettings, PricingCopy, DashboardLayout],
  secret: resolvePayloadSecret(),
  db: sqliteAdapter({
    client: {
      // A separate file from Prisma's dev.db — see the module comment above
      // for why the two systems don't share a database.
      url: process.env.PAYLOAD_DATABASE_URI || 'file:./payload.db',
    },
  }),
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  // Mounted under /api/cms rather than Payload's default /api, so its
  // catch-all route can never shadow the app's existing /api/* endpoints
  // (agents, applications, apply, auth, billing, interview-prep, profile,
  // resume, scan, webhooks). The Next.js route files under
  // src/app/(payload)/ mirror this path exactly.
  routes: {
    api: '/api/cms',
  },
});

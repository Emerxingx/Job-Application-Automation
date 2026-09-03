import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from 'payload';
import { sqliteAdapter } from '@payloadcms/db-sqlite';
import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import sharp from 'sharp';

import { resolvePayloadSecret } from './lib/cms-secret';
import { normalizeDatabaseUrl } from './lib/db-url';
import { Editors } from './cms/collections/Editors';
import { Media } from './cms/collections/Media';
import { Pages } from './cms/collections/Pages';
import { BlogPosts } from './cms/collections/BlogPosts';
import { LearningPaths } from './cms/collections/LearningPaths';
import { CareerGuides } from './cms/collections/CareerGuides';
import { Certifications } from './cms/collections/Certifications';
import { AtsRulesets } from './cms/collections/AtsRulesets';
import { FieldMappings } from './cms/collections/FieldMappings';
import { SeoPages } from './cms/collections/SeoPages';
import { SiteSettings } from './cms/globals/SiteSettings';
import { PricingCopy } from './cms/globals/PricingCopy';
import { DashboardLayout } from './cms/globals/DashboardLayout';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The CMS database adapter is chosen from PAYLOAD_DATABASE_URI's scheme.
 *
 * Production runs PostgreSQL (ADR-0002, ADR-0015: a SEPARATE logical database
 * on the same managed Canadian instance as Prisma's — separate lifecycle,
 * separate backup story, no shared tables). Local development may still use
 * a SQLite file, because the CMS has no tenancy and no RLS requirement of its
 * own and a clean clone must boot with zero configuration.
 *
 * The password is percent-encoded before the pool parses it, for the same
 * reason as src/lib/db-url.ts.
 */
function cmsDatabase() {
  const uri = process.env.PAYLOAD_DATABASE_URI || 'file:./payload.db';
  if (/^postgres(ql)?:\/\//i.test(uri)) {
    return postgresAdapter({ pool: { connectionString: normalizeDatabaseUrl(uri) } });
  }
  return sqliteAdapter({ client: { url: uri } });
}

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
    components: {
      // A launcher to the client-management console (/console) so staff can
      // reach the CRM from the CMS without the CRM's data crossing into the
      // CMS's trust boundary.
      afterNavLinks: ['@/cms/components/CrmLauncher'],
    },
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
    // Automation-platform collections: read by the engine, written by staff.
    // PromptRegistry left the CMS in Stage 03 (ADR-0003, ADR-0019): prompts
    // are security-relevant configuration and now live in the transactional
    // database as `PromptVersion`, administered from /console/prompts with
    // step-up authentication, approval, evaluation gating and an audit trail.
    // AtsRulesets and FieldMappings follow in Stages 05 and 12.
    AtsRulesets,
    FieldMappings,
    SeoPages,
  ],
  globals: [SiteSettings, PricingCopy, DashboardLayout],
  secret: resolvePayloadSecret(),
  // A separate database from Prisma's — see the module comment above for why
  // the two systems don't share one.
  db: cmsDatabase(),
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

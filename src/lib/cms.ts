import { getPayload } from 'payload';
import config from '@payload-config';

/**
 * Read access to CMS content for the public site.
 *
 * Uses Payload's Local API — a direct in-process database read, no HTTP hop —
 * so a server component can render CMS content with no network round trip.
 *
 * Every accessor here returns `null` rather than throwing when content is
 * absent or the CMS is unreachable. That is deliberate and matches the
 * provider pattern used elsewhere in this codebase: the marketing site keeps
 * rendering its built-in copy until an editor publishes something, so an
 * empty CMS or a failed CMS never takes the front page down.
 */

/** Shape the landing page consumes. Narrower than Payload's generated types. */
export interface HeroContent {
  eyebrow?: string;
  headline: string;
  headlineAccent?: string;
  subheadline?: string;
  primaryCtaLabel?: string;
  primaryCtaHref?: string;
  secondaryCtaLabel?: string;
  secondaryCtaHref?: string;
}

export interface FeatureItem {
  title: string;
  description?: string;
  icon?: string;
}

export interface FeatureGridContent {
  heading?: string;
  subheading?: string;
  features: FeatureItem[];
}

export interface LandingContent {
  hero: HeroContent | null;
  featureGrid: FeatureGridContent | null;
}

type UnknownBlock = { blockType?: string; [key: string]: unknown };

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Fetch the CMS-managed parts of the landing page.
 *
 * Returns nulls when there is no `home` page document yet, which is the
 * expected state on a fresh install — the caller falls back to its built-in
 * copy.
 */
export async function getLandingContent(): Promise<LandingContent> {
  const empty: LandingContent = { hero: null, featureGrid: null };

  try {
    const payload = await getPayload({ config });
    const result = await payload.find({
      collection: 'pages',
      where: { slug: { equals: 'home' } },
      limit: 1,
      depth: 1,
      // Drafts stay out of the public site until published.
      draft: false,
    });

    const page = result.docs[0];
    if (!page) return empty;

    const layout = (page.layout ?? []) as UnknownBlock[];

    const heroBlock = layout.find((b) => b.blockType === 'hero');
    const gridBlock = layout.find((b) => b.blockType === 'featureGrid');

    const headline = str(heroBlock?.headline);

    return {
      // A hero with no headline is not usable content — treat it as absent
      // so the fallback copy renders instead of an empty banner.
      hero: heroBlock && headline
        ? {
            eyebrow: str(heroBlock.eyebrow),
            headline,
            headlineAccent: str(heroBlock.headlineAccent),
            subheadline: str(heroBlock.subheadline),
            primaryCtaLabel: str(heroBlock.primaryCtaLabel),
            primaryCtaHref: str(heroBlock.primaryCtaHref),
            secondaryCtaLabel: str(heroBlock.secondaryCtaLabel),
            secondaryCtaHref: str(heroBlock.secondaryCtaHref),
          }
        : null,
      featureGrid: gridBlock
        ? {
            heading: str(gridBlock.heading),
            subheading: str(gridBlock.subheading),
            features: Array.isArray(gridBlock.features)
              ? (gridBlock.features as UnknownBlock[])
                  .map((f) => ({
                    title: str(f.title) ?? '',
                    description: str(f.description),
                    icon: str(f.icon),
                  }))
                  .filter((f) => f.title)
              : [],
          }
        : null,
    };
  } catch (error) {
    // A CMS problem must never take down the public marketing page.
    console.error('[cms] could not load landing content; using built-in copy:', error);
    return empty;
  }
}

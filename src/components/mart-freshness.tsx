import { describeFreshness, martFreshness } from '@/lib/analytics/freshness';
import type { MartName } from '@/lib/analytics/platform/dictionary';

/**
 * Stage 21 (ADR-0036): the one line every reporting surface carries - when
 * its mart was last rebuilt, and STALE past the mart's SLA. A stale
 * dashboard says so rather than silently showing old numbers; there is no
 * scheduler, so this line is also the operator's cue.
 */
export async function MartFreshnessNote({ marts }: { marts: readonly MartName[] }) {
  const freshness = await martFreshness(marts);
  const stale = freshness.some((f) => f.stale);
  return (
    <p className={`text-xs ${stale ? 'text-danger' : 'text-muted'}`}>
      {freshness.map(describeFreshness).join(' · ')}
      {stale ? ' - the numbers are the last rebuilt ones.' : ''}
    </p>
  );
}

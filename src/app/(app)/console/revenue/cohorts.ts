/**
 * Cohort retention for the revenue page. Stage 21 (ADR-0036): the pure grid
 * builder lives in `src/lib/analytics/finance/cohort-grid.ts` (re-exported
 * here so the tests and the page keep their imports); `loadCohortGrid` now
 * reads `SubscriptionCohortMart` - the finance rollup builds the grid from
 * the subscriptions once and writes the cells - instead of scanning the
 * subscriptions on every page view.
 */
import { readCohortGrid } from '@/lib/analytics/finance/cohorts';

export { MAX_COHORT_MONTHS, aliveAt, buildCohortGrid, endedAt, type CohortCell, type CohortGrid, type CohortRow, type CohortSubscription } from '@/lib/analytics/finance/cohort-grid';

/**
 * Load the cohort grid for one currency from the mart.
 *
 * Scoped to a currency so the page stays coherent with the money above it, not
 * because retention is a currency-denominated idea - a CAD reader looking at a
 * grid that silently included US subscribers would draw the wrong conclusion
 * about the numbers beside it.
 */
export async function loadCohortGrid(currency: string, now: Date = new Date(), months?: number) {
  return readCohortGrid(currency, now, months);
}

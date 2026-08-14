// The analytics engine.
//
//   types.ts    shared result types, the Rate helper, edge formatters
//   time.ts     UTC date arithmetic and time bucketing (pure)
//   metrics.ts  customer-facing: applications, funnel, matches, keywords
//   revenue.ts  staff-facing: MRR, churn, LTV, cash, payment health
//   rollups.ts  raw events -> pre-aggregated daily rows, idempotently
//
// Import from here for the common case; import a module directly when you want
// only its pure half and none of its Prisma loaders.

export * from './types';
export * from './time';
export * from './metrics';
export * from './revenue';
export * from './rollups';

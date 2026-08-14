'use client';

import { useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { DateRangePicker, rangeFromPreset, type DateRangePreset } from '@/components/filters';
import type { PeriodKey } from './periods';

/**
 * The reporting-period control.
 *
 * The window lives in the URL rather than in component state, so the numbers
 * are still computed on the server (one round trip, no client-side aggregation)
 * and a bookmarked link reopens the same report. The picker is the only piece
 * of this page that needs to be a client component.
 */
export function PeriodPicker({ value }: { value: PeriodKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function select(preset: DateRangePreset) {
    if (preset === value) return;
    startTransition(() => {
      router.push(`${pathname}?period=${preset}`, { scroll: false });
    });
  }

  return (
    <DateRangePicker
      // `rangeFromPreset` is cheap and the picker only reads `.preset`, so
      // rebuilding it each render costs nothing and keeps one source of truth.
      value={rangeFromPreset(value)}
      onChange={(range) => select(range.preset)}
      label={null}
      disabled={pending}
    />
  );
}

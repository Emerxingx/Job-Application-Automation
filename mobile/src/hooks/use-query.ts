/**
 * One small data hook instead of a query library: fetch, and on a network
 * failure fall back to the offline cache and SAY SO. Every screen that reads
 * uses it, so the offline behaviour is one behaviour, not twelve.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheKey } from '@/api/cache';
import { NetworkError } from '@/api/errors';
import { useSession } from '@/auth/session';

export interface QueryState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  /** The data came from the device cache because the server could not be reached. */
  fromCache: boolean;
  /** When the cached copy was stored, for the banner. */
  storedAt: string | null;
  refresh(): Promise<void>;
}

export function useQuery<T>(path: string, fetcher: () => Promise<T>, query?: Record<string, unknown>, enabled = true): QueryState<T> {
  const { cache, status } = useSession();
  const key = cacheKey(path, query);
  const [state, setState] = useState<Omit<QueryState<T>, 'refresh'>>({ data: null, error: null, loading: true, refreshing: false, fromCache: false, storedAt: null });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (refreshing: boolean) => {
      if (!enabled || status !== 'signed_in') return;
      setState((s) => ({ ...s, loading: !refreshing && s.data === null, refreshing }));
      try {
        const data = await fetcher();
        await cache.write('GET', path, key, data);
        if (alive.current) setState({ data, error: null, loading: false, refreshing: false, fromCache: false, storedAt: null });
      } catch (error) {
        if (error instanceof NetworkError) {
          const cached = await cache.read<T>(key);
          if (cached && alive.current) {
            setState({ data: cached.body, error, loading: false, refreshing: false, fromCache: true, storedAt: cached.storedAt });
            return;
          }
        }
        if (alive.current) setState((s) => ({ ...s, error, loading: false, refreshing: false }));
      }
    },
    // `fetcher` is expected to be stable for a given key; the key is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, enabled, status, cache, path],
  );

  useEffect(() => {
    void run(false);
  }, [run]);

  const refresh = useCallback(() => run(true), [run]);
  return { ...state, refresh };
}

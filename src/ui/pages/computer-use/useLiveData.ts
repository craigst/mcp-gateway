/**
 * Async data hook with manual reload + optional background polling.
 *
 * Unlike `useAsyncData`, a reload keeps the previous snapshot on screen while
 * the next one is in flight, so the fleet grid does not collapse into a
 * spinner every five seconds. Background poll failures are swallowed: the
 * last good snapshot stays visible and an explicit Refresh surfaces the error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../lib/hooks.js';

export interface LiveData<T> {
  data: T | null;
  error: string | null;
  /** True only before the first snapshot arrives. */
  loading: boolean;
  /** True while a manual (or post-action) reload is in flight. */
  refreshing: boolean;
  refresh: () => void;
}

export interface LiveDataOptions {
  /** Background poll interval in ms; `null` disables polling. */
  intervalMs?: number | null;
  /** Skip background ticks while the tab is hidden (default true). */
  pauseWhenHidden?: boolean;
}

export function useLiveData<T>(load: () => Promise<T>, options: LiveDataOptions = {}): LiveData<T> {
  const { intervalMs = null, pauseWhenHidden = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRefreshing(true);
    loadRef.current().then(
      (next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      },
      (loadError: unknown) => {
        if (cancelled) return;
        setError(errorMessage(loadError));
        setLoading(false);
        setRefreshing(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    if (intervalMs === null || intervalMs <= 0) return undefined;
    let disposed = false;

    const poll = (): void => {
      if (disposed) return;
      if (
        pauseWhenHidden &&
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      loadRef.current().then(
        (next) => {
          if (disposed) return;
          setData(next);
          setError(null);
        },
        () => {
          // Keep the last good snapshot; the manual Refresh button reports failures.
        },
      );
    };

    const timer = setInterval(poll, intervalMs);
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') poll();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      disposed = true;
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [intervalMs, pauseWhenHidden]);

  return { data, error, loading, refreshing, refresh };
}

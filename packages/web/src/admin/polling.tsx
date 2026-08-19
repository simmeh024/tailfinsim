import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReactNode } from 'react';

/**
 * Data that refreshes itself, and says how old it is (M1A-09).
 *
 * ## Keeping the last good answer
 *
 * A refresh that blanks the page on a blip is worse than no refresh at all, so a
 * failed attempt leaves `value` exactly as it was and only raises `failed`. The
 * caller renders the stale data *and* says the refresh failed — which is the
 * honest pair. Losing the numbers because one request timed out would turn a
 * momentary network hiccup into an empty console.
 *
 * ## Not polling a tab nobody is looking at
 *
 * A forgotten tab is a request a minute, per admin, for ever. The interval skips
 * a refresh while the tab is hidden, and refreshes once when it becomes visible
 * again — which is also the moment the data is most likely to be stale and most
 * likely to be looked at.
 */

export interface Polled<T> {
  /** The last good value, or null before the first one arrives. */
  value: T | null;
  /** True only before anything has loaded — a refresh failing is not loading. */
  loading: boolean;
  /** The most recent attempt failed. `value` is whatever last succeeded. */
  failed: boolean;
  /** When the last *successful* load finished, as a local epoch millisecond. */
  lastLoadedAt: number | null;
  /** Ask now. What the button calls. */
  refresh: () => void;
}

export function usePolledData<T>(load: () => Promise<T>, intervalMs: number): Polled<T> {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  // Held in a ref so a caller passing an inline closure does not restart the
  // interval on every render — which would mean it never actually fired.
  const loader = useRef(load);
  loader.current = load;
  const mounted = useRef(true);

  const run = useCallback(async () => {
    try {
      const next = await loader.current();
      if (!mounted.current) return;
      setValue(next);
      setLastLoadedAt(Date.now());
      setFailed(false);
    } catch {
      // Deliberately does not touch `value`.
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void run();

    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void run();
    }, intervalMs);

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [run, intervalMs]);

  return {
    value,
    loading: value === null && !failed,
    failed,
    lastLoadedAt,
    refresh: () => void run(),
  };
}

/** "just now" · "40s ago" · "3m ago" · "2h ago". Rounded down; this is a freshness cue. */
export function formatAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

/**
 * How long ago something happened, ticking without a request.
 *
 * Its own component with its own timer, so the second hand re-renders this
 * `<span>` rather than the whole page. The build badge does the same thing for
 * the same reason: anchor to the server once, count locally.
 */
export function Ago({ at }: { at: number | null }): ReactNode {
  const [, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  if (at === null) return null;
  return <>{formatAgo(Date.now() - at)}</>;
}

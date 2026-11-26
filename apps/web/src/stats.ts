import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STATS_MEASURE_PATH,
  STATS_PATH,
  siteStatsPath,
  type SiteStats,
  type StatsOverview,
  type StatsRange,
} from '@lookout/shared';
import { getJson, postJson } from './api.ts';

/** How often a page asks for the stats again: "today" keeps moving while it is open. */
export const OVERVIEW_POLL_MS = 60_000;
export const SITE_STATS_POLL_MS = 30_000;
/** While a measurement runs, the overview is asked for this often, to see it finish. */
export const MEASURING_POLL_MS = 2000;

export interface Loaded<T> {
  value: T | undefined;
  error: string | null;
  /** The HTTP status of the last failure, 0 when Lookout could not be reached. */
  status: number | null;
  refresh: () => void;
}

/**
 * GETs `url` now, again after `delayFor(latest value)` ms each time, and whenever `refresh` is
 * called. A failure keeps the last value and sets `error`; a later success clears it.
 */
export function usePolledJson<T>(
  url: string,
  delayFor: (value: T | undefined) => number,
): Loaded<T> {
  const [state, setState] = useState<{
    url: string;
    value: T | undefined;
    error: string | null;
    status: number | null;
  }>({ url, value: undefined, error: null, status: null });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const delayRef = useRef(delayFor);
  useEffect(() => {
    delayRef.current = delayFor;
  });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: T | undefined;
    const load = () =>
      void getJson<T>(url).then((result) => {
        if (cancelled) return;
        if (result.ok) latest = result.value;
        setState((previous) => {
          // A new URL (another range) starts empty rather than showing the old range's figures.
          const value = previous.url === url ? previous.value : undefined;
          return result.ok
            ? { url, value: result.value, error: null, status: null }
            : { url, value, error: result.message, status: result.status };
        });
        timer = setTimeout(load, delayRef.current(latest));
      });
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, version]);
  const current = state.url === url;
  return {
    value: current ? state.value : undefined,
    error: current ? state.error : null,
    status: current ? state.status : null,
    refresh,
  };
}

/** The stats overview, asked for more often while a measurement is running. */
export function useStatsOverview(): Loaded<StatsOverview> {
  return usePolledJson<StatsOverview>(STATS_PATH, (value) =>
    value?.measure.state === 'measuring' ? MEASURING_POLL_MS : OVERVIEW_POLL_MS,
  );
}

export function useSiteStats(id: string, range: StatsRange): Loaded<SiteStats> {
  return usePolledJson<SiteStats>(siteStatsPath(id, range), () => SITE_STATS_POLL_MS);
}

/** "Measure now": starts sizing every site and Docker's disk usage. Nothing is deleted. */
export async function measureNow(): Promise<string | null> {
  const result = await postJson<StatsOverview['measure']>(STATS_MEASURE_PATH);
  return result.ok ? null : result.message;
}

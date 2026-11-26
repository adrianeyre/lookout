import { useEffect, useMemo, useState } from 'react';
import { CONTAINER_STATS_STREAM_PATH, type ContainerStats } from '@lookout/shared';
import type { StatsById } from './containers.ts';
import { useEventStream } from './live.ts';

/** The current time, updated every `intervalMs`, for "Up 5m" style text. */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * CPU and memory per running Container. The stats stream is open only while a component
 * using this is mounted, so Docker is asked for stats only while someone is looking.
 */
export function useContainerStats(): StatsById {
  const [stats, setStats] = useState<StatsById>(new Map());
  const handlers = useMemo(
    () => ({
      stats: (list: ContainerStats[]) => setStats(new Map(list.map((s) => [s.containerId, s]))),
    }),
    [],
  );
  useEventStream(CONTAINER_STATS_STREAM_PATH, handlers);
  return stats;
}

/**
 * The hero demo's made-up Host and Containers, and their samples over one loop. The names
 * match the screenshot harness's fixtures (apps/web/screenshots/fixtures.ts): a fictional
 * Host, never a real one (PRD WEB-6).
 *
 * Every Container's samples are a function of the tick alone. A healthy Container's are
 * periodic over the loop, so the last frame of one loop is the first of the next and the
 * sparklines run on without a jump. photos-server-1's trouble (CPU climbing, then unhealthy,
 * restarting and recovering) happens at fixed ticks, and the loop holds long enough after it
 * for its trace to leave the sparkline before the seam.
 */

/** The time between samples, as the dashboard's live updates arrive. */
export const TICK_MS = 420;

/** Samples in each sparkline. */
export const SAMPLES = 20;

/** photos-server-1's timeline, in ticks from the start of the loop. */
export const TIMELINE = {
  /** Its CPU and memory start to climb; it still reports healthy. */
  climb: 4,
  /** Its health check fails: unhealthy, so Flagged. */
  unhealthy: 7,
  /** The user confirms Restart: the Container is restarting. */
  restart: 14,
  /** Running again; its health check is starting. */
  running: 18,
  /** Healthy again. */
  healthy: 21,
  /** The loop's last tick: the trouble has scrolled out of every sparkline. */
  end: 21 + SAMPLES,
} as const;

/** The loop's length in ticks, which every healthy series repeats over. */
const PERIOD = TIMELINE.end;

export type Phase = 'healthy' | 'unhealthy' | 'restarting' | 'starting';

export interface DemoContainer {
  id: string;
  name: string;
  image: string;
  project: string;
  /** Null when the image has no health check. */
  health: 'healthy' | null;
  /** The memory limit, in MiB. */
  memoryLimit: number;
  cpu: { base: number; swing: number; phase: number };
  memory: { base: number; swing: number; phase: number };
}

export const STORY_ID = 'photos-server';

export const CONTAINERS: readonly DemoContainer[] = [
  {
    id: 'notes-app',
    name: 'notes-app-1',
    image: 'ghcr.io/example/notes:3.4.1',
    project: 'notes',
    health: 'healthy',
    memoryLimit: 1024,
    cpu: { base: 9, swing: 6, phase: 0.4 },
    memory: { base: 38, swing: 3, phase: 1.1 },
  },
  {
    id: 'notes-db',
    name: 'notes-db-1',
    image: 'postgres:17.6',
    project: 'notes',
    health: 'healthy',
    memoryLimit: 2048,
    cpu: { base: 5, swing: 3, phase: 2.2 },
    memory: { base: 31, swing: 2, phase: 0.2 },
  },
  {
    id: STORY_ID,
    name: 'photos-server-1',
    image: 'ghcr.io/example/photos-server:2.1.0',
    project: 'photos',
    health: 'healthy',
    memoryLimit: 2048,
    cpu: { base: 14, swing: 7, phase: 3.3 },
    memory: { base: 34, swing: 3, phase: 2.6 },
  },
  {
    id: 'photos-redis',
    name: 'photos-redis-1',
    image: 'redis:8.2-alpine',
    project: 'photos',
    health: null,
    memoryLimit: 512,
    cpu: { base: 3, swing: 2, phase: 4.7 },
    memory: { base: 12, swing: 1.5, phase: 5.2 },
  },
];

const STORY = CONTAINERS.find((c) => c.id === STORY_ID)!;

/** A smooth wobble between -1 and 1 that repeats exactly every PERIOD ticks. */
function wobble(tick: number, phase: number): number {
  const t = (2 * Math.PI * tick) / PERIOD;
  return (
    0.55 * Math.sin(2 * t + phase) +
    0.3 * Math.sin(5 * t + phase * 1.7) +
    0.15 * Math.sin(11 * t + phase * 2.3)
  );
}

/** Ticks of the loop, wrapped, so tick -3 is the same sample as tick PERIOD - 3. */
const wrap = (tick: number) => ((tick % PERIOD) + PERIOD) % PERIOD;

/** CPU %, memory % of its limit, or null while it is not running. */
export function sample(
  container: DemoContainer,
  tick: number,
): { cpu: number | null; memory: number | null } {
  const k = wrap(tick);
  const cpu = container.cpu.base + container.cpu.swing * wobble(k, container.cpu.phase);
  const memory = container.memory.base + container.memory.swing * wobble(k, container.memory.phase);
  if (container.id !== STORY_ID) return { cpu, memory };

  const { climb, restart, running, healthy } = TIMELINE;
  if (k >= climb && k < restart) {
    const n = k - climb;
    return {
      cpu: Math.min(97, 32 + n * 13) - (n % 2) * 2,
      memory: Math.min(91, memory + n * 6.5),
    };
  }
  if (k >= restart && k < running) return { cpu: null, memory: null };
  if (k >= running && k < healthy) {
    const n = k - running;
    return { cpu: 46 - n * 11, memory: 18 + n * 5 };
  }
  return { cpu, memory };
}

/** A sparkline's samples, oldest first, ending at `tick`. */
export function series(
  container: DemoContainer,
  tick: number,
  metric: 'cpu' | 'memory',
): (number | null)[] {
  return Array.from(
    { length: SAMPLES },
    (_, i) => sample(container, tick - SAMPLES + 1 + i)[metric],
  );
}

/** The Container's state and health badges for photos-server-1's phase. */
export function status(
  container: DemoContainer,
  phase: Phase,
): { state: 'running' | 'restarting'; health: 'healthy' | 'unhealthy' | 'starting' | null } {
  if (container.id !== STORY_ID) return { state: 'running', health: container.health };
  switch (phase) {
    case 'healthy':
      return { state: 'running', health: 'healthy' };
    case 'unhealthy':
      return { state: 'running', health: 'unhealthy' };
    case 'restarting':
      return { state: 'restarting', health: null };
    case 'starting':
      return { state: 'running', health: 'starting' };
  }
}

/** The header summary's figures at this tick. */
export function summary(
  tick: number,
  phase: Phase,
): { running: number; flagged: number; cpu: number; memory: number; disk: number } {
  const flagged = phase === 'unhealthy' || phase === 'restarting' ? 1 : 0;
  const running = CONTAINERS.length - (phase === 'restarting' ? 1 : 0);
  // The Host's CPU is spread over 4 cores; its memory carries more than the Containers.
  const cpus = CONTAINERS.map((c) => sample(c, tick).cpu ?? 0);
  const cpu = 4 + cpus.reduce((sum, v) => sum + v, 0) / 4;
  const memory = 46 + (sample(STORY, tick).memory ?? 0) / 8;
  return { running, flagged, cpu, memory, disk: 72.4 };
}

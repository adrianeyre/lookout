import {
  CHECK_NOW_MIN_INTERVAL_MS,
  MAX_SITES,
  type ContainersSnapshot,
  type HostedSite,
  type SiteCheck,
  type SitesSettings,
  type SitesSnapshot,
  type TlsThresholds,
} from '@lookout/shared';
import { checkSite, type SiteChecker } from './check.ts';
import { discoverSites, type SiteTarget } from './discovery.ts';

type Listener = (snapshot: SitesSnapshot) => void;
/** Told of every check that ran (never a refused Hosted Site's), for Site Stats' uptime. */
type CheckListener = (siteId: string, check: SiteCheck) => void;

export interface MonitorLogger {
  debug(obj: unknown, msg: string): void;
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

/**
 * The most Hosted Sites Lookout checks. Far more than one Host serves, but it bounds the
 * work a Container with thousands of hosts in its labels could cause (v1.1 security review).
 * LOOKOUT_SITES come first, so no Container can crowd the operator's own out (#104).
 */
export { MAX_SITES };

export interface SiteMonitorOptions {
  /** Hosted Site URLs from LOOKOUT_SITES. */
  urls: string[];
  intervalMs: number;
  timeoutMs: number;
  slowMs: number;
  tls: TlsThresholds;
  /** The Live Window's length: response-time history covers the same span (ADR-0004). */
  liveWindowMs: number;
  log: MonitorLogger;
  checker?: SiteChecker;
  /** Extra trusted certificate authorities (tests only). */
  ca?: string[];
  /** How many checks run at once, so many Hosted Sites don't open many sockets. */
  concurrency?: number;
  /** Changes arriving within this time are sent to the browser as one update. */
  debounceMs?: number;
  now?: () => number;
}

interface SiteState {
  target: SiteTarget;
  site: HostedSite;
  /** The check running now, which "Check now" joins rather than starting another. */
  running: Promise<void> | null;
  /** When "Check now" last ran a check, for its rate limit. */
  lastManual: number | null;
}

export type CheckNowResult =
  | { result: 'checked'; site: HostedSite }
  | { result: 'unknown' }
  | { result: 'limited'; retryAfterMs: number };

/**
 * The Hosted Sites and their latest checks (PRD §14, ADR-0010). Everything is kept in
 * memory: the last check, "up since", "down since" and the response-time history.
 *
 * Hosted Sites only ever come from operator config: LOOKOUT_SITES and Container labels.
 * Nothing a browser sends can add a URL; "Check now" names a Hosted Site by its ID.
 */
export class SiteMonitor {
  readonly #options: Required<Omit<SiteMonitorOptions, 'ca'>> & { ca?: string[] };
  readonly #sites = new Map<string, SiteState>();
  readonly #listeners = new Set<Listener>();
  readonly #checkListeners = new Set<CheckListener>();
  readonly #loggedSkips = new Set<string>();
  readonly settings: SitesSettings;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #broadcast: NodeJS.Timeout | undefined;
  #queue: (() => void)[] = [];
  #active = 0;
  #warnedTooMany = false;
  /** Hosted Sites found but over MAX_SITES, so not checked. */
  #notChecked = 0;

  constructor(options: SiteMonitorOptions) {
    this.#options = {
      checker: checkSite,
      concurrency: 4,
      debounceMs: 50,
      now: Date.now,
      ...options,
    };
    this.settings = {
      checkIntervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs,
      slowMs: options.slowMs,
      tls: options.tls,
      historyCapacity: Math.max(2, Math.ceil(options.liveWindowMs / options.intervalMs)),
    };
    this.#reconcile(discoverSites([], options.urls).sites);
  }

  get snapshot(): SitesSnapshot {
    return {
      settings: this.settings,
      sites: [...this.#sites.values()].map((state) => state.site),
      ...(this.#notChecked > 0 ? { notChecked: this.#notChecked } : {}),
    };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeChecks(listener: CheckListener): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  /**
   * Rediscovers Hosted Sites from the Container list. While Docker is unavailable the
   * last known Container Hosted Sites are kept, rather than dropped and re-added.
   */
  updateContainers(snapshot: ContainersSnapshot): void {
    if (!snapshot.available) return;
    const { sites, skipped } = discoverSites(snapshot.containers, this.#options.urls);
    for (const skip of skipped) {
      const key = `${skip.container}: ${skip.reason}`;
      if (this.#loggedSkips.has(key)) continue;
      if (this.#loggedSkips.size > 1000) this.#loggedSkips.clear();
      this.#loggedSkips.add(key);
      this.#options.log.debug(skip, 'Hosted Site skipped');
    }
    this.#reconcile(sites);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#options.log.info({ count: this.#sites.size }, 'Checking Hosted Sites');
    this.#tick();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#timer);
    clearTimeout(this.#broadcast);
    this.#queue = [];
  }

  /** Waits for every running check; for tests. */
  async settled(): Promise<void> {
    await Promise.all(
      [...this.#sites.values()].flatMap((state) => (state.running ? [state.running] : [])),
    );
  }

  /**
   * "Check now" for one Hosted Site, by ID. An unknown ID makes no request at all. Each
   * Hosted Site can be checked on demand at most once every 5 s.
   */
  async checkNow(id: string): Promise<CheckNowResult> {
    const state = this.#sites.get(id);
    if (!state) return { result: 'unknown' };
    const now = this.#options.now();
    if (state.lastManual !== null) {
      const wait = state.lastManual + CHECK_NOW_MIN_INTERVAL_MS - now;
      if (wait > 0) return { result: 'limited', retryAfterMs: wait };
    }
    state.lastManual = now;
    await this.#check(state, true);
    return { result: 'checked', site: state.site };
  }

  #reconcile(all: SiteTarget[]): void {
    // LOOKOUT_SITES first, then the rest by URL (#104).
    const operator = all.filter((target) => target.sources.includes('env'));
    const labelled = all.filter((target) => !target.sources.includes('env'));
    const targets = [...operator, ...labelled].slice(0, MAX_SITES);
    const notChecked = all.length - targets.length;
    if (notChecked !== this.#notChecked) {
      this.#notChecked = notChecked;
      this.#schedule();
    }
    if (notChecked > 0 && !this.#warnedTooMany) {
      this.#warnedTooMany = true;
      this.#options.log.warn(
        { found: all.length, checked: MAX_SITES },
        'Too many Hosted Sites; checking LOOKOUT_SITES, then the first ones by URL',
      );
    }
    let changed = false;
    const seen = new Set<string>();
    const added: SiteState[] = [];
    for (const target of targets) {
      seen.add(target.id);
      const existing = this.#sites.get(target.id);
      if (existing) {
        if (JSON.stringify(existing.target) !== JSON.stringify(target)) {
          existing.target = target;
          existing.site = { ...existing.site, ...describe(target) };
          changed = true;
        }
        continue;
      }
      const state: SiteState = {
        target,
        site: {
          ...describe(target),
          status: 'pending',
          last: null,
          upSince: null,
          downSince: null,
          history: [],
        },
        running: null,
        lastManual: null,
      };
      this.#sites.set(target.id, state);
      added.push(state);
      changed = true;
    }
    for (const id of [...this.#sites.keys()]) {
      if (!seen.has(id)) {
        this.#sites.delete(id);
        changed = true;
      }
    }
    if (changed) {
      // Keep the map in URL order, so snapshots are stable.
      const ordered = [...this.#sites.entries()].sort(([, a], [, b]) =>
        a.site.url.localeCompare(b.site.url),
      );
      this.#sites.clear();
      for (const [id, state] of ordered) this.#sites.set(id, state);
      this.#schedule();
    }
    // A Hosted Site that appears is checked straight away, not at the next interval.
    if (this.#running) for (const state of added) void this.#check(state, false);
  }

  #tick(): void {
    if (!this.#running) return;
    for (const state of this.#sites.values()) void this.#check(state, false);
    this.#timer = setTimeout(() => this.#tick(), this.#options.intervalMs);
  }

  /** Runs one check, joining a check already running for the same Hosted Site. */
  #check(state: SiteState, manual: boolean): Promise<void> {
    if (state.running) return state.running;
    // A Hosted Site Lookout refuses to check (#103) gets its reason, and no request at all.
    if (state.target.refusal !== null) {
      this.#record(state, {
        timestamp: this.#options.now(),
        status: 'down',
        statusCode: null,
        error: state.target.refusal,
        responseMs: null,
        redirect: null,
        tls: null,
      });
      return Promise.resolve();
    }
    const run = this.#slot(manual).then(async () => {
      try {
        const timestamp = this.#options.now();
        const check = await this.#options
          .checker(state.target.url, {
            timeoutMs: this.#options.timeoutMs,
            slowMs: this.#options.slowMs,
            checkPublic: state.target.checkPublic,
            ...(this.#options.ca ? { ca: this.#options.ca } : {}),
            now: this.#options.now,
          })
          .catch((): SiteCheck => ({
            timestamp,
            status: 'down',
            statusCode: null,
            error: 'Check failed',
            responseMs: null,
            redirect: null,
            tls: null,
          }));
        // The Hosted Site may have gone while it was checked.
        if (this.#sites.get(state.target.id) === state) {
          this.#record(state, check);
          for (const listener of this.#checkListeners) listener(state.target.id, check);
        }
      } finally {
        this.#release();
      }
    });
    state.running = run.finally(() => {
      state.running = null;
    });
    return state.running;
  }

  /** Waits for a free check slot. "Check now" goes to the front of the queue. */
  #slot(manual: boolean): Promise<void> {
    if (this.#active < this.#options.concurrency) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const go = () => {
        this.#active += 1;
        resolve();
      };
      if (manual) this.#queue.unshift(go);
      else this.#queue.push(go);
    });
  }

  #release(): void {
    this.#active -= 1;
    this.#queue.shift()?.();
  }

  #record(state: SiteState, check: SiteCheck): void {
    const previous = state.site;
    const down = check.status === 'down';
    const wasDown = previous.status === 'down';
    const wasUp = previous.status === 'up' || previous.status === 'slow';
    const history = [
      ...previous.history,
      { timestamp: check.timestamp, responseMs: check.responseMs },
    ].slice(-this.settings.historyCapacity);
    state.site = {
      ...previous,
      status: check.status,
      last: check,
      upSince: down ? null : wasUp ? previous.upSince : check.timestamp,
      downSince: down ? (wasDown ? previous.downSince : check.timestamp) : null,
      history,
    };
    this.#schedule();
  }

  #schedule(): void {
    if (this.#broadcast !== undefined) return;
    this.#broadcast = setTimeout(() => {
      this.#broadcast = undefined;
      const snapshot = this.snapshot;
      for (const listener of this.#listeners) listener(snapshot);
    }, this.#options.debounceMs);
  }
}

function describe(target: SiteTarget) {
  return {
    id: target.id,
    url: target.url,
    sources: [...target.sources],
    containerId: target.containerId,
    containerName: target.containerName,
    checkPublic: target.checkPublic,
  };
}

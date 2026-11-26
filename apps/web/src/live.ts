import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_THRESHOLDS,
  LIVE_STREAM_PATH,
  appendToWindow,
  windowPointFrom,
  type LiveEventName,
  type LiveEvents,
  type Thresholds,
} from '@lookout/shared';
import { checkSession } from './api.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

type Handler<E extends LiveEventName> = (data: LiveEvents[E]) => void;

export interface LiveClientOptions {
  url?: string;
  /** Called when the server says the session has expired. */
  onExpired: () => void;
  /** Checks the session; injectable for tests. */
  checkSession?: () => Promise<boolean | null>;
  createEventSource?: (url: string) => EventSource;
  retryMs?: number;
}

const EVENTS: LiveEventName[] = ['settings', 'window', 'host', 'containers', 'sites', 'folders'];

/** EventSource.CLOSED, written out so the module also loads where EventSource is absent. */
const CLOSED = 2;

/**
 * The one live connection the SPA holds open (ADR-0006). EventSource reconnects on its own
 * after a network error; after an HTTP error it gives up, so this checks whether the session
 * has expired (go to login) or the server is still coming back (try again).
 */
export class LiveClient {
  #status: ConnectionStatus = 'connecting';
  #source: EventSource | null = null;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  readonly #options: Required<LiveClientOptions>;
  readonly #statusListeners = new Set<() => void>();
  readonly #handlers = new Map<LiveEventName, Set<Handler<LiveEventName>>>();
  readonly #latest = new Map<LiveEventName, unknown>();

  constructor(options: LiveClientOptions) {
    this.#options = {
      url: LIVE_STREAM_PATH,
      checkSession,
      createEventSource: (url) => new EventSource(url, { withCredentials: true }),
      retryMs: 2000,
      ...options,
    };
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  connect(): void {
    this.#closed = false;
    if (this.#source) return;
    const source = this.#options.createEventSource(this.#options.url);
    this.#source = source;
    source.onopen = () => this.#setStatus('open');
    source.onerror = () => {
      if (this.#status === 'open' || this.#status === 'connecting') this.#setStatus('reconnecting');
      if (source.readyState === CLOSED) {
        source.close();
        this.#source = null;
        void this.#recover();
      }
    };
    for (const name of EVENTS) {
      source.addEventListener(name, (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as LiveEvents[typeof name];
        this.#emit(name, data);
        // The server sends the Live Window once; each later sample extends it here, with
        // the same rule the server uses.
        if (name === 'host') {
          const window = this.latest('window');
          if (window) {
            this.#emit(
              'window',
              appendToWindow(window, windowPointFrom(data as LiveEvents['host'])),
            );
          }
        }
      });
    }
  }

  #emit<E extends LiveEventName>(name: E, data: LiveEvents[E]): void {
    this.#latest.set(name, data);
    this.#handlers.get(name)?.forEach((handler) => handler(data));
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#retry);
    this.#source?.close();
    this.#source = null;
  }

  latest<E extends LiveEventName>(name: E): LiveEvents[E] | undefined {
    return this.#latest.get(name) as LiveEvents[E] | undefined;
  }

  on<E extends LiveEventName>(name: E, handler: Handler<E>): () => void {
    const handlers = this.#handlers.get(name) ?? new Set();
    handlers.add(handler as Handler<LiveEventName>);
    this.#handlers.set(name, handlers);
    return () => handlers.delete(handler as Handler<LiveEventName>);
  }

  onStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async #recover(): Promise<void> {
    const session = await this.#options.checkSession();
    if (this.#closed) return;
    if (session === false) {
      this.close();
      this.#options.onExpired();
      return;
    }
    this.#retry = setTimeout(() => this.connect(), this.#options.retryMs);
  }

  #setStatus(status: ConnectionStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#statusListeners.forEach((listener) => listener());
  }
}

export const LiveContext = createContext<LiveClient | null>(null);

function useLiveClient(): LiveClient {
  const client = useContext(LiveContext);
  if (!client) throw new Error('useLiveClient needs a LiveContext provider');
  return client;
}

export function useConnectionStatus(): ConnectionStatus {
  const client = useLiveClient();
  return useSyncExternalStore(
    (listener) => client.onStatus(listener),
    () => client.status,
  );
}

/** The latest value of a live event, updating as new ones arrive. */
export function useLiveEvent<E extends LiveEventName>(name: E): LiveEvents[E] | undefined {
  const client = useLiveClient();
  const subscribe = useCallback(
    (listener: () => void) => client.on(name, listener),
    [client, name],
  );
  return useSyncExternalStore(subscribe, () => client.latest(name));
}

/** The amber and red thresholds from the server's settings, or the defaults until they arrive. */
export function useThresholds(): Thresholds {
  const client = useContext(LiveContext);
  const subscribe = useCallback(
    (listener: () => void) => client?.on('settings', listener) ?? (() => undefined),
    [client],
  );
  const settings = useSyncExternalStore(subscribe, () => client?.latest('settings'));
  return settings?.thresholds ?? DEFAULT_THRESHOLDS;
}

export interface StreamHandlers {
  [event: string]: (data: never) => void;
}

/** Creates EventSources; replaced in tests. */
export const EventSourceContext = createContext<(url: string) => EventSource>(
  (url) => new EventSource(url, { withCredentials: true }),
);

/**
 * Holds a page-scoped SSE stream (Container stats, a log tail) open while the component is
 * mounted, and closes it, ending the server's Docker stream too, on unmount or URL change.
 * `handlers` should be stable (memoised): a new object reopens the stream.
 */
export function useEventStream(
  url: string | null,
  handlers: StreamHandlers,
  onError?: (source: EventSource) => void,
): void {
  const create = useContext(EventSourceContext);
  useEffect(() => {
    if (url === null) return;
    const source = create(url);
    for (const [name, handler] of Object.entries(handlers)) {
      source.addEventListener(name, (event) => {
        handler(JSON.parse((event as MessageEvent<string>).data) as never);
      });
    }
    if (onError) source.onerror = () => onError(source);
    return () => source.close();
  }, [create, url, handlers, onError]);
}

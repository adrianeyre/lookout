import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveClient } from './live.ts';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState: number = CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  open() {
    this.readyState = OPEN;
    this.onopen?.();
  }

  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }

  /** A dropped connection the browser will retry by itself. */
  drop() {
    this.readyState = CONNECTING;
    this.onerror?.();
  }

  /** An HTTP error response: EventSource gives up. */
  fail() {
    this.readyState = CLOSED;
    this.onerror?.();
  }

  close() {
    this.closed = true;
    this.readyState = CLOSED;
  }
}

function makeClient(session: boolean | null) {
  const onExpired = vi.fn();
  const checkSession = vi.fn(() => Promise.resolve(session));
  const client = new LiveClient({
    onExpired,
    checkSession,
    createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    retryMs: 1000,
  });
  return { client, onExpired, checkSession };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveClient', () => {
  it('connects to the live stream and delivers host samples', () => {
    const { client } = makeClient(true);
    const received: unknown[] = [];
    client.on('host', (sample) => received.push(sample));
    client.connect();
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/stream');
    source.open();
    expect(client.status).toBe('open');
    source.emit('host', { timestamp: 1 });
    expect(received).toEqual([{ timestamp: 1 }]);
    expect(client.latest('host')).toEqual({ timestamp: 1 });
  });

  it('shows reconnecting while the browser retries, and recovers when it reopens', () => {
    const { client } = makeClient(true);
    const statuses: string[] = [];
    client.onStatus(() => statuses.push(client.status));
    client.connect();
    const source = FakeEventSource.instances[0]!;
    source.open();
    source.drop();
    expect(client.status).toBe('reconnecting');
    source.open();
    expect(statuses).toEqual(['open', 'reconnecting', 'open']);
  });

  it('reconnects itself after an HTTP error while the session is still valid', async () => {
    const { client, onExpired } = makeClient(true);
    client.connect();
    FakeEventSource.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('keeps retrying while the server is unreachable', async () => {
    const { client, onExpired } = makeClient(null);
    client.connect();
    FakeEventSource.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('goes to login when the session has expired', async () => {
    const { client, onExpired } = makeClient(false);
    client.connect();
    FakeEventSource.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('can reconnect after close, as React StrictMode does', () => {
    const { client } = makeClient(true);
    client.connect();
    client.close();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    client.connect();
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

describe('LiveClient Live Window', () => {
  const sample = (timestamp: number, cpu: number) => ({
    timestamp,
    overview: { hostname: 'h', os: 'o', kernel: 'k', uptimeSeconds: 1 },
    cpu: { usagePercent: cpu, perCore: [], load: { one: 0, five: 0, fifteen: 0 } },
    memory: { totalBytes: 1, availableBytes: 1, usedBytes: 0, usagePercent: 0, swap: null },
    disks: [],
    diskIo: [],
    network: [],
  });

  it('starts from the server window and extends it with each sample, up to capacity', () => {
    const { client } = makeClient(true);
    client.connect();
    const source = FakeEventSource.instances[0]!;
    source.open();
    source.emit('window', {
      capacity: 2,
      sampleIntervalMs: 2000,
      points: [{ ...windowPoint(1), cpuPercent: 10 }],
    });
    source.emit('host', sample(2, 20));
    source.emit('host', sample(3, 30));
    expect(client.latest('window')!.points.map((p) => p.cpuPercent)).toEqual([20, 30]);
  });

  it('replaces the window when the stream reconnects', () => {
    const { client } = makeClient(true);
    client.connect();
    const source = FakeEventSource.instances[0]!;
    source.emit('window', { capacity: 5, sampleIntervalMs: 2000, points: [windowPoint(1)] });
    source.emit('host', sample(2, 20));
    source.emit('window', { capacity: 5, sampleIntervalMs: 2000, points: [] });
    expect(client.latest('window')!.points).toEqual([]);
  });
});

function windowPoint(timestamp: number) {
  return {
    timestamp,
    cpuPercent: null,
    memoryPercent: 0,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    networkRxBytesPerSecond: 0,
    networkTxBytesPerSecond: 0,
  };
}

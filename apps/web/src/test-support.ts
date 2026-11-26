import type { ContainerSummary } from '@lookout/shared';

export function summary(overrides: Partial<ContainerSummary> & { id: string }): ContainerSummary {
  return {
    name: overrides.id,
    image: 'example:1',
    state: 'running',
    health: null,
    composeProject: null,
    createdAt: 0,
    startedAt: Date.now() - 3_600_000,
    finishedAt: null,
    exitCode: 0,
    ports: [],
    labels: {},
    maskedLabels: [],
    ...overrides,
  };
}

/** A controllable EventSource for components that open page-scoped streams. */
export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

/** A Hosted Site for tests, up unless overridden. */
export function hostedSite(
  overrides: Partial<import('@lookout/shared').HostedSite> & { url: string },
  /** The clock its times are relative to. Pass the test's own, so "Down for 5m" is exact. */
  now = Date.now(),
): import('@lookout/shared').HostedSite {
  const status = overrides.status ?? 'up';
  return {
    id: overrides.url.replace(/\W/g, '').slice(0, 16).padEnd(16, '0'),
    sources: ['env'],
    containerId: null,
    containerName: null,
    checkPublic: false,
    status,
    last:
      status === 'pending'
        ? null
        : {
            timestamp: now,
            status,
            statusCode: status === 'down' ? 503 : 200,
            error: null,
            responseMs: status === 'slow' ? 2500 : 120,
            redirect: null,
            tls: null,
          },
    upSince: status === 'down' ? null : now - 3_600_000,
    downSince: status === 'down' ? now - 5 * 60_000 : null,
    history: [],
    ...overrides,
  };
}

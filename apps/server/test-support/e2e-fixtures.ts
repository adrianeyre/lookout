import type { LogLine } from '@lookout/shared';
import type { InspectedContainer } from '../src/docker/parse.ts';
import { makeContainer } from './fake-docker.ts';

const HOUR = 3_600_000;

/** The Containers the Playwright server starts with: every state, two Compose Projects. */
export function fixtureContainers(
  now = Date.now(),
  /** The fake Hosted Site shop-web-1 serves, by its lookout.url label. */
  siteUrl = 'http://store.example/',
): InspectedContainer[] {
  const compose = (project: string) => ({ 'com.docker.compose.project': project });
  return [
    makeContainer({
      id: 'c0ffee000001',
      name: 'shop-web-1',
      image: 'nginx:1.29',
      composeProject: 'shop',
      labels: { ...compose('shop'), 'lookout.url': siteUrl },
      health: 'healthy',
      startedAt: now - 3 * HOUR,
      // It publishes the port its lookout.url names, as a Container serving that site would;
      // a label URL on a port its Container does not publish is never checked (#103).
      ports: [
        {
          privatePort: 80,
          publicPort: Number(new URL(siteUrl).port) || 8080,
          protocol: 'tcp',
          ip: '0.0.0.0',
        },
      ],
      env: [
        { name: 'NGINX_HOST', value: 'shop.example' },
        { name: 'API_TOKEN', value: 'tok-e2e-secret' },
      ],
      mounts: [
        {
          type: 'bind',
          source: '/srv/shop/html',
          destination: '/usr/share/nginx/html',
          readOnly: true,
        },
      ],
      networks: [
        { name: 'shop_default', ipAddress: '172.18.0.2', ipv6Address: null, gateway: '172.18.0.1' },
      ],
      restartPolicy: 'unless-stopped',
      command: ['nginx', '-g', 'daemon off;'],
      entrypoint: ['/docker-entrypoint.sh'],
    }),
    makeContainer({
      id: 'c0ffee000002',
      name: 'shop-db-1',
      image: 'postgres:17',
      composeProject: 'shop',
      labels: compose('shop'),
      health: 'unhealthy',
      startedAt: now - 2 * HOUR,
    }),
    makeContainer({
      id: 'c0ffee000003',
      name: 'shop-worker-1',
      image: 'shop/worker:2.1',
      composeProject: 'shop',
      labels: compose('shop'),
      state: 'restarting',
      exitCode: 1,
      startedAt: now - 60_000,
      restartCount: 7,
    }),
    makeContainer({
      id: 'c0ffee000004',
      name: 'blog-ghost-1',
      image: 'ghost:6',
      composeProject: 'blog',
      labels: compose('blog'),
      state: 'paused',
      startedAt: now - 24 * HOUR,
    }),
    makeContainer({
      id: 'c0ffee000005',
      name: 'migrate',
      image: 'shop/migrate:2.1',
      state: 'exited',
      exitCode: 1,
      startedAt: now - 2 * HOUR,
      finishedAt: now - HOUR,
    }),
    makeContainer({
      id: 'c0ffee000006',
      name: 'backup',
      image: 'restic/restic:0.18',
      state: 'exited',
      exitCode: 0,
      startedAt: now - 5 * HOUR,
      finishedAt: now - 4 * HOUR,
    }),
    makeContainer({ id: 'c0ffee000007', name: 'fresh', image: 'busybox:1.37', state: 'created' }),
    makeContainer({
      id: 'c0ffee000008',
      name: 'zombie',
      image: 'busybox:1.37',
      state: 'dead',
      exitCode: 137,
      startedAt: now - 10 * HOUR,
      finishedAt: now - 9 * HOUR,
    }),
  ];
}

export const FIXTURE_LOGS: { id: string; line: LogLine }[] = [
  {
    id: 'c0ffee000001',
    line: {
      stream: 'stdout',
      timestamp: Date.parse('2026-11-25T08:00:00Z'),
      text: 'nginx: ready for start up',
    },
  },
  {
    id: 'c0ffee000001',
    line: {
      stream: 'stderr',
      timestamp: Date.parse('2026-11-25T08:00:01Z'),
      text: 'nginx: [warn] conflicting server name',
    },
  },
  {
    id: 'c0ffee000001',
    line: { stream: 'stdout', timestamp: Date.parse('2026-11-25T08:00:02Z'), text: 'GET / 200' },
  },
];

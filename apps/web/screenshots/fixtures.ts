/**
 * A fictional Host and its Containers for the screenshot harness (PRD WEB-6). Everything
 * here is made up and fixed, so screenshots change only when the UI does. Nothing is read
 * from Docker or a real Host.
 */
import type {
  ContainerDetail,
  ContainersSnapshot,
  ContainerStats,
  ContainerSummary,
  HostSample,
  LiveSettings,
  LiveWindowSnapshot,
  FolderScan,
  HostedSite,
  LogLine,
  SitesSnapshot,
  TlsCertificate,
  WindowPoint,
} from '@lookout/shared';

/** The moment every screenshot is taken at. */
export const NOW = Date.parse('2026-11-25T14:30:00Z');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const SAMPLE_MS = 2000;

export const SETTINGS: LiveSettings = {
  thresholds: { warnPercent: 80, criticalPercent: 90 },
  sampleIntervalMs: SAMPLE_MS,
  liveWindowMinutes: 15,
};

/** A smooth, repeatable wobble: no randomness, so every run draws the same lines. */
const wave = (i: number, base: number, amplitude: number, period: number, phase = 0) =>
  base +
  amplitude * Math.sin((i / period) * 2 * Math.PI + phase) +
  (amplitude / 3) * Math.sin((i / (period / 3.7)) * 2 * Math.PI + phase * 2);

const POINTS = 450;

export const WINDOW: LiveWindowSnapshot = {
  capacity: POINTS,
  sampleIntervalMs: SAMPLE_MS,
  points: Array.from({ length: POINTS }, (_, i): WindowPoint => {
    const spike = i > 300 && i < 330 ? 28 * Math.sin(((i - 300) / 30) * Math.PI) : 0;
    return {
      timestamp: NOW - (POINTS - 1 - i) * SAMPLE_MS,
      cpuPercent: Math.max(2, wave(i, 18, 7, 90) + spike),
      memoryPercent: wave(i, 61, 1.5, 300, 1),
      diskReadBytesPerSecond: Math.max(0, wave(i, 2.5 * MiB, 2 * MiB, 60, 2)),
      diskWriteBytesPerSecond: Math.max(0, wave(i, 4 * MiB, 3 * MiB, 75)),
      networkRxBytesPerSecond: Math.max(0, wave(i, 1.4 * MiB, 0.9 * MiB, 50, 0.5)),
      networkTxBytesPerSecond: Math.max(0, wave(i, 380 * 1024, 220 * 1024, 65, 1.5)),
    };
  }),
};

export const HOST: HostSample = {
  timestamp: NOW,
  overview: {
    hostname: 'lighthouse',
    os: 'Debian GNU/Linux 13 (trixie)',
    kernel: '6.12.48+deb13-amd64',
    uptimeSeconds: 23 * 86_400 + 4 * 3600 + 17 * 60,
  },
  cpu: {
    usagePercent: 21.4,
    perCore: [34.2, 12.8, 27.5, 11.1],
    load: { one: 0.86, five: 0.71, fifteen: 0.64 },
  },
  memory: {
    totalBytes: 16 * GiB,
    availableBytes: 6.2 * GiB,
    usedBytes: 9.8 * GiB,
    usagePercent: 61.3,
    swap: { totalBytes: 2 * GiB, usedBytes: 0.3 * GiB, usagePercent: 15 },
  },
  disks: [
    {
      mountPoint: '/',
      device: '/dev/nvme0n1p2',
      fsType: 'ext4',
      totalBytes: 468 * GiB,
      usedBytes: 196 * GiB,
      freeBytes: 248 * GiB,
      usagePercent: 44.1,
    },
    {
      mountPoint: '/boot/efi',
      device: '/dev/nvme0n1p1',
      fsType: 'vfat',
      totalBytes: 0.5 * GiB,
      usedBytes: 0.03 * GiB,
      freeBytes: 0.47 * GiB,
      usagePercent: 6,
    },
    {
      mountPoint: '/srv/media',
      device: '/dev/sda1',
      fsType: 'ext4',
      totalBytes: 3600 * GiB,
      usedBytes: 3010 * GiB,
      freeBytes: 407 * GiB,
      usagePercent: 88.1,
    },
  ],
  diskIo: [
    { device: 'nvme0n1', readBytesPerSecond: 1.8 * MiB, writeBytesPerSecond: 4.6 * MiB },
    { device: 'sda', readBytesPerSecond: 0.6 * MiB, writeBytesPerSecond: 0 },
  ],
  network: [
    { name: 'enp3s0', virtual: false, rxBytesPerSecond: 1.2 * MiB, txBytesPerSecond: 410 * 1024 },
    { name: 'tailscale0', virtual: false, rxBytesPerSecond: 18 * 1024, txBytesPerSecond: 9 * 1024 },
    { name: 'docker0', virtual: false, rxBytesPerSecond: 0, txBytesPerSecond: 0 },
    { name: 'lo', virtual: true, rxBytesPerSecond: 52 * 1024, txBytesPerSecond: 52 * 1024 },
  ],
};

const compose = (project: string, service: string) => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
});

function container(
  overrides: Partial<ContainerSummary> & Pick<ContainerSummary, 'id' | 'name' | 'image'>,
): ContainerSummary {
  return {
    state: 'running',
    health: null,
    composeProject: null,
    createdAt: NOW - 30 * 24 * HOUR,
    startedAt: NOW - 6 * 24 * HOUR,
    finishedAt: null,
    exitCode: 0,
    ports: [],
    labels: {},
    maskedLabels: [],
    ...overrides,
  };
}

export const CONTAINERS: ContainerSummary[] = [
  container({
    id: '4f1c2a9b7e30',
    name: 'notes-app-1',
    image: 'ghcr.io/example/notes:3.4.1',
    composeProject: 'notes',
    labels: compose('notes', 'app'),
    health: 'healthy',
    startedAt: NOW - 2 * 24 * HOUR - 5 * HOUR,
    ports: [{ privatePort: 3000, publicPort: 3000, protocol: 'tcp', ip: '0.0.0.0' }],
  }),
  container({
    id: '8d0e6b1f2c44',
    name: 'notes-db-1',
    image: 'postgres:17.6',
    composeProject: 'notes',
    labels: compose('notes', 'db'),
    health: 'healthy',
  }),
  container({
    id: '2b7a9c0d5e18',
    name: 'notes-search-1',
    image: 'getmeili/meilisearch:v1.24',
    composeProject: 'notes',
    labels: compose('notes', 'search'),
    health: 'unhealthy',
    startedAt: NOW - 40 * MINUTE,
  }),
  container({
    id: 'a3c5e7f90b12',
    name: 'photos-server-1',
    image: 'ghcr.io/example/photos-server:2.1.0',
    composeProject: 'photos',
    labels: compose('photos', 'server'),
    health: 'healthy',
    startedAt: NOW - 6 * 24 * HOUR,
    ports: [{ privatePort: 2283, publicPort: 2283, protocol: 'tcp', ip: '0.0.0.0' }],
  }),
  container({
    id: 'c9d1e3f50a77',
    name: 'photos-ml-1',
    image: 'ghcr.io/example/photos-ml:2.1.0',
    composeProject: 'photos',
    labels: compose('photos', 'ml'),
    state: 'restarting',
    exitCode: 137,
    startedAt: NOW - 20_000,
  }),
  container({
    id: 'e1f2a3b4c5d6',
    name: 'photos-redis-1',
    image: 'redis:8.2-alpine',
    composeProject: 'photos',
    labels: compose('photos', 'redis'),
  }),
  container({
    id: 'f0e1d2c3b4a5',
    name: 'lookout',
    image: 'ghcr.io/adrianeyre/lookout:1',
    labels: { 'lookout.self': 'true' },
    startedAt: NOW - 6 * 24 * HOUR,
  }),
  container({
    id: '0a1b2c3d4e5f',
    name: 'backup-nightly',
    image: 'restic/restic:0.18.1',
    state: 'exited',
    exitCode: 0,
    startedAt: NOW - 11 * HOUR,
    finishedAt: NOW - 10 * HOUR - 48 * MINUTE,
  }),
  container({
    id: '5e6f7a8b9c0d',
    name: 'certbot-renew',
    image: 'certbot/certbot:v5.1',
    state: 'exited',
    exitCode: 1,
    startedAt: NOW - 3 * HOUR,
    finishedAt: NOW - 3 * HOUR + 14_000,
  }),
];

export const SNAPSHOT: ContainersSnapshot = { available: true, containers: CONTAINERS };

export const STATS: ContainerStats[] = [
  ['4f1c2a9b7e30', 3.2, 182 * MiB, 1024 * MiB],
  ['8d0e6b1f2c44', 1.1, 96 * MiB, 0],
  ['2b7a9c0d5e18', 0.4, 640 * MiB, 0],
  ['a3c5e7f90b12', 6.8, 412 * MiB, 0],
  ['c9d1e3f50a77', 0, 0, 0],
  ['e1f2a3b4c5d6', 0.3, 12 * MiB, 0],
  ['f0e1d2c3b4a5', 0.6, 54 * MiB, 0],
].map(([containerId, cpuPercent, memoryUsedBytes, memoryLimitBytes]) => ({
  containerId: containerId as string,
  cpuPercent: cpuPercent as number,
  memoryUsedBytes: memoryUsedBytes as number,
  memoryLimitBytes: memoryLimitBytes as number,
}));

/** The Container the detail screenshots show. */
export const DETAIL_ID = '4f1c2a9b7e30';

export const DETAIL: ContainerDetail = {
  ...CONTAINERS[0]!,
  imageId: 'sha256:9c4e0f3b2a1d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f',
  imageDigest:
    'ghcr.io/example/notes@sha256:1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b',
  command: ['node', 'server.js'],
  entrypoint: ['docker-entrypoint.sh'],
  envNames: ['NODE_ENV', 'PORT', 'DATABASE_URL', 'SEARCH_URL', 'SESSION_SECRET'],
  masked: { command: [], entrypoint: [], mounts: [] },
  mounts: [
    { type: 'volume', source: 'notes_uploads', destination: '/app/uploads', readOnly: false },
    { type: 'bind', source: '/srv/notes/config', destination: '/app/config', readOnly: true },
  ],
  networks: [
    { name: 'notes_default', ipAddress: '172.20.0.3', ipv6Address: null, gateway: '172.20.0.1' },
  ],
  restartPolicy: 'unless-stopped',
  restartCount: 0,
};

const LOG_TEXT: [stream: LogLine['stream'], text: string][] = [
  ['stdout', '> notes@3.4.1 start'],
  ['stdout', '> node server.js'],
  ['stdout', '[info] config loaded from /app/config/notes.yaml'],
  ['stdout', '[info] connected to postgres at db:5432 (pool size 10)'],
  ['stdout', '[info] migrations up to date (42 applied)'],
  ['stdout', '[info] listening on http://0.0.0.0:3000'],
  ['stdout', 'GET /api/notes?limit=50 200 18ms'],
  ['stdout', 'GET /api/notes/7f3a 200 6ms'],
  ['stdout', 'PUT /api/notes/7f3a 204 23ms'],
  ['stderr', '[warn] search index request failed: connect ECONNREFUSED 172.20.0.4:7700'],
  ['stdout', '[info] retrying search index in 5s'],
  ['stdout', 'GET /api/notes?limit=50 200 15ms'],
  ['stderr', '[warn] search index request failed: connect ECONNREFUSED 172.20.0.4:7700'],
  ['stdout', 'POST /api/notes 201 31ms'],
  ['stdout', 'GET /healthz 200 1ms'],
  ['stdout', 'GET /api/tags 200 4ms'],
  ['stdout', '[info] retrying search index in 10s'],
  ['stdout', 'GET /api/notes/91bc 200 7ms'],
  ['stderr', '[warn] search index request failed: connect ECONNREFUSED 172.20.0.4:7700'],
  ['stdout', 'GET /healthz 200 1ms'],
  ['stdout', '[info] search index reachable again; reindexing 3 notes'],
  ['stdout', 'GET /api/notes?limit=50 200 14ms'],
];

export const LOGS: LogLine[] = LOG_TEXT.map(([stream, text], i) => ({
  stream,
  text,
  timestamp: NOW - (LOG_TEXT.length - i) * 7_000,
}));

/** What the log search box holds in the logs screenshot. */
export const LOG_SEARCH = 'search index';

const DAY = 24 * 60 * 60 * 1000;

/** A certificate from a made-up authority, expiring in `days`. */
const cert = (subject: string, days: number): TlsCertificate => ({
  subject,
  issuer: 'Example Trust CA',
  validTo: NOW + days * DAY,
  hostnameMatches: true,
  trusted: true,
  error: null,
});

/** A fixed, made-up response-time history, one point a minute over the Live Window. */
const history = (base: number, down = false): HostedSite['history'] =>
  Array.from({ length: 15 }, (_, i) => ({
    timestamp: NOW - (14 - i) * 60_000,
    responseMs: down && i >= 11 ? null : base + ((i * 37) % 23),
  }));

/** Hosted Sites for the Websites page: one Flagged (down), one slow with a certificate at amber. */
export const SITES: SitesSnapshot = {
  settings: {
    checkIntervalMs: 60_000,
    timeoutMs: 10_000,
    slowMs: 2000,
    tls: { warnDays: 14, criticalDays: 7 },
    historyCapacity: 15,
  },
  sites: [
    {
      id: 'notesexamplenet',
      url: 'https://notes.example.net/',
      sources: ['traefik'],
      containerId: '4f1c2a9b7e30',
      containerName: 'notes-app-1',
      checkPublic: false,
      status: 'up',
      last: {
        timestamp: NOW - 20_000,
        status: 'up',
        statusCode: 200,
        error: null,
        responseMs: 84,
        redirect: null,
        tls: cert('notes.example.net', 61),
      },
      upSince: NOW - 2 * DAY - 5 * HOUR,
      downSince: null,
      history: history(70),
    },
    {
      id: 'searchexamplene',
      url: 'https://search.example.net/',
      sources: ['traefik'],
      containerId: '2b7a9c0d5e18',
      containerName: 'notes-search-1',
      checkPublic: false,
      status: 'down',
      last: {
        timestamp: NOW - 20_000,
        status: 'down',
        statusCode: 503,
        error: null,
        responseMs: 12,
        redirect: null,
        tls: cert('search.example.net', 61),
      },
      upSince: null,
      downSince: NOW - 4 * 60_000,
      history: history(95, true),
    },
    {
      id: 'photosexamplene',
      url: 'https://photos.example.net/',
      sources: ['traefik'],
      containerId: 'a3c5e7f90b12',
      containerName: 'photos-server-1',
      checkPublic: false,
      status: 'slow',
      last: {
        timestamp: NOW - 20_000,
        status: 'slow',
        statusCode: 200,
        error: null,
        responseMs: 2340,
        redirect: null,
        tls: cert('photos.example.net', 11),
      },
      upSince: NOW - 9 * DAY,
      downSince: null,
      history: history(2200),
    },
    {
      id: 'http19216801080',
      url: 'http://192.168.1.10:8080/',
      sources: ['env'],
      containerId: null,
      containerName: null,
      checkPublic: false,
      status: 'up',
      last: {
        timestamp: NOW - 20_000,
        status: 'up',
        statusCode: 302,
        error: null,
        responseMs: 6,
        redirect: '/login',
        tls: null,
      },
      upSince: NOW - 23 * DAY,
      downSince: null,
      history: history(5),
    },
  ],
};

const ROOT_DISK = 468 * GiB;
const MEDIA_DISK = 3.52 * 1024 * GiB;

/** The Host's largest folders, from a scan that finished 2 hours ago. */
export const FOLDERS: FolderScan = {
  state: 'done',
  folders: [
    ['/srv/media/films', 1.21 * 1024 * GiB, '/srv/media', MEDIA_DISK],
    ['/srv/media/photos', 820 * GiB, '/srv/media', MEDIA_DISK],
    ['/srv/media/music', 410 * GiB, '/srv/media', MEDIA_DISK],
    ['/var/lib/docker/overlay2', 38.4 * GiB, '/', ROOT_DISK],
    ['/var/lib/docker/volumes/photos_library', 24.1 * GiB, '/', ROOT_DISK],
    ['/home/sam/backups', 19.6 * GiB, '/', ROOT_DISK],
    ['/var/lib/docker/volumes/notes_db', 6.2 * GiB, '/', ROOT_DISK],
    ['/var/log/journal', 3.9 * GiB, '/', ROOT_DISK],
    ['/opt/llama/models', 3.6 * GiB, '/', ROOT_DISK],
    ['/home/sam/downloads', 2.8 * GiB, '/', ROOT_DISK],
  ].map(([path, bytes, mountPoint, diskBytes]) => ({
    path: path as string,
    bytes: bytes as number,
    mountPoint: mountPoint as string,
    diskBytes: diskBytes as number,
    percentOfDisk: ((bytes as number) / (diskBytes as number)) * 100,
  })),
  startedAt: NOW - 2 * HOUR - 4 * 60_000,
  finishedAt: NOW - 2 * HOUR,
  walked: 184_212,
  unreadable: 0,
  partial: false,
  error: null,
  nextAt: NOW + 4 * HOUR,
};

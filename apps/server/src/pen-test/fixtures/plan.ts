/**
 * The pen-test fixtures (E2, docs/pen-test/fixtures.md) as a pure plan: data only, no Docker.
 * `loader.ts` applies it to the deployment's throwaway daemon (`pnpm pen-test:seed`), and
 * `plan.test.ts` checks it. Every value that looks like a secret is made up and carries
 * FAKE_MARKER, so a probe can grep any response or log for it.
 */

/** Every made-up secret contains this, and nothing real ever does. */
export const FAKE_MARKER = 'PEN-TEST-FAKE';

/** The label every fixture Container carries, with its handle as the value. */
export const FIXTURE_LABEL = 'lookout.pen-test.fixture';

/** The fixtures' Image, built from pen-test/fixture-image and loaded into the daemon. */
export const FIXTURE_IMAGE = 'lookout-pen-test-fixture:local';

/** The deployment's address on its internal network, where Lookout listens. */
export const HOST_IP = '172.30.213.2';

/**
 * The loopback port the socket proxy listened on until #101 moved it to a Unix socket: the
 * fixtures still aim checks and redirects here, and the probes check nothing answers.
 */
export const PROXY_PORT = 2375;

export type FixtureState = 'running' | 'exited' | 'created' | 'unhealthy';

export interface FixtureContainer {
  /** A stable name for probes and fixtures.md. */
  handle: string;
  /** Docker's Container name. */
  name: string;
  purpose: string;
  /** Arguments to the fixture Image's entrypoint (fixture.mjs): its mode, then anything. */
  command: string[];
  /** Replaces the Image's entrypoint; only the Container that must fail to start sets it. */
  entrypoint?: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Published on the deployment's loopback, where Hosted Site checks connect. */
  ports: { hostPort: number; containerPort: number }[];
  /** Bind mounts, sources inside the throwaway daemon's filesystem. */
  mounts: { source: string; target: string }[];
  /** The state the loader leaves it in. */
  state: FixtureState;
  /** Set when it belongs to a fixture Compose Project. */
  composeProject?: string;
  /** Values in it that look like secrets; every one contains FAKE_MARKER. */
  secrets: string[];
}

/** A Container the shipped Compose files start, which the plan only checks is there. */
export interface ShippedContainer {
  handle: string;
  name: string;
  purpose: string;
  /** Which shipped configuration starts it. */
  configurations: ('default' | 'socket-proxy')[];
  labels: Record<string, string>;
}

/** A Hosted Site the fixtures serve inside the deployment. */
export interface FixtureSite {
  handle: string;
  url: string;
  /** The fixture Container that serves it. */
  servedBy: string;
  expect: string;
}

/** A value too big to create by default: X1 generates it on demand, by these sizes. */
export interface OversizedValue {
  handle: string;
  where: 'label' | 'environment' | 'log line without a newline' | 'log frame header';
  bytes: number;
  purpose: string;
}

export interface PenTestPlan {
  shipped: ShippedContainer[];
  containers: FixtureContainer[];
  sites: FixtureSite[];
  /** Copied to the daemon's filesystem and mounted as Lookout's Host root. */
  hostRoot: { source: string; target: string };
  /** Generated per deployment by `pnpm pen-test:up` (credentials-package.md), never here. */
  password: 'generated per deployment';
  oversized: OversizedValue[];
}

const fake = (what: string) => `${FAKE_MARKER}-${what}`;
const KIB = 1024;
const MIB = 1024 * KIB;

const victimSecrets = {
  env: {
    DATABASE_URL: `postgres://app:${fake('db-password')}@db.internal:5432/app`,
    API_TOKEN: fake('api-token-7f3a9c'),
    AWS_SECRET_ACCESS_KEY: fake('aws-secret-key-wJalrXUtnFEMI'),
  },
  command: ['--requirepass', fake('redis-requirepass')],
  labels: {
    // A Traefik basic-auth user list: the hash is made up and matches no password.
    'traefik.http.middlewares.victim-auth.basicauth.users': `admin:$apr1$${fake('salt')}$${fake('hash')}`,
    'com.example.backup.url': `s3://backups:${fake('backup-key')}@bucket.internal/victim`,
  },
  mountSource: `/srv/${fake('mount-token')}/data`,
};

const hostileMarkup = '<img src=x onerror="alert(document.domain)">';
const hostileEscapes = '\u001b[31mred\u001b[0m\u001b]8;;https://evil.pen-test.example/\u0007link';
const hostileBidi = '‮gnp.exe‬';

export const PLAN: PenTestPlan = {
  shipped: [
    {
      handle: 'lookout',
      name: 'lookout',
      purpose:
        "Lookout itself, from the round's Image: its own environment holds its secrets (H1).",
      configurations: ['default', 'socket-proxy'],
      labels: { 'lookout.self': 'true' },
    },
    {
      handle: 'socket-proxy',
      name: 'lookout-docker-proxy',
      purpose: 'The socket proxy (ADR-0011), on the deployment loopback (H2, P1).',
      configurations: ['socket-proxy'],
      labels: { 'lookout.self': 'true' },
    },
  ],
  containers: [
    {
      handle: 'victim',
      name: 'victim',
      purpose: 'Made-up secrets in its environment, command, labels and a mount path (H8).',
      command: ['idle', ...victimSecrets.command, '--db', victimSecrets.env.DATABASE_URL],
      env: victimSecrets.env,
      labels: victimSecrets.labels,
      ports: [],
      mounts: [{ source: victimSecrets.mountSource, target: '/data' }],
      state: 'running',
      secrets: [
        ...Object.values(victimSecrets.env),
        victimSecrets.command[1]!,
        ...Object.values(victimSecrets.labels),
        victimSecrets.mountSource,
      ],
    },
    {
      handle: 'shop-web',
      name: 'shop-web-1',
      purpose: 'A Compose Project, "shop", in good health.',
      command: ['idle'],
      env: { SHOP_MODE: 'pen-test' },
      labels: {},
      ports: [],
      mounts: [],
      state: 'running',
      composeProject: 'shop',
      secrets: [],
    },
    {
      handle: 'shop-worker',
      name: 'shop-worker-1',
      purpose: 'The Flagged Container: running, with a health check that always fails.',
      command: ['idle'],
      env: { WORKER_QUEUE: 'pen-test' },
      labels: {},
      ports: [],
      mounts: [],
      state: 'unhealthy',
      composeProject: 'shop',
      secrets: [],
    },
    {
      handle: 'stopped',
      name: 'stopped-removable',
      purpose: 'A stopped Container (exited 0) that the remove probes may destroy.',
      command: ['exit', '0'],
      env: {},
      labels: {},
      ports: [],
      mounts: [],
      state: 'exited',
      secrets: [],
    },
    {
      handle: 'broken',
      name: 'broken-start',
      purpose: 'Created, never started: starting it fails inside Docker, for its error text (H11).',
      command: ['idle'],
      entrypoint: ['/no/such/binary'],
      env: {},
      labels: {},
      ports: [],
      mounts: [],
      state: 'created',
      secrets: [],
    },
    {
      handle: 'hostile',
      // Docker's name grammar refuses markup, so the name tries the grammar's edges instead.
      name: 'hostile.container_-..x',
      purpose:
        'The Hostile Container: SSRF in its labels, markup, escapes and long values in its labels, environment and logs.',
      command: ['hostile-logs', String(256 * KIB)],
      env: {
        [`HOSTILE_${'N'.repeat(200)}`]: 'a long variable name',
        HOSTILE_MARKUP: hostileMarkup,
        HOSTILE_ESCAPES: hostileEscapes,
        HOSTILE_BIDI: hostileBidi,
        HOSTILE_LONG: 'V'.repeat(64 * KIB),
      },
      labels: {
        // SSRF: the deployment's loopback (the socket proxy's port), link-local metadata, and
        // IPv6 loopback. Image publishers can set these too (H4, S1).
        'lookout.url': [
          `http://127.0.0.1:${PROXY_PORT}/containers/json`,
          'http://169.254.169.254/latest/meta-data/',
          `http://[::1]:${PROXY_PORT}/_ping`,
        ].join(','),
        'traefik.http.routers.hostile.rule': 'Host(`169.254.169.254`) || Host(`localhost`)',
        'com.example.markup': hostileMarkup,
        'com.example.escapes': hostileEscapes,
        'com.example.bidi': hostileBidi,
        'com.example.long': 'L'.repeat(64 * KIB),
      },
      ports: [],
      mounts: [],
      state: 'running',
      secrets: [],
    },
    {
      handle: 'site-healthy',
      name: 'site-healthy',
      purpose: 'Serves the healthy Hosted Site.',
      command: ['site', '8080'],
      env: {},
      labels: { 'lookout.url': 'http://healthy.pen-test.example:8081/' },
      ports: [{ hostPort: 8081, containerPort: 8080 }],
      mounts: [],
      state: 'running',
      secrets: [],
    },
    {
      handle: 'site-expired',
      name: 'site-expired-tls',
      purpose: 'Serves the Hosted Site whose certificate expired in 2024.',
      command: ['expired-tls', '8443', 'expired.pen-test.example'],
      env: {},
      labels: { 'lookout.url': 'https://expired.pen-test.example:8443/' },
      ports: [{ hostPort: 8443, containerPort: 8443 }],
      mounts: [],
      state: 'running',
      secrets: [],
    },
    {
      handle: 'site-redirect',
      name: 'site-redirect-internal',
      purpose: 'Serves the Hosted Site that redirects to an internal address.',
      command: ['redirect', '8080', `http://127.0.0.1:${PROXY_PORT}/containers/json`],
      env: {},
      labels: { 'lookout.url': 'http://redirect.pen-test.example:8082/' },
      ports: [{ hostPort: 8082, containerPort: 8080 }],
      mounts: [],
      state: 'running',
      secrets: [],
    },
  ],
  sites: [
    {
      handle: 'healthy',
      url: 'http://healthy.pen-test.example:8081/',
      servedBy: 'site-healthy',
      expect: 'Up, 200.',
    },
    {
      handle: 'expired',
      url: 'https://expired.pen-test.example:8443/',
      servedBy: 'site-expired',
      expect: 'Down: the certificate is self-signed and expired on 1 February 2024.',
    },
    {
      handle: 'redirect',
      url: 'http://redirect.pen-test.example:8082/',
      servedBy: 'site-redirect',
      expect: "A 302 to the socket proxy's address, shown and not followed.",
    },
  ],
  hostRoot: { source: 'e2e/fixtures/host', target: '/pen-test/host-root' },
  password: 'generated per deployment',
  oversized: [
    {
      handle: 'x1-label',
      where: 'label',
      bytes: 64 * MIB,
      purpose: 'Every containers event on /api/stream carries every label (H9).',
    },
    {
      handle: 'x1-environment',
      where: 'environment',
      bytes: 64 * MIB,
      purpose: 'Inspect bodies are read whole (H9).',
    },
    {
      handle: 'x1-log-line',
      where: 'log line without a newline',
      bytes: 512 * MIB,
      purpose: 'LineSplitter keeps everything after the last newline (H9).',
    },
    {
      handle: 'x1-frame',
      where: 'log frame header',
      bytes: 2 ** 32 - 1,
      purpose: 'The frame decoder buffers to the size a header claims (H9).',
    },
  ],
};

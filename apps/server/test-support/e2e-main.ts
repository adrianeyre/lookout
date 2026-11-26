/**
 * The server as Playwright runs it: the real app, a fixture Host root and the fake Docker.
 * Seeds LOOKOUT_HOST_ROOT from e2e/fixtures/host so tests can change files while it runs,
 * and adds /__e2e routes so tests can drive the fake Docker. Never part of the Image.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLine } from '@lookout/shared';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { InspectedContainer } from '../src/docker/parse.ts';
import { HostRoot } from '../src/host-root.ts';
import { FakeDocker, makeContainer } from './fake-docker.ts';
import { FAKE_SITE_MODES, FakeSite, makeCertificate, type FakeSiteMode } from './fake-site.ts';
import { FIXTURE_LOGS, fixtureContainers } from './e2e-fixtures.ts';

const fixture = fileURLToPath(new URL('../../../e2e/fixtures/host/', import.meta.url));
// The e2e hash is cheap on purpose, so sign-ins stay quick (#124 allows it only here).
const config = loadConfig(process.env, { allowCheapPasswordHash: true });

if (process.env.LOOKOUT_E2E_SEED === '1') {
  await rm(config.hostRoot, { recursive: true, force: true });
  await mkdir(config.hostRoot, { recursive: true });
  await cp(fixture, config.hostRoot, { recursive: true });
  // Made-up folders for the Largest folders Widget, written here rather than kept in Git.
  const folders: Record<string, number> = {
    'srv/media/films/one.mkv': 900_000,
    'srv/media/films/two.mkv': 700_000,
    'srv/media/music/album.flac': 100_000,
    'var/lib/docker/volumes/shop_db/data': 600_000,
    'var/lib/docker/volumes/shop_db/wal': 500_000,
    'opt/backups/monday.tar': 300_000,
    'opt/backups/tuesday.tar': 300_000,
  };
  for (const [file, bytes] of Object.entries(folders)) {
    const target = path.join(config.hostRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(bytes, 7));
  }
}

/**
 * Reads the fixture Host root, except that a test can set a filesystem's usage % in
 * .e2e-statfs.json (for example {"/": 91}), which a real temporary directory cannot do.
 */
class FixtureHostRoot extends HostRoot {
  override async statfs(hostPath: string) {
    const real = await super.statfs(hostPath);
    let overrides: Record<string, number> = {};
    try {
      overrides = JSON.parse(await readFile(this.path('.e2e-statfs.json'), 'utf8')) as Record<
        string,
        number
      >;
    } catch {
      // No overrides.
    }
    const percent = overrides[hostPath];
    if (percent === undefined) return real;
    const blocks = 1_000_000n;
    const free = BigInt(Math.round(1_000_000 * (1 - percent / 100)));
    return { ...real, blocks, bfree: free, bavail: free, bsize: 4096n };
  }
}

// Hosted Sites to check (ports match e2e/server.ts): shop-web-1's lookout.url, and an https
// one from LOOKOUT_SITES whose certificate expires in 5 days.
const secureCert = makeCertificate('secure.example', 5);
const sites = {
  http: new FakeSite({ port: config.port + 1000, slowMs: 600 }),
  https: new FakeSite({ port: config.port + 2000, slowMs: 600, tls: secureCert }),
};
await Promise.all([sites.http.start(), sites.https.start()]);
const shopSiteUrl = `http://store.example:${config.port + 1000}/`;

const docker = new FakeDocker();
function seedDocker() {
  docker.reset(fixtureContainers(Date.now(), shopSiteUrl));
  for (const { id, line } of FIXTURE_LOGS) docker.appendLog(id, line);
}
seedDocker();

const app = await buildApp({
  config,
  docker,
  hostRoot: new FixtureHostRoot(config.hostRoot),
  // Use statfs's block size as is, so the overrides above are taken literally.
  blockUnitProbe: async (_path, _blocks, bsize) => bsize,
  heartbeatMs: Number(process.env.LOOKOUT_E2E_HEARTBEAT_MS ?? 1000),
  dockerRetryMs: 250,
  // The fake https Hosted Site's self-signed certificate is trusted, as a real CA's would be.
  siteCa: [secureCert.cert],
  statsFlushMs: 250,
  // The first scan of the largest folders starts straight away, not after 30 s.
  folderScanDelayMs: 500,
  logger: { level: 'error' },
});

const e2e = { config: { public: true } };
app.post<{ Body: { available: boolean } }>('/__e2e/docker/available', e2e, async (request) => {
  docker.available = request.body.available;
  return { available: docker.available };
});
app.post('/__e2e/docker/reset', e2e, async () => {
  // Restoring the fixtures as a daemon restart: open streams end and the list is re-read.
  docker.available = false;
  seedDocker();
  docker.available = true;
  await Promise.all([sites.http.setMode('ok'), sites.https.setMode('ok')]);
  return { ok: true };
});
app.post<{ Body: { container: Partial<InspectedContainer> & { id: string }; action: string } }>(
  '/__e2e/docker/upsert',
  e2e,
  async (request) => {
    docker.upsert(makeContainer(request.body.container), request.body.action);
    return { ok: true };
  },
);
app.post<{ Body: { id: string; lines: LogLine[] } }>('/__e2e/docker/logs', e2e, async (request) => {
  for (const line of request.body.lines) docker.appendLog(request.body.id, line);
  return { ok: true };
});
app.post<{ Body: { ms: number } }>('/__e2e/docker/action-delay', e2e, async (request) => {
  docker.actionDelayMs = request.body.ms;
  return { ok: true };
});
app.post<{ Body: { message: string } }>('/__e2e/docker/fail-next', e2e, async (request) => {
  docker.failNextAction(request.body.message);
  return { ok: true };
});
app.get('/__e2e/docker/actions', e2e, async () => ({ actions: docker.actions }));
app.get<{ Params: { kind: 'events' | 'logs' | 'stats' } }>(
  '/__e2e/docker/open/:kind',
  e2e,
  async (request) => ({ open: docker.openStreams(request.params.kind) }),
);

app.post<{ Params: { site: string }; Body: { mode: FakeSiteMode } }>(
  '/__e2e/sites/:site',
  e2e,
  async (request, reply) => {
    const name = request.params.site;
    if ((name !== 'http' && name !== 'https') || !FAKE_SITE_MODES.includes(request.body.mode)) {
      return reply.code(400).send();
    }
    const site = sites[name];
    await site.setMode(request.body.mode);
    return { mode: site.mode };
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(
    signal,
    () =>
      void Promise.all([app.close(), sites.http.stop(), sites.https.stop()]).then(() =>
        process.exit(0),
      ),
  );
}

await app.listen({ host: config.bindAddress, port: config.port });

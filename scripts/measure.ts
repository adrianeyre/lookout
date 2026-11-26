/**
 * `pnpm measure`: checks Lookout against its footprint and latency budgets (PRD NFR-1,
 * NFR-2, ADR-0001), so "lightweight" is measured rather than assumed.
 *
 * It starts the real server (apps/server/src/main.ts) against the real Docker daemon and,
 * on Linux, the real Host ("/"; elsewhere the fixture Host in e2e/fixtures/host), then:
 *
 *   1. idle RSS and CPU with no browser connected
 *   2. CPU with one browser on the Host page, at the default sample interval
 *   3. CPU with one browser on the Containers page (which also streams Container stats)
 *   4. the time from a Container stopping or starting (`docker stop` / `docker start`
 *      returning) to the Containers page showing its new state
 *
 * Step 4 creates a throwaway busybox Container and removes it afterwards. Prints a
 * Markdown table and exits non-zero if anything is over budget.
 *
 * Options:
 *   --image <tag>  measure that Image (as compose.yaml runs it) instead of the source tree;
 *                  this is what NFR-1 is about, as RSS differs between macOS and Linux
 *   --quick        shorter windows, for a smoke run
 *   --port <n>     default 7799
 */
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { hashPassword } from '../apps/server/src/auth/password.ts';

const run = promisify(execFile);
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const image = option('--image');
const portIndex = args.indexOf('--port');
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 7799;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'measure-only-password';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const WARMUP_S = quick ? 5 : 20;
const IDLE_S = quick ? 10 : 60;
const BROWSER_S = quick ? 15 : 120;
const LATENCY_TRIALS = quick ? 3 : 10;

const BUDGET = { rssMb: 100, cpuPercent: 2, latencyMs: 2000 };

/** How to read the server's memory and CPU time: a local process, or PID 1 of a Container. */
interface Target {
  /** Resident set size, in MB. */
  rssMb(): Promise<number>;
  /** CPU time used so far, in seconds. */
  cpuSeconds(): Promise<number>;
  stop(): Promise<void>;
  exited(): boolean;
}

/** Resident set size of a process, in MB (ps works on Linux and macOS). */
async function psRssMb(pid: number): Promise<number> {
  const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
  return Number(stdout.trim()) / 1024;
}

/** CPU time a process has used so far, in seconds, from ps's [[dd-]hh:]mm:ss[.cc]. */
async function psCpuSeconds(pid: number): Promise<number> {
  const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)]);
  const [days, rest] = stdout.trim().includes('-')
    ? (stdout.trim().split('-') as [string, string])
    : ['0', stdout.trim()];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86_400 + h * 3600 + m * 60 + s;
}

/** % of one core the process used over `seconds`. */
async function cpuPercentOver(target: Target, seconds: number): Promise<number> {
  const before = await target.cpuSeconds();
  const start = performance.now();
  await sleep(seconds * 1000);
  const elapsed = (performance.now() - start) / 1000;
  return (((await target.cpuSeconds()) - before) / elapsed) * 100;
}

async function averageRss(target: Target, seconds: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < seconds; i += 1) {
    samples.push(await target.rssMb());
    await sleep(1000);
  }
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const hostRoot =
  process.platform === 'linux'
    ? '/'
    : fileURLToPath(new URL('../e2e/fixtures/host', import.meta.url));

if (!(await dockerAvailable())) {
  console.error('pnpm measure needs a running Docker daemon.');
  process.exit(1);
}

const env = {
  LOG_LEVEL: 'warn',
  LOOKOUT_PORT: String(PORT),
  LOOKOUT_PASSWORD_HASH: await hashPassword(PASSWORD),
  LOOKOUT_SESSION_SECRET: 'measure-only-session-secret-0123456789abcdef',
};

async function startLocal(): Promise<Target> {
  console.error(`Starting Lookout from source on ${BASE} (Host root ${hostRoot})…`);
  const server = spawn(process.execPath, ['apps/server/src/main.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'production',
      LOOKOUT_BIND_ADDRESS: '127.0.0.1',
      LOOKOUT_HOST_ROOT: hostRoot,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const pid = server.pid!;
  return {
    rssMb: () => psRssMb(pid),
    cpuSeconds: () => psCpuSeconds(pid),
    stop: async () => void server.kill('SIGTERM'),
    exited: () => server.exitCode !== null,
  };
}

async function startImage(tag: string): Promise<Target> {
  const name = `lookout-measure-server-${process.pid}`;
  console.error(`Starting the Image ${tag} on ${BASE}…`);
  // The socket's group, as compose.yaml's DOCKER_GID gives it.
  const { stdout: gid } = await run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'stat',
    '-v',
    '/var/run/docker.sock:/s',
    tag,
    '-c',
    '%g',
    '/s',
  ]);
  const flags = Object.entries({
    ...env,
    LOOKOUT_BIND_ADDRESS: '0.0.0.0',
    LOOKOUT_PORT: '7777',
  }).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  await run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'lookout.self=true',
    '--group-add',
    gid.trim(),
    '-p',
    `127.0.0.1:${PORT}:7777`,
    ...flags,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    // rslave needs a shared root mount, which Docker Desktop's VM does not have.
    '-v',
    process.platform === 'linux' ? '/:/host:ro,rslave' : '/:/host:ro',
    tag,
  ]);
  const proc = async (file: string) =>
    (await run('docker', ['exec', name, 'cat', `/proc/1/${file}`])).stdout;
  let gone = false;
  return {
    rssMb: async () => Number(/VmRSS:\s+(\d+)/.exec(await proc('status'))![1]) / 1024,
    cpuSeconds: async () => {
      // utime and stime, fields 14 and 15, in clock ticks (100 per second on Linux).
      const fields = (await proc('stat')).split(') ')[1]!.split(' ');
      return (Number(fields[11]) + Number(fields[12])) / 100;
    },
    stop: async () => {
      gone = true;
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
    },
    exited: () => gone,
  };
}

const target = image ? await startImage(image) : await startLocal();
const throwaway = `lookout-measure-${process.pid}`;
const browser = await chromium.launch();

const results: { what: string; value: string; budget: string; ok: boolean }[] = [];
try {
  for (let i = 0; ; i += 1) {
    if (target.exited()) throw new Error('The server exited');
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (i > 100) throw new Error('Server did not start');
    await sleep(100);
  }

  console.error(`Warming up for ${WARMUP_S}s, then measuring idle for ${IDLE_S}s…`);
  await sleep(WARMUP_S * 1000);
  const [idleCpu, idleRss] = await Promise.all([
    cpuPercentOver(target, IDLE_S),
    averageRss(target, Math.min(IDLE_S, 30)),
  ]);
  results.push(
    {
      what: 'Idle RSS (no browser)',
      value: `${idleRss.toFixed(1)} MB`,
      budget: `< ${BUDGET.rssMb} MB`,
      ok: idleRss < BUDGET.rssMb,
    },
    {
      what: 'Idle CPU (no browser)',
      value: `${idleCpu.toFixed(2)}%`,
      budget: `< ${BUDGET.cpuPercent}%`,
      ok: idleCpu < BUDGET.cpuPercent,
    },
  );

  const page = await browser.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
  await page.getByTestId('memory-card').waitFor();

  console.error(`One browser on the Host page for ${BROWSER_S}s…`);
  await sleep(5000);
  const hostCpu = await cpuPercentOver(target, BROWSER_S);
  const hostRss = await target.rssMb();
  results.push(
    {
      what: 'CPU, one browser on the Host page',
      value: `${hostCpu.toFixed(2)}%`,
      budget: `< ${BUDGET.cpuPercent}%`,
      ok: hostCpu < BUDGET.cpuPercent,
    },
    {
      what: 'RSS, one browser connected',
      value: `${hostRss.toFixed(1)} MB`,
      budget: `< ${BUDGET.rssMb} MB`,
      ok: hostRss < BUDGET.rssMb,
    },
  );

  await run('docker', ['run', '-d', '--name', throwaway, 'busybox:1.37', 'sleep', '3600']);
  await page.getByRole('link', { name: 'Containers', exact: true }).click();
  const state = page.locator(
    `[data-testid="container-row"][data-name="${throwaway}"] [data-testid="container-state"]`,
  );
  await state.waitFor();

  console.error(`One browser on the Containers page for ${BROWSER_S}s…`);
  await sleep(5000);
  const containersCpu = await cpuPercentOver(target, BROWSER_S);
  results.push({
    what: 'CPU, one browser on the Containers page (with stats)',
    value: `${containersCpu.toFixed(2)}%`,
    budget: `< ${BUDGET.cpuPercent}%`,
    ok: containersCpu < BUDGET.cpuPercent,
  });

  console.error(`Timing ${LATENCY_TRIALS} stops and starts…`);
  /** Resolves with the time (ms since the epoch) the row first shows `expected`. */
  const whenShown = (expected: string) =>
    state.evaluate(
      (element, wanted) =>
        new Promise<number>((resolve) => {
          const check = () => {
            if (element.isConnected && element.textContent === wanted) {
              observer.disconnect();
              resolve(Date.now());
              return true;
            }
            return false;
          };
          const observer = new MutationObserver(() => void check());
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          check();
        }),
      expected,
    );
  const latencies: number[] = [];
  for (let i = 0; i < LATENCY_TRIALS; i += 1) {
    for (const [command, expected] of [
      ['stop', 'exited'],
      ['start', 'running'],
    ] as const) {
      const shown = whenShown(expected);
      const args = command === 'stop' ? ['stop', '-t', '0', throwaway] : ['start', throwaway];
      await run('docker', args);
      const done = Date.now();
      latencies.push(Math.max(0, (await shown) - done));
    }
  }
  const worst = Math.max(...latencies);
  results.push({
    what: `Docker state change → UI (${latencies.length} changes)`,
    value: `median ${median(latencies).toFixed(0)} ms, max ${worst.toFixed(0)} ms`,
    budget: `< ${BUDGET.latencyMs} ms`,
    ok: worst < BUDGET.latencyMs,
  });
} finally {
  await browser.close();
  await run('docker', ['rm', '-f', throwaway]).catch(() => undefined);
  await target.stop();
}

const { stdout: dockerVersion } = await run('docker', [
  'version',
  '--format',
  '{{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})',
]);
console.log(
  `\nLookout footprint and latency — Node ${process.version}, Docker ${dockerVersion.trim()}, ` +
    (image ? `Image ${image}` : `source on ${process.platform}/${process.arch}`) +
    `${quick ? ' (--quick)' : ''}\n`,
);
console.log('| Measurement | Result | Budget | |');
console.log('| --- | --- | --- | --- |');
for (const r of results)
  console.log(`| ${r.what} | ${r.value} | ${r.budget} | ${r.ok ? '✅' : '❌'} |`);
process.exit(results.every((r) => r.ok) ? 0 : 1);

/**
 * The pen-test deployment (E1, docs/pen-test/deployment.md); its commands are in cli.ts.
 *
 * Lookout runs *inside* a throwaway Docker daemon (docker:dind) with the shipped
 * compose.yaml, and compose.socket-proxy.yaml when asked, plus one override that swaps in
 * the round's Image and the fixture Host root. It never talks to the Tester's machine's
 * Docker; this script does, only to build Images and to run the throwaway daemon.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, hashPassword } from '../auth/password.ts';
import { FIXTURE_IMAGE, HOST_IP } from './fixtures/plan.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** The deployment's own Compose project on the Tester's machine: never "lookout". */
export const PROJECT = 'lookout-pen-test';
const OUTER_COMPOSE = path.join(REPO_ROOT, 'pen-test/compose.yaml');
/** Local, untracked: the testers' credentials package (credentials-package.md). */
export const STATE_DIR = path.join(REPO_ROOT, 'pen-test/.state');
export const CREDENTIALS_FILE = path.join(STATE_DIR, 'credentials.json');

export const LOOKOUT_IMAGE = 'lookout:pen-test';
const RELAY_IMAGE = 'lookout-pen-test-relay:local';
/** Inside the throwaway daemon: the shipped Compose files, the override and the .env. */
const INNER_DIR = '/pen-test/lookout';
const CONFIGURATION_FILE = '/pen-test/configuration';
/** The docker group in docker:dind, which owns its socket. */
const DIND_DOCKER_GID = '2375';

export const CONFIGURATIONS = ['default', 'socket-proxy'] as const;
export type Configuration = (typeof CONFIGURATIONS)[number];

export interface Credentials {
  url: string;
  password: string;
  configuration: Configuration;
  commit: string;
  createdAt: string;
}

export const deploymentUrl = (port = Number(process.env.PEN_TEST_PORT ?? 7780)) =>
  `http://127.0.0.1:${port}`;

interface RunOptions {
  input?: string | Buffer;
  /** Return null instead of throwing when the command fails. */
  allowFail?: boolean;
  cwd?: string;
  /** Show the command's output instead of capturing it. */
  inherit?: boolean;
}

/** Runs the Docker CLI on the Tester's machine. */
export function docker(args: string[], options: RunOptions = {}): string | null {
  const exec: ExecFileSyncOptions = {
    cwd: options.cwd ?? REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    ...(options.input !== undefined ? { input: options.input } : {}),
  };
  try {
    const output = execFileSync('docker', args, exec);
    return output ? output.toString('utf8') : '';
  } catch (error) {
    if (options.allowFail) return null;
    const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8') ?? '';
    throw new Error(`docker ${args.slice(0, 4).join(' ')} … failed: ${stderr.trim()}`, {
      cause: error,
    });
  }
}

/** The deployment's own Compose project, on the Tester's machine. */
export const outer = (args: string[], options: RunOptions = {}) =>
  docker(['compose', '-p', PROJECT, '-f', OUTER_COMPOSE, ...args], options);

/** The throwaway daemon's Container ID, or null when the deployment is down. */
export function dindContainer(): string | null {
  const id = outer(['ps', '-q', 'dind'], { allowFail: true })?.trim();
  return id ? id : null;
}

function requireDind(): string {
  const id = dindContainer();
  if (!id) throw new Error('The pen-test deployment is not running: pnpm pen-test:up');
  return id;
}

/** Runs a command inside the throwaway daemon's container (the round's Host). */
export function inDind(args: string[], options: RunOptions = {}): string | null {
  const id = requireDind();
  return docker(['exec', ...(options.input !== undefined ? ['-i'] : []), id, ...args], options);
}

/** Runs the Docker CLI against the throwaway daemon, never the Tester's machine's. */
export const dindDocker = (args: string[], options: RunOptions = {}) =>
  inDind(['docker', ...args], options);

function innerComposeArgs(configuration: Configuration): string[] {
  return [
    'compose',
    '-p',
    'lookout',
    '-f',
    'compose.yaml',
    ...(configuration === 'socket-proxy' ? ['-f', 'compose.socket-proxy.yaml'] : []),
    '-f',
    'pen-test.override.yaml',
  ];
}

/** Runs `docker compose` for the shipped configuration inside the throwaway daemon. */
export function innerCompose(
  configuration: Configuration,
  args: string[],
  options: RunOptions = {},
) {
  return inDind(
    [
      'sh',
      '-c',
      `cd ${INNER_DIR} && docker "$@"`,
      'sh',
      ...innerComposeArgs(configuration),
      ...args,
    ],
    options,
  );
}

/** The configuration Lookout is running in, or null. */
export function runningConfiguration(): Configuration | null {
  if (!dindContainer()) return null;
  const value = inDind(['cat', CONFIGURATION_FILE], { allowFail: true })?.trim();
  return CONFIGURATIONS.find((c) => c === value) ?? null;
}

export function readCredentials(): Credentials {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as Credentials;
  } catch {
    throw new Error(`No credentials package at ${CREDENTIALS_FILE}: pnpm pen-test:up`);
  }
}

/** The socket proxy's pinned Image reference, read from the shipped file itself. */
function proxyImage(): string {
  const text = readFileSync(path.join(REPO_ROOT, 'compose.socket-proxy.yaml'), 'utf8');
  const image = /^\s*image:\s*(\S+)/m.exec(text)?.[1];
  if (!image) throw new Error('compose.socket-proxy.yaml names no image');
  return image;
}

function commit(): string {
  return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO_ROOT })
    .toString('utf8')
    .trim();
}

/** Builds the round's Images on the Tester's machine and loads them into the daemon. */
function loadImages(): void {
  const proxy = proxyImage();
  const proxyTag = proxy.split('@')[0]!;
  docker(['pull', '--quiet', proxy]);
  docker(['tag', proxy, proxyTag]);
  const images = [LOOKOUT_IMAGE, FIXTURE_IMAGE, proxyTag];
  const archive = execFileSync('docker', ['save', ...images], { maxBuffer: 2 * 1024 ** 3 });
  // The daemon's containerd store keeps the digest, so the shipped file's pin resolves.
  dindDocker(['load', '--quiet'], { input: archive });
}

/** Writes a file inside the throwaway daemon with the given mode. */
function writeInDind(file: string, text: string, mode = '600'): void {
  inDind(['sh', '-c', `umask 077 && cat > "$1" && chmod ${mode} "$1"`, 'sh', file], {
    input: text,
  });
}

function copyIntoDind(source: string, target: string): void {
  // Emptied in place, never replaced: Lookout's bind mount holds the directory itself, so a
  // new one at the same path would leave Lookout reading the deleted, empty original.
  inDind(['sh', '-c', 'mkdir -p "$1" && find "$1" -mindepth 1 -delete', 'sh', target]);
  docker(['cp', `${source}/.`, `${requireDind()}:${target}`]);
}

/** Generates the round's credentials (credentials-package.md), unless they exist. */
async function ensureCredentials(configuration: Configuration): Promise<Credentials> {
  const existing = inDind(['test', '-f', `${INNER_DIR}/.env`], { allowFail: true }) !== null;
  if (existing) {
    const credentials = { ...readCredentials(), configuration };
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    return credentials;
  }
  const password = randomBytes(18).toString('base64url');
  const hash = await hashPassword(password, DEFAULT_PARAMS);
  // The session secret is written only inside the deployment: testers never get it (H1).
  const secret = randomBytes(32).toString('base64');
  const env = [
    `LOOKOUT_PASSWORD_HASH='${hash}'`,
    `LOOKOUT_SESSION_SECRET='${secret}'`,
    `LOOKOUT_BIND_ADDRESS=${HOST_IP}`,
    'LOOKOUT_PORT=7777',
    `DOCKER_GID=${DIND_DOCKER_GID}`,
    'LOOKOUT_SITE_CHECK_INTERVAL_SECONDS=15',
    'LOOKOUT_SITE_TIMEOUT_MS=5000',
  ].join('\n');
  writeInDind(`${INNER_DIR}/.env`, `${env}\n`);
  const credentials: Credentials = {
    url: deploymentUrl(),
    password,
    configuration,
    commit: commit(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  return credentials;
}

/** Starts Lookout inside the daemon in one shipped configuration, stopping the other. */
function startLookout(configuration: Configuration): void {
  const running = runningConfiguration();
  if (running) innerCompose(running, ['down', '--remove-orphans']);
  for (const file of ['compose.yaml', 'compose.socket-proxy.yaml']) {
    docker(['cp', path.join(REPO_ROOT, file), `${requireDind()}:${INNER_DIR}/${file}`]);
  }
  docker([
    'cp',
    path.join(REPO_ROOT, 'pen-test/lookout.override.yaml'),
    `${requireDind()}:${INNER_DIR}/pen-test.override.yaml`,
  ]);
  innerCompose(configuration, ['up', '--detach', '--wait', '--pull', 'never'], { inherit: true });
  writeInDind(CONFIGURATION_FILE, `${configuration}\n`, '644');
}

export async function up(configuration: Configuration): Promise<Credentials> {
  console.log(`Building the round's Images from ${commit()}…`);
  docker(
    [
      'build',
      '--quiet',
      '--tag',
      LOOKOUT_IMAGE,
      '--build-arg',
      `LOOKOUT_VERSION=pen-test-${commit()}`,
      '.',
    ],
    { inherit: true },
  );
  docker(['build', '--quiet', '--tag', FIXTURE_IMAGE, 'pen-test/fixture-image'], { inherit: true });
  console.log('Starting the throwaway daemon and the relay…');
  outer(['up', '--detach', '--build', '--wait'], { inherit: true });
  loadImages();
  inDind(['mkdir', '-p', INNER_DIR]);
  copyIntoDind(path.join(REPO_ROOT, 'e2e/fixtures/host'), '/pen-test/host-root');
  const credentials = await ensureCredentials(configuration);
  startLookout(configuration);
  console.log(
    `\nLookout (${configuration}) is up at ${credentials.url}.\n` +
      `The testers' credentials package: ${path.relative(REPO_ROOT, CREDENTIALS_FILE)}\n` +
      'Load the fixtures with: pnpm pen-test:seed',
  );
  return credentials;
}

export function status(): void {
  const configuration = runningConfiguration();
  if (!configuration) {
    console.log('The pen-test deployment is down.');
    return;
  }
  console.log(`Configuration: ${configuration}\nURL: ${deploymentUrl()}\n`);
  dindDocker(['ps', '--all', '--format', 'table {{.Names}}\t{{.State}}\t{{.Status}}'], {
    inherit: true,
  });
}

/** What of the deployment is left on the Tester's machine: should be nothing after down. */
export function leftovers(): string[] {
  const filter = `label=com.docker.compose.project=${PROJECT}`;
  const list = (args: string[]) =>
    (docker(args) ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  return [
    ...list(['ps', '--all', '--quiet', '--filter', filter]).map((id) => `container ${id}`),
    ...list(['network', 'ls', '--quiet', '--filter', filter]).map((id) => `network ${id}`),
    ...list(['volume', 'ls', '--quiet', '--filter', filter]).map((id) => `volume ${id}`),
  ];
}

export function down(): void {
  outer(['down', '--volumes', '--remove-orphans', '--timeout', '5'], { inherit: true });
  for (const image of [LOOKOUT_IMAGE, FIXTURE_IMAGE, RELAY_IMAGE]) {
    docker(['image', 'rm', '--force', image], { allowFail: true });
  }
  // The credentials end with the round (success criterion 7); the session secret was only
  // ever inside the deployment's volume, which is gone.
  rmSync(STATE_DIR, { recursive: true, force: true });
  const left = leftovers();
  if (left.length > 0) {
    throw new Error(`The pen-test deployment left these behind:\n  ${left.join('\n  ')}`);
  }
  console.log('The pen-test deployment is gone: no container, network, volume or credential left.');
}

/** Waits until Lookout in the deployment reports itself healthy. */
export function waitForLookout(): void {
  for (let attempt = 0; attempt < 90; attempt++) {
    const health = dindDocker(['inspect', '--format', '{{.State.Health.Status}}', 'lookout'], {
      allowFail: true,
    })?.trim();
    if (health === 'healthy') return;
    inDind(['sleep', '1']);
  }
  throw new Error('Lookout did not become healthy');
}

/** Restarts Lookout's Container, as an update or a reboot would. */
export function restartLookout(): void {
  dindDocker(['restart', 'lookout']);
  waitForLookout();
}

/**
 * Changes the round's password the way ADR-0008 tells an owner to: a new hash in the
 * environment, and the Container recreated. The session secret is left as it is. Updates
 * the credentials package.
 */
export async function changePassword(): Promise<Credentials> {
  const configuration = runningConfiguration();
  if (!configuration) throw new Error('The pen-test deployment is not running: pnpm pen-test:up');
  const password = randomBytes(18).toString('base64url');
  const hash = await hashPassword(password, DEFAULT_PARAMS);
  inDind([
    'sh',
    '-c',
    `sed -i '/^LOOKOUT_PASSWORD_HASH=/d' "$1" && printf '%s\\n' "$2" >> "$1"`,
    'sh',
    `${INNER_DIR}/.env`,
    `LOOKOUT_PASSWORD_HASH='${hash}'`,
  ]);
  innerCompose(configuration, ['up', '--detach', '--wait', '--pull', 'never']);
  waitForLookout();
  const credentials = { ...readCredentials(), password };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  return credentials;
}

/** Loads an Image pinned by digest into the deployment's daemon, which cannot pull. */
export function loadPinnedImage(reference: string): void {
  docker(['pull', '--quiet', reference]);
  const tag = reference.split('@')[0]!;
  docker(['tag', reference, tag]);
  const archive = execFileSync('docker', ['save', tag], { maxBuffer: 2 * 1024 ** 3 });
  dindDocker(['load', '--quiet'], { input: archive });
}

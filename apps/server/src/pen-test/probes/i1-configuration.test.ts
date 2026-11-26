/**
 * Pen-test scope issue I1 (#70): deployment configuration, probed without the deployment.
 * Findings are in docs/pen-test/findings/I1.md. While a gap is open, an `it.fails` states
 * the property that should hold beside a `today_…` test pinning what happens now (PRD,
 * "Checks every scope issue carries"). The deployment half is i1-deployment.probe.ts.
 *
 * The startup probes run the real `main.ts` in a child process with `net.Server#listen`
 * stubbed to report success without binding anything, Docker pointed at a socket that does
 * not exist, and the fixture Host root: nothing listens, nothing reaches any Docker, and
 * only the startup log is read. Every secret here is made up.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_TEST_PASSWORD_HASH, TEST_PASSWORD_HASH } from '../../../test/helpers.ts';
import { ConfigError, loadConfig } from '../../config.ts';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (file: string) => readFileSync(`${REPO}${file}`, 'utf8');

/** As random as `openssl rand -base64 32`; made up. */
const SECRET = 'q3Vt8pZ1sKx0mW7eRb2LyN5hGd9cJf4A';
// At the minimum cost loadConfig accepts (#124), as a real install's would be.
const baseEnv = {
  LOOKOUT_PASSWORD_HASH: CONFIG_TEST_PASSWORD_HASH,
  LOOKOUT_SESSION_SECRET: SECRET,
};

/** Loaded before main.ts: listen reports success on the asked address and binds nothing. */
const LISTEN_STUB = `
import net from 'node:net';
net.Server.prototype.listen = function (...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  const callback = args.find((a) => typeof a === 'function');
  const family = net.isIPv6(options.host) ? 'IPv6' : 'IPv4';
  this.address = () => ({ address: options.host, port: options.port || 7777, family });
  this.close = (cb) => { process.nextTick(() => { this.emit('close'); cb?.(); }); return this; };
  process.nextTick(() => { this.emit('listening'); callback?.(); });
  return this;
};
`;

interface Startup {
  /** Every line Lookout wrote to stdout and stderr before it was stopped or exited. */
  lines: string[];
  exitCode: number | null;
}

/** Starts main.ts with the given bind address, reads its startup log, then stops it. */
function startLookout(bindAddress: string): Promise<Startup> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(LISTEN_STUB)}`,
        `${REPO}apps/server/src/main.ts`,
      ],
      {
        cwd: REPO,
        env: {
          PATH: process.env.PATH ?? '',
          ...baseEnv,
          LOOKOUT_BIND_ADDRESS: bindAddress,
          LOOKOUT_HOST_ROOT: `${REPO}e2e/fixtures/host`,
          LOOKOUT_FOLDER_SCAN_HOURS: '0',
          // A socket that does not exist: no Docker is ever reached.
          DOCKER_HOST: 'unix:///nonexistent/pen-test-i1/docker.sock',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let stopping: NodeJS.Timeout | undefined;
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      // Give anything logged just after listening a moment, then stop.
      if (!stopping && output.includes('Server listening')) {
        stopping = setTimeout(() => child.kill('SIGTERM'), 500);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(deadline);
      clearTimeout(stopping);
      resolve({ lines: output.split('\n').filter(Boolean), exitCode });
    });
  });
}

/** pino's level for a JSON log line, or 50 for plain text (main.ts's refusal is stderr). */
function level(line: string): number {
  try {
    return (JSON.parse(line) as { level?: number }).level ?? 0;
  } catch {
    return 50;
  }
}

/**
 * Whether the startup log warns about, or refuses, the bind address: a warning or worse
 * that names LOOKOUT_BIND_ADDRESS or the interfaces it exposes. Docker's own "connect
 * ENOENT" warning (the socket here does not exist) does not count.
 */
const warnsAboutBind = ({ lines }: Startup) =>
  lines.some(
    (line) =>
      level(line) >= 40 && /LOOKOUT_BIND_ADDRESS|every interface|all interfaces|public/i.test(line),
  );

/** Addresses ADR-0008 and the README say never to bind: every interface, or a public one. */
const EXPOSED = ['0.0.0.0', '::', '203.0.113.7'];

describe('I1 H10: binding every interface, or a public address', () => {
  for (const address of EXPOSED) {
    it(`warns or refuses at start when LOOKOUT_BIND_ADDRESS is ${address}`, async () => {
      expect(warnsAboutBind(await startLookout(address))).toBe(true);
    });

    it(`${address} starts, and warns naming LOOKOUT_BIND_ADDRESS (regression)`, async () => {
      const startup = await startLookout(address);
      expect(startup.lines.some((line) => line.includes('Server listening'))).toBe(true);
      expect(warnsAboutBind(startup)).toBe(true);
    });
  }

  it('says nothing about the bind address when it is loopback (the default)', async () => {
    const startup = await startLookout('127.0.0.1');
    expect(
      startup.lines.some((line) => line.includes('Server listening at http://127.0.0.1')),
    ).toBe(true);
    expect(warnsAboutBind(startup)).toBe(false);
  });

  it('accepts any IP address, public ones included, as config (the warning is at start, #122)', () => {
    for (const address of EXPOSED) {
      expect(loadConfig({ ...baseEnv, LOOKOUT_BIND_ADDRESS: address }).bindAddress).toBe(address);
    }
  });
});

describe('I1: configuration fails closed — each variable unset in turn', () => {
  it('refuses to start without LOOKOUT_PASSWORD_HASH, naming it', () => {
    expect(() => loadConfig({ LOOKOUT_SESSION_SECRET: SECRET })).toThrow(/LOOKOUT_PASSWORD_HASH/);
  });

  it('refuses to start without LOOKOUT_SESSION_SECRET, naming it', () => {
    expect(() => loadConfig({ LOOKOUT_PASSWORD_HASH: TEST_PASSWORD_HASH })).toThrow(
      /LOOKOUT_SESSION_SECRET/,
    );
  });

  it('treats an empty value (as .env.example leaves them) as unset', () => {
    expect(() => loadConfig({ LOOKOUT_PASSWORD_HASH: '', LOOKOUT_SESSION_SECRET: '  ' })).toThrow(
      ConfigError,
    );
  });

  it('falls back to 127.0.0.1 when LOOKOUT_BIND_ADDRESS is unset, and refuses a non-address', () => {
    expect(loadConfig(baseEnv).bindAddress).toBe('127.0.0.1');
    expect(() => loadConfig({ ...baseEnv, LOOKOUT_BIND_ADDRESS: 'lookout.lan' })).toThrow(
      /LOOKOUT_BIND_ADDRESS/,
    );
  });

  it('every other variable has a default: unsetting each one alone still starts', () => {
    const optional = [...read('compose.yaml').matchAll(/^\s+(LOOKOUT_\w+): \$\{\1:-/gm)].map(
      (m) => m[1]!,
    );
    expect(optional.length).toBeGreaterThan(10);
    for (const name of optional) {
      expect(() => loadConfig({ ...baseEnv, [name]: undefined }), name).not.toThrow();
    }
  });

  it("compose.yaml refuses to start without the hash, the secret, the bind address or Docker's group", () => {
    const text = read('compose.yaml');
    for (const name of [
      'LOOKOUT_PASSWORD_HASH',
      'LOOKOUT_SESSION_SECRET',
      'LOOKOUT_BIND_ADDRESS',
      'DOCKER_GID',
    ]) {
      expect(text, name).toMatch(new RegExp(`\\$\\{${name}:\\?`));
    }
  });
});

describe('I1: configuration fails closed — weak values', () => {
  const refused = (secret: string) =>
    expect(() => loadConfig({ ...baseEnv, LOOKOUT_SESSION_SECRET: secret })).toThrow(
      /LOOKOUT_SESSION_SECRET/,
    );

  it('refuses a short secret', () => refused('q3Vt8pZ1sKx0mW7eRb2LyN5hGd9cJf4'));
  it('refuses a repeated-character secret', () => refused('a'.repeat(64)));
  it('refuses a short pattern repeated', () => refused('abc123'.repeat(8)));
  it('refuses a placeholder secret', () => refused('changeme-to-a-random-value-0123456789'));

  it('never echoes a refused secret', () => {
    const secret = 'changeme-to-a-random-value-0123456789';
    try {
      loadConfig({ ...baseEnv, LOOKOUT_SESSION_SECRET: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('refuses a password hash that is not Argon2id (an .env.example value, plain text, bcrypt)', () => {
    for (const hash of ['', 'password', '$2b$12$abcdefghijklmnopqrstuuJ0bqKkM0XwZr7oVvK1sPq2']) {
      expect(() => loadConfig({ ...baseEnv, LOOKOUT_PASSWORD_HASH: hash }), hash).toThrow(
        ConfigError,
      );
    }
  });

  /** A real Argon2id hash with the least cost parsePasswordHash allows: 8 KiB, one pass. */
  const CHEAP_HASH =
    '$argon2id$v=19$m=8,t=1,p=1$bWFkZS11cC1zYWx0$bWFkZS11cC1oYXNoLWZvci1wZW4tdGVzdA';

  it('warns or refuses an Argon2id hash far below the OWASP baseline (m=8, t=1)', () => {
    expect(() => loadConfig({ ...baseEnv, LOOKOUT_PASSWORD_HASH: CHEAP_HASH })).toThrow(
      /LOOKOUT_PASSWORD_HASH/,
    );
  });

  it('an Argon2id hash at 8 KiB and one pass is refused, never echoed (regression)', () => {
    let message = '';
    try {
      loadConfig({ ...baseEnv, LOOKOUT_PASSWORD_HASH: CHEAP_HASH });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/LOOKOUT_PASSWORD_HASH is too cheap/);
    expect(message).not.toContain('bWFkZS11cC1oYXNo');
  });
});

/** The block of one service in a Compose file, by its two-space indented key. */
function service(file: string, name: string): string {
  const text = read(file);
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `${file} has no service ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n|\n\S/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("I1: Lookout's own service in compose.yaml", () => {
  const lookout = () => service('compose.yaml', 'lookout');

  it('runs with network_mode: host (ADR-0003, a documented decision)', () => {
    expect(lookout()).toMatch(/^\s+network_mode: host$/m);
  });

  it("adds only the Docker socket's group (README, Running as non-root)", () => {
    expect(lookout()).toMatch(/group_add:\n\s+- \$\{DOCKER_GID:\?/);
  });

  it('is never privileged, never shares the Host PID namespace, and mounts / read-only', () => {
    expect(lookout()).not.toMatch(/^\s+(privileged|pid|cap_add|user|ipc|userns_mode):/m);
    expect(lookout()).toMatch(/- \/:\/host:ro,rslave$/m);
  });

  it('drops every capability, forbids new privileges and runs on a read-only root', () => {
    expect(lookout()).toMatch(/cap_drop:\n\s+- ALL/);
    expect(lookout()).toMatch(/no-new-privileges:true/);
    expect(lookout()).toMatch(/^\s+read_only: true$/m);
  });

  it("is hardened like its proxy's service: cap_drop, security_opt and read_only (regression)", () => {
    expect(lookout()).toMatch(/cap_drop:\n\s+- ALL/);
    expect(lookout()).toMatch(/security_opt:\n\s+- no-new-privileges:true/);
    expect(lookout()).toMatch(/^\s+read_only: true$/m);
    const proxy = service('compose.socket-proxy.yaml', 'docker-proxy');
    expect(proxy).toMatch(/cap_drop:\n\s+- ALL/);
    expect(proxy).toMatch(/no-new-privileges:true/);
    expect(proxy).toMatch(/^\s+read_only: true$/m);
  });

  // The figure is X1's (#69) and X1b's (#73); I1 only records that none is set.
  it("sets a mem_limit on Lookout's own service (X1's figure)", () => {
    expect(lookout()).toMatch(/^\s+mem_limit: \S+$/m);
  });

  it("sets X1b's 256m on Lookout, and keeps the proxy's 32m (regression)", () => {
    expect(lookout()).toMatch(/^\s+mem_limit: 256m$/m);
    expect(service('compose.socket-proxy.yaml', 'docker-proxy')).toMatch(/mem_limit: 32m/);
  });

  it('with the socket proxy, takes away the socket and the Docker group', () => {
    const lookoutOverride = service('compose.socket-proxy.yaml', 'lookout');
    expect(lookoutOverride).toMatch(/group_add: !reset \[\]/);
    expect(lookoutOverride).toMatch(/volumes: !override\n\s+- \/:\/host:ro,rslave\n/);
    expect(lookoutOverride).not.toMatch(/\/var\/run\/docker\.sock/);
    // Only the proxy's own socket (#101).
    expect(lookoutOverride).toMatch(/DOCKER_HOST: unix:\/\/\/run\/lookout-docker\/docker\.sock/);
  });
});

describe("I1: Lookout's Image (Dockerfile)", () => {
  const dockerfile = () => read('Dockerfile');

  it('pins every base Image by tag and digest', () => {
    const froms = [...dockerfile().matchAll(/^FROM (\S+)/gm)].map((m) => m[1]!);
    const external = froms.filter((from) => from.includes(':') || from.includes('@'));
    expect(external.length).toBeGreaterThanOrEqual(2);
    for (const from of external) expect(from).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('runs as lookout, UID and GID 65532, a user no Host account uses, set last (#106)', () => {
    const users = [...dockerfile().matchAll(/^USER (\S+)/gm)].map((m) => m[1]);
    expect(users).toEqual(['65532:65532']);
    const runtime = dockerfile().slice(dockerfile().lastIndexOf('\nFROM '));
    expect(runtime.indexOf('\nUSER 65532:65532')).toBeGreaterThan(runtime.lastIndexOf('\nRUN '));
    expect(runtime).toMatch(/adduser -S -D -H -u 65532 -G lookout/);
  });

  it('removes npm, npx, corepack and yarn from the runtime Image', () => {
    const runtime = dockerfile().slice(dockerfile().lastIndexOf('\nFROM '));
    for (const path of [
      '/usr/local/lib/node_modules',
      '/usr/local/bin/npm',
      '/usr/local/bin/npx',
      '/usr/local/bin/corepack',
    ]) {
      expect(runtime).toContain(path);
    }
    expect(runtime).toMatch(/rm -rf \/usr\/local\/lib\/node_modules/);
  });

  it("copies the app in as root-owned files (no --chown), so Lookout's user cannot change it", () => {
    expect(dockerfile()).not.toMatch(/--chown/);
  });
});

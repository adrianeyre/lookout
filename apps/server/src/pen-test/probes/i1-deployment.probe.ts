/**
 * I1 (#70) against the pen-test deployment, in the configuration that is running: what the
 * shipped Compose files give Lookout's own Container (and the proxy's), what the round's
 * Image is, and what Lookout says at start for each bind address and each missing or weak
 * variable. The in-process half is i1-configuration.test.ts.
 *
 * Everything runs inside the throwaway daemon: `docker inspect` and `docker exec` on its
 * Containers, and one-off runs of the round's Image with `--network none` (so even a
 * Lookout bound to every interface has only its own loopback) and Docker pointed at a socket
 * that does not exist. Every secret here is made up.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, hashPassword } from '../../auth/password.ts';
import {
  LOOKOUT_IMAGE,
  dindDocker,
  inDind,
  runningConfiguration,
  type Configuration,
} from '../deployment.ts';

let configuration: Configuration;
beforeAll(() => {
  const running = runningConfiguration();
  if (!running) throw new Error('The pen-test deployment is down: pnpm pen-test:up');
  configuration = running;
});

interface Inspected {
  Config: { User: string };
  HostConfig: {
    NetworkMode: string;
    Privileged: boolean;
    PidMode: string;
    CapAdd: string[] | null;
    CapDrop: string[] | null;
    ReadonlyRootfs: boolean;
    SecurityOpt: string[] | null;
    Memory: number;
    GroupAdd: string[] | null;
  };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
}

const inspect = (name: string) =>
  (JSON.parse(dindDocker(['inspect', name]) ?? '[]') as Inspected[])[0]!;

const shape = (c: Inspected) => ({
  user: c.Config.User,
  networkMode: c.HostConfig.NetworkMode,
  privileged: c.HostConfig.Privileged,
  pidMode: c.HostConfig.PidMode,
  capAdd: c.HostConfig.CapAdd ?? [],
  capDrop: c.HostConfig.CapDrop ?? [],
  readonlyRootfs: c.HostConfig.ReadonlyRootfs,
  securityOpt: c.HostConfig.SecurityOpt ?? [],
  memory: c.HostConfig.Memory,
  groupAdd: c.HostConfig.GroupAdd ?? [],
  mounts: c.Mounts.map((m) => `${m.Source}:${m.Destination}:${m.RW ? 'rw' : 'ro'}`).sort(),
});

describe("I1: Lookout's own Container, as the shipped Compose files make it", () => {
  it('is UID 65532 (#106), host network, unprivileged, its own PID namespace, / read-only', () => {
    const lookout = shape(inspect('lookout'));
    console.log(`[${configuration}] lookout: ${JSON.stringify(lookout)}`);
    expect(lookout.user).toBe('65532:65532');
    expect(lookout.networkMode).toBe('host');
    expect(lookout.privileged).toBe(false);
    expect(lookout.pidMode).toBe('');
    expect(lookout.capAdd).toEqual([]);
    expect(lookout.mounts).toContain('/pen-test/host-root:/host:ro');
    if (configuration === 'default') {
      expect(lookout.groupAdd.length).toBe(1);
      expect(lookout.mounts).toContain('/var/run/docker.sock:/var/run/docker.sock:rw');
    } else {
      expect(lookout.groupAdd).toEqual([]);
      expect(lookout.mounts.join('\n')).not.toContain('/var/run/docker.sock');
      // Only the proxy's socket, in its own volume (#101).
      expect(lookout.mounts.some((m) => m.endsWith(':/run/lookout-docker:rw'))).toBe(true);
    }
  });

  it('drops every capability, forbids new privileges, runs read-only, with a memory limit', () => {
    const lookout = shape(inspect('lookout'));
    expect(lookout.capDrop).toContain('ALL');
    expect(lookout.securityOpt).toContain('no-new-privileges:true');
    expect(lookout.readonlyRootfs).toBe(true);
    expect(lookout.memory).toBeGreaterThan(0);
  });

  it('keeps no capability, never gains privileges, cannot write its root, and is held to 256 MiB (regression)', () => {
    const lookout = shape(inspect('lookout'));
    expect(lookout.capDrop).toEqual(['ALL']);
    expect(lookout.securityOpt).toEqual(['no-new-privileges:true']);
    expect(lookout.readonlyRootfs).toBe(true);
    expect(lookout.memory).toBe(256 * 1024 * 1024);
    const bounding = dindDocker(['exec', 'lookout', 'sh', '-c', 'grep ^CapBnd /proc/self/status']);
    expect(bounding).toMatch(/CapBnd:\s*0+$/m);
    const written = dindDocker(['exec', 'lookout', 'sh', '-c', 'touch /tmp/i1 && echo WROTE'], {
      allowFail: true,
    });
    expect(written ?? '').not.toContain('WROTE');
  });

  it('as UID 65532 it holds no effective capability and finds no setuid or setgid file', () => {
    const status = dindDocker(['exec', 'lookout', 'sh', '-c', 'grep ^Cap /proc/self/status']) ?? '';
    const effective = /^CapEff:\s*([0-9a-f]+)$/m.exec(status)?.[1];
    const bounding = /^CapBnd:\s*([0-9a-f]+)$/m.exec(status)?.[1];
    console.log(`[${configuration}] lookout CapEff=${effective} CapBnd=${bounding}`);
    expect(BigInt(`0x${effective}`)).toBe(0n);
    const setuid = dindDocker([
      'exec',
      'lookout',
      'sh',
      '-c',
      'find / -xdev -type f \\( -perm -4000 -o -perm -2000 \\) 2>/dev/null; true',
    ]);
    expect(setuid?.trim()).toBe('');
  });

  it('cannot change its own code, which root owns', () => {
    const written = dindDocker(
      ['exec', 'lookout', 'sh', '-c', 'touch /app/apps/server/dist/main.js && echo WROTE'],
      { allowFail: true },
    );
    expect(written ?? '').not.toContain('WROTE');
  });

  it('has no npm, npx, corepack or yarn', () => {
    const found = dindDocker([
      'exec',
      'lookout',
      'sh',
      '-c',
      'for t in npm npx corepack yarn; do command -v $t; done; ls /usr/local/lib/node_modules 2>/dev/null; true',
    ]);
    expect(found?.trim()).toBe('');
  });

  it("the socket proxy's own Container is hardened as compose.socket-proxy.yaml says", () => {
    if (configuration !== 'socket-proxy') return;
    const proxy = shape(inspect('lookout-docker-proxy'));
    console.log(`[${configuration}] lookout-docker-proxy: ${JSON.stringify(proxy)}`);
    // No network at all since #101: it listens only on its Unix socket.
    expect(proxy.networkMode).toBe('none');
    expect(proxy.user).toBe('65533:65532');
    expect(proxy.capDrop).toContain('ALL');
    expect(proxy.securityOpt).toContain('no-new-privileges:true');
    expect(proxy.readonlyRootfs).toBe(true);
    expect(proxy.memory).toBe(32 * 1024 * 1024);
    expect(proxy.mounts).toContain('/var/run/docker.sock:/var/run/docker.sock:ro');
    expect(proxy.mounts.some((m) => m.endsWith(':/run/lookout-docker:rw'))).toBe(true);
  });
});

/** Made up, and never the deployment's own. */
const SECRET = 'q3Vt8pZ1sKx0mW7eRb2LyN5hGd9cJf4A';
let hash: string;
beforeAll(async () => {
  // The minimum cost Lookout accepts (#124).
  hash = await hashPassword('made-up pen-test I1 password', DEFAULT_PARAMS);
});

/**
 * Runs the round's Image once, with no network and no Docker, for a few seconds, and
 * returns everything it printed. Never touches the running deployment's Lookout.
 */
function runOnce(env: Record<string, string | undefined>): string {
  const args = ['run', '--rm', '--network', 'none', '--entrypoint', 'sh'];
  const full: Record<string, string | undefined> = {
    LOOKOUT_PASSWORD_HASH: hash,
    LOOKOUT_SESSION_SECRET: SECRET,
    LOOKOUT_BIND_ADDRESS: '127.0.0.1',
    LOOKOUT_HOST_ROOT: '/tmp',
    LOOKOUT_FOLDER_SCAN_HOURS: '0',
    DOCKER_HOST: 'unix:///nonexistent/docker.sock',
    ...env,
  };
  for (const [key, value] of Object.entries(full)) {
    if (value !== undefined) args.push('--env', `${key}=${value}`);
  }
  args.push(LOOKOUT_IMAGE, '-c', 'timeout 4 node apps/server/dist/main.js 2>&1; echo "EXIT $?"');
  return dindDocker(args) ?? '';
}

const warnsAboutBind = (output: string) =>
  output
    .split('\n')
    .some(
      (line) =>
        /"level":(40|50|60)|cannot start/.test(line) &&
        /LOOKOUT_BIND_ADDRESS|every interface|all interfaces|public/i.test(line),
    );

describe("I1 H10: the round's Image at start, for each bind address", () => {
  for (const address of ['0.0.0.0', '::']) {
    it(`warns or refuses when bound to ${address}`, () => {
      expect(warnsAboutBind(runOnce({ LOOKOUT_BIND_ADDRESS: address }))).toBe(true);
    });

    it(`${address} starts and warns naming LOOKOUT_BIND_ADDRESS (regression)`, () => {
      const output = runOnce({ LOOKOUT_BIND_ADDRESS: address });
      console.log(
        `[${configuration}] ${address}: ${output
          .split('\n')
          .filter((l) => l.includes('Server listening'))
          .join(' | ')}`,
      );
      expect(output).toContain('Server listening');
      expect(warnsAboutBind(output)).toBe(true);
    });
  }
});

describe("I1: the round's Image fails closed", () => {
  for (const name of ['LOOKOUT_PASSWORD_HASH', 'LOOKOUT_SESSION_SECRET']) {
    it(`refuses to start without ${name}, naming it`, () => {
      const output = runOnce({ [name]: undefined });
      expect(output).toContain('Lookout cannot start');
      expect(output).toContain(name);
      expect(output).not.toContain('Server listening');
    });
  }

  for (const [why, secret] of [
    ['short', 'q3Vt8pZ1sKx0mW7e'],
    ['one character repeated', 'a'.repeat(48)],
    ['a placeholder', 'changeme-changeme-0123456789abcdefXYZ'],
  ] as const) {
    it(`refuses a ${why} session secret without echoing it`, () => {
      const output = runOnce({ LOOKOUT_SESSION_SECRET: secret });
      expect(output).toContain('LOOKOUT_SESSION_SECRET');
      expect(output).not.toContain('Server listening');
      expect(output).not.toContain(secret);
    });
  }

  it('refuses a password hash below the minimum cost without echoing it (#124)', async () => {
    const cheap = await hashPassword('made-up pen-test I1 password', {
      memory: 8192,
      passes: 1,
      parallelism: 1,
    });
    const output = runOnce({ LOOKOUT_PASSWORD_HASH: cheap });
    expect(output).toContain('LOOKOUT_PASSWORD_HASH is too cheap');
    expect(output).not.toContain('Server listening');
    expect(output).not.toContain(cheap.split('$').at(-1));
  });

  it('compose.yaml refuses to start without each required variable', () => {
    const required = [
      'LOOKOUT_PASSWORD_HASH',
      'LOOKOUT_SESSION_SECRET',
      'LOOKOUT_BIND_ADDRESS',
      'DOCKER_GID',
    ];
    const all = {
      LOOKOUT_PASSWORD_HASH: 'x',
      LOOKOUT_SESSION_SECRET: 'x',
      LOOKOUT_BIND_ADDRESS: '127.0.0.1',
      DOCKER_GID: '2375',
    };
    for (const missing of required) {
      const env = Object.entries(all)
        .filter(([key]) => key !== missing)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      // A scratch directory inside the daemon, with the shipped compose.yaml and a .env that
      // lacks one variable; `config` only renders the file, it starts nothing.
      const output = inDind(
        [
          'sh',
          '-c',
          'd=$(mktemp -d) && cp /pen-test/lookout/compose.yaml "$d"/ && cat > "$d"/.env && cd "$d" && docker compose config --quiet 2>&1; echo "EXIT $?"; rm -rf "$d"',
        ],
        { input: `${env}\n` },
      );
      expect(output, missing).toContain(missing);
      expect(output, missing).not.toContain('EXIT 0');
    }
  });
});

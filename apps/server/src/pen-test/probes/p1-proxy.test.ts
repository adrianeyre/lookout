/**
 * Pen-test scope issue P1 (#66): the socket proxy and the Host's loopback (H2), probed
 * in-process from the shipped compose.socket-proxy.yaml. Findings are in
 * docs/pen-test/findings/P1.md; the proof against the real proxy is p1-proxy.probe.ts in
 * `pnpm pen-test:probe`.
 *
 * The allowlist probes model wollomatic/socket-proxy's matching as the shipped file's own
 * comment states it ("each pattern must match the whole path"): the pattern anchored at
 * both ends, tested against the request's percent-decoded path with the query left out.
 * A model can only be wrong in one direction that matters (passing what the real proxy
 * refuses would be harmless), and the deployment probe sends every trick below to the
 * real proxy. While a gap is open an `it.fails` states the property that should hold
 * beside a `today_…` test pinning what happens now; once fixed they became an `it` and a
 * `(regression)` test (#101).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPOSE = readFileSync(
  fileURLToPath(new URL('../../../../../compose.socket-proxy.yaml', import.meta.url)),
  'utf8',
);

/** The proxy service's `-flag=value` command arguments. */
function proxyFlags(): Map<string, string> {
  const flags = new Map<string, string>();
  for (const match of COMPOSE.matchAll(/^\s*- -([a-zA-Z]+)(?:=(.*))?$/gm)) {
    flags.set(match[1]!, (match[2] ?? '').trim());
  }
  return flags;
}

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'HEAD';

/** The shipped allowlist, anchored as wollomatic anchors it. */
function allowlist(): Partial<Record<Method, RegExp>> {
  const allow: Partial<Record<Method, RegExp>> = {};
  for (const [flag, value] of proxyFlags()) {
    const method = /^allow(GET|POST|DELETE|PUT|HEAD)$/.exec(flag)?.[1] as Method | undefined;
    if (method) allow[method] = new RegExp(`^(?:${value})$`);
  }
  return allow;
}

/**
 * Whether the modelled proxy passes a request line's target: the path before `?`,
 * percent-decoded (as Go's `URL.Path` is), never normalised. A malformed escape is a 400.
 */
function proxyPasses(method: Method, target: string): boolean {
  const rawPath = target.split('?')[0]!;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  return allowlist()[method]?.test(path) ?? false;
}

describe('P1 H2: who can reach the proxy', () => {
  it('only Lookout can reach the proxy: a socket only its Container mounts, not a loopback port', () => {
    const flags = proxyFlags();
    // wollomatic listens on a Unix socket instead of TCP (#101); nothing on the Host's
    // loopback reaches it.
    expect(flags.get('proxysocketendpoint')).toBe('/run/lookout-docker/docker.sock');
    expect(flags.has('listenip')).toBe(false);
    // 0660 (432): the proxy's user and its group, Lookout's 65532, and no one else.
    expect(flags.get('proxysocketendpointfilemode')).toBe('432');
    expect(COMPOSE).toMatch(/docker-proxy:[\s\S]*?user: '65533:65532'/);
    expect(COMPOSE).toMatch(/DOCKER_HOST: unix:\/\/\/run\/lookout-docker\/docker\.sock/);
    // The socket's directory is a tmpfs volume only root and group 65532 may enter.
    expect(COMPOSE).toMatch(
      /docker-proxy-socket:\s+driver: local[\s\S]*?o: uid=0,gid=65532,mode=0770/,
    );
  });

  it("no TCP listener on the Host's loopback, open to every process there (regression)", () => {
    const flags = proxyFlags();
    expect(COMPOSE).not.toMatch(/docker-proxy:[\s\S]*?network_mode: host[\s\S]*?lookout:/);
    expect(COMPOSE).toMatch(/docker-proxy:[\s\S]*?network_mode: none/);
    expect(flags.has('listenip')).toBe(false);
    expect(flags.has('proxyport')).toBe(false);
    expect(flags.has('allowfrom')).toBe(false);
    expect(COMPOSE).not.toMatch(/DOCKER_HOST: tcp:/);
  });

  it('listens on no interface at all: no address, no port, no network (sound)', () => {
    const flags = proxyFlags();
    expect([...flags.keys()].filter((flag) => /listenip|proxyport|allowfrom/.test(flag))).toEqual(
      [],
    );
    expect(COMPOSE).toMatch(/docker-proxy:[\s\S]*?network_mode: none/);
  });
});

describe('P1 H2: the allowlist bounds the path, not the query', () => {
  // Not fixed: wollomatic matches the path only. Since #101 only Lookout reaches the proxy,
  // and ADR-0011 accepts the rest until 25 February 2027 (#102).
  it.fails('a forced remove of a running Container with its volumes is refused', () => {
    // Lookout itself only ever sends force=false&v=false (K1).
    expect(proxyPasses('DELETE', '/v1.47/containers/victim?force=true&v=true')).toBe(false);
  });

  it('today_ DELETE /containers/<id>?force=true&v=true matches the DELETE pattern', () => {
    expect(proxyPasses('DELETE', '/v1.47/containers/victim?force=true&v=true')).toBe(true);
    expect(proxyPasses('DELETE', '/containers/victim?force=1&v=1&link=false')).toBe(true);
  });

  it('ADR-0011 accepts it, with the date the acceptance stops being true (documented decision)', () => {
    const adr = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../docs/architectural-decision-record/0011-optional-docker-socket-proxy.md',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    expect(adr).toMatch(/force=true/);
    expect(adr).toMatch(/25 February 2027/);
    expect(COMPOSE).not.toMatch(/Exactly the endpoints in ADR-0005/);
  });
});

describe('P1 H2: the allowlist refuses everything outside ADR-0011', () => {
  const outside: [Method, string][] = [
    ['POST', '/containers/create'],
    ['POST', '/v1.47/containers/victim/exec'],
    ['POST', '/exec/abc/start'],
    ['POST', '/images/create?fromImage=alpine'],
    ['POST', '/build'],
    ['POST', '/containers/victim/kill'],
    ['POST', '/containers/victim/update'],
    ['POST', '/containers/victim/attach'],
    ['POST', '/containers/victim/rename?name=x'],
    ['PUT', '/containers/victim/archive?path=/'],
    ['GET', '/containers/victim/archive?path=/'],
    ['GET', '/containers/victim/export'],
    ['GET', '/containers/victim/top'],
    ['GET', '/info'],
    ['GET', '/version'],
    ['GET', '/volumes'],
    ['GET', '/networks'],
    ['GET', '/secrets'],
    ['GET', '/images/json'],
    ['DELETE', '/images/alpine'],
    ['DELETE', '/volumes/data'],
    ['POST', '/containers/prune'],
  ];

  for (const [method, target] of outside) {
    it(`refuses ${method} ${target} (sound)`, () => {
      expect(proxyPasses(method, target)).toBe(false);
    });
  }

  it('passes every endpoint ADR-0011 lists, so the model is the shipped allowlist (sound)', () => {
    const inside: [Method, string][] = [
      ['GET', '/_ping'],
      ['GET', '/v1.47/events?filters=%7B%7D'],
      ['GET', '/containers/json?all=1'],
      ['GET', '/containers/victim/json'],
      ['GET', '/containers/victim/logs?follow=1'],
      ['GET', '/containers/victim/stats?stream=0'],
      ['GET', '/images/sha256:abc/json'],
      ['POST', '/containers/victim/start'],
      ['POST', '/containers/victim/stop'],
      ['POST', '/containers/victim/restart'],
      ['DELETE', '/containers/victim?force=false&v=false'],
    ];
    for (const [method, target] of inside) expect(proxyPasses(method, target), target).toBe(true);
  });
});

describe('P1 H2: path tricks against the allowlist', () => {
  // Each one aims past the allowlist at an endpoint it refuses (exec, create, info).
  const tricks: [Method, string][] = [
    ['POST', '//containers/create'],
    ['POST', '/containers%2Fcreate'],
    ['POST', '/v1.41/containers/victim/json/../exec'],
    ['POST', '/v1.41/containers/victim/start/../exec'],
    ['POST', '/v1.41/containers/victim/start/%2e%2e/exec'],
    ['GET', '/images/..%2f../json'],
    ['GET', '/images/..%2f..%2finfo/json'],
    ['GET', '/images/x%2f..%2f..%2fcontainers%2fvictim%2fexport/json'],
    ['POST', '/containers/victim/start/'],
    ['DELETE', '/containers/victim/'],
    ['GET', '/containers/json/'],
    ['POST', '/containers/victim%2fexec'],
    ['POST', '/containers/victim/start%00/exec'],
    ['GET', '/v1.41/containers/../info'],
    ['GET', '/v1.41/_ping/../info'],
  ];

  for (const [method, target] of tricks) {
    it(`refuses ${method} ${target} (sound)`, () => {
      expect(proxyPasses(method, target)).toBe(false);
    });
  }

  it('lets a Container name with dots through, which is Docker grammar, not a traversal (sound)', () => {
    // `..` is a legal name under the pattern; Docker resolves it as a name or answers 404.
    expect(proxyPasses('GET', '/containers/a..b/json')).toBe(true);
    expect(proxyPasses('GET', '/containers/../json')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { FAKE_MARKER, PLAN } from './plan.ts';

/** Docker's Container name grammar. */
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

describe('the pen-test fixture plan (E2)', () => {
  it('has every fixture the PRD asks for', () => {
    const handles = [...PLAN.shipped, ...PLAN.containers].map((f) => f.handle);
    expect(handles).toEqual(
      expect.arrayContaining([
        'lookout',
        'socket-proxy',
        'victim',
        'shop-web',
        'shop-worker',
        'stopped',
        'hostile',
        'site-healthy',
        'site-expired',
        'site-redirect',
      ]),
    );
    expect(PLAN.sites.map((s) => s.handle).sort()).toEqual(['expired', 'healthy', 'redirect']);
    expect(PLAN.hostRoot.source).toBe('e2e/fixtures/host');
    expect(PLAN.password).toBe('generated per deployment');
  });

  it('labels Lookout and the socket proxy as lookout.self', () => {
    for (const shipped of PLAN.shipped) expect(shipped.labels['lookout.self']).toBe('true');
  });

  it('marks every secret as made up, and every secret is really in its fixture', () => {
    const victim = PLAN.containers.find((c) => c.handle === 'victim')!;
    expect(victim.secrets.length).toBeGreaterThanOrEqual(6);
    for (const fixture of PLAN.containers) {
      const text = JSON.stringify(fixture);
      for (const secret of fixture.secrets) {
        expect(secret, fixture.handle).toContain(FAKE_MARKER);
        expect(text, secret).toContain(JSON.stringify(secret).slice(1, -1));
      }
    }
    // Secrets in each place H8 names: environment, command, labels and a mount.
    expect(Object.values(victim.env).some((v) => v.includes(FAKE_MARKER))).toBe(true);
    expect(victim.command.some((v) => v.includes(FAKE_MARKER))).toBe(true);
    expect(Object.values(victim.labels).some((v) => v.includes(FAKE_MARKER))).toBe(true);
    expect(victim.mounts.some((m) => m.source.includes(FAKE_MARKER))).toBe(true);
  });

  it('holds nothing that looks like a secret outside the made-up ones', () => {
    const suspicious = /(password|secret|token|key|pass)/i;
    for (const fixture of PLAN.containers) {
      for (const [name, value] of Object.entries(fixture.env)) {
        if (suspicious.test(name)) expect(value, name).toContain(FAKE_MARKER);
      }
    }
  });

  it('gives the Hostile Container SSRF, markup, escapes and long values', () => {
    const hostile = PLAN.containers.find((c) => c.handle === 'hostile')!;
    const urls = hostile.labels['lookout.url']!;
    expect(urls).toContain('127.0.0.1:2375');
    expect(urls).toContain('169.254.169.254');
    const values = [...Object.values(hostile.labels), ...Object.values(hostile.env)].join('\n');
    expect(values).toContain('<img');
    expect(values).toContain('\u001b[');
    expect(values).toContain('‮');
    expect(Math.max(...Object.values(hostile.labels).map((v) => v.length))).toBeGreaterThan(60_000);
    expect(hostile.command[0]).toBe('hostile-logs');
  });

  it('describes the values that would exhaust memory by size, and does not create them', () => {
    expect(PLAN.oversized.length).toBeGreaterThan(0);
    const largest = Math.max(...PLAN.oversized.map((o) => o.bytes));
    expect(largest).toBeGreaterThan(64 * 1024 * 1024);
    // Nothing the loader creates is anywhere near that size.
    expect(JSON.stringify(PLAN.containers).length).toBeLessThan(1024 * 1024);
  });

  it('gives each Container a valid, unique Docker name and publishes only distinct ports', () => {
    const names = PLAN.containers.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(DOCKER_NAME);
    const ports = PLAN.containers.flatMap((c) => c.ports.map((p) => p.hostPort));
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('serves every Hosted Site from a fixture that names it', () => {
    for (const site of PLAN.sites) {
      const server = PLAN.containers.find((c) => c.handle === site.servedBy);
      expect(server?.labels['lookout.url'], site.handle).toBe(site.url);
    }
  });
});

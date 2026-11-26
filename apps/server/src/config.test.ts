import { describe, expect, it } from 'vitest';
import { CONFIG_TEST_PASSWORD_HASH, TEST_PASSWORD_HASH } from '../test/helpers.ts';
import { bindAddressWarning, ConfigError, loadConfig } from './config.ts';

/** As random as `openssl rand -base64 32` (a repeated character is refused, #85). */
const SECRET = 'q3Vt8pZ1sKx0mW7eRb2LyN5hGd9cJf4A';
const base = { LOOKOUT_PASSWORD_HASH: CONFIG_TEST_PASSWORD_HASH, LOOKOUT_SESSION_SECRET: SECRET };

describe('loadConfig', () => {
  it('uses the PRD defaults', () => {
    expect(loadConfig(base)).toEqual({
      bindAddress: '127.0.0.1',
      port: 7777,
      hostRoot: '/host',
      sampleIntervalMs: 2000,
      liveWindowMinutes: 15,
      warnPercent: 80,
      criticalPercent: 90,
      passwordHash: CONFIG_TEST_PASSWORD_HASH,
      sessionSecret: SECRET,
      sessionIdleMs: 7 * 24 * 60 * 60 * 1000,
      sessionMaxMs: 30 * 24 * 60 * 60 * 1000,
      hostnames: [],
      secureCookie: false,
      sites: [],
      siteCheckIntervalMs: 60_000,
      siteTimeoutMs: 10_000,
      siteSlowMs: 2000,
      tlsWarnDays: 14,
      tlsCriticalDays: 7,
      folderScanHours: 6,
    });
  });

  it('reads how often the largest folders are scanned, 0 for only when asked', () => {
    expect(loadConfig({ ...base, LOOKOUT_FOLDER_SCAN_HOURS: '0' }).folderScanHours).toBe(0);
    expect(loadConfig({ ...base, LOOKOUT_FOLDER_SCAN_HOURS: '24' }).folderScanHours).toBe(24);
    expect(() => loadConfig({ ...base, LOOKOUT_FOLDER_SCAN_HOURS: '200' })).toThrow(
      'LOOKOUT_FOLDER_SCAN_HOURS',
    );
  });

  it('reads the Hosted Site settings', () => {
    const config = loadConfig({
      ...base,
      LOOKOUT_SITES:
        ' https://Shop.Example/ , http://blog.example:8080/path#frag,,https://shop.example/',
      LOOKOUT_SITE_CHECK_INTERVAL_SECONDS: '30',
      LOOKOUT_SITE_TIMEOUT_MS: '5000',
      LOOKOUT_SITE_SLOW_MS: '1500',
      LOOKOUT_TLS_WARN_DAYS: '21',
      LOOKOUT_TLS_CRITICAL_DAYS: '3',
    });
    expect(config).toMatchObject({
      sites: ['https://shop.example/', 'http://blog.example:8080/path'],
      siteCheckIntervalMs: 30_000,
      siteTimeoutMs: 5000,
      siteSlowMs: 1500,
      tlsWarnDays: 21,
      tlsCriticalDays: 3,
    });
  });

  it.each([
    [
      'ftp://files.example/',
      'LOOKOUT_SITES: "ftp://files.example/" uses ftp; only http and https are checked',
    ],
    [
      'file:///etc/passwd',
      'LOOKOUT_SITES: "file:///etc/passwd" uses file; only http and https are checked',
    ],
    ['shop.example', 'LOOKOUT_SITES: "shop.example" is not a valid URL'],
    [
      'https://admin:hunter2@shop.example/',
      'LOOKOUT_SITES: a URL must not contain a user name or password',
    ],
  ])('refuses LOOKOUT_SITES=%s', (sites, message) => {
    let error: unknown;
    try {
      loadConfig({ ...base, LOOKOUT_SITES: sites });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('refuses TLS thresholds in the wrong order and a timeout longer than the interval', () => {
    expect(() =>
      loadConfig({ ...base, LOOKOUT_TLS_WARN_DAYS: '7', LOOKOUT_TLS_CRITICAL_DAYS: '7' }),
    ).toThrow('LOOKOUT_TLS_CRITICAL_DAYS (7) must be lower than LOOKOUT_TLS_WARN_DAYS (7)');
    expect(() =>
      loadConfig({
        ...base,
        LOOKOUT_SITE_CHECK_INTERVAL_SECONDS: '5',
        LOOKOUT_SITE_TIMEOUT_MS: '6000',
      }),
    ).toThrow('must not be longer than LOOKOUT_SITE_CHECK_INTERVAL_SECONDS');
  });

  it('reads every variable', () => {
    const config = loadConfig({
      ...base,
      LOOKOUT_BIND_ADDRESS: '100.64.0.7',
      LOOKOUT_PORT: '8080',
      LOOKOUT_HOST_ROOT: '/mnt/host',
      LOOKOUT_SAMPLE_INTERVAL_MS: '1000',
      LOOKOUT_SESSION_IDLE_DAYS: '1',
      LOOKOUT_SESSION_MAX_DAYS: '14',
      LOOKOUT_HOSTNAMES: 'Server.tailnet.ts.net, lookout.home.arpa.,server.tailnet.ts.net',
      LOOKOUT_LIVE_WINDOW_MINUTES: '5',
      LOOKOUT_WARN_PERCENT: '70',
      LOOKOUT_CRITICAL_PERCENT: '95',
    });
    expect(config).toMatchObject({
      liveWindowMinutes: 5,
      warnPercent: 70,
      criticalPercent: 95,
      bindAddress: '100.64.0.7',
      port: 8080,
      hostRoot: '/mnt/host',
      sampleIntervalMs: 1000,
      sessionIdleMs: 24 * 60 * 60 * 1000,
      sessionMaxMs: 14 * 24 * 60 * 60 * 1000,
      hostnames: ['server.tailnet.ts.net', 'lookout.home.arpa'],
    });
  });

  it('reads LOOKOUT_SECURE_COOKIE as true or false only (#86)', () => {
    expect(loadConfig({ ...base, LOOKOUT_SECURE_COOKIE: 'TRUE' }).secureCookie).toBe(true);
    expect(loadConfig({ ...base, LOOKOUT_SECURE_COOKIE: 'false' }).secureCookie).toBe(false);
    expect(() => loadConfig({ ...base, LOOKOUT_SECURE_COOKIE: 'yes' })).toThrow(
      'LOOKOUT_SECURE_COOKIE must be true or false',
    );
  });

  it('refuses an idle period longer than the session lifetime (#84)', () => {
    expect(() =>
      loadConfig({ ...base, LOOKOUT_SESSION_IDLE_DAYS: '40', LOOKOUT_SESSION_MAX_DAYS: '30' }),
    ).toThrow(
      'LOOKOUT_SESSION_IDLE_DAYS (40) must not be longer than LOOKOUT_SESSION_MAX_DAYS (30)',
    );
    expect(
      loadConfig({ ...base, LOOKOUT_SESSION_IDLE_DAYS: '40', LOOKOUT_SESSION_MAX_DAYS: '40' })
        .sessionMaxMs,
    ).toBe(40 * 24 * 60 * 60 * 1000);
  });

  it.each(['http://lookout.example', 'lookout.example:7777', 'a b', '-bad.example', 'x/y'])(
    'refuses LOOKOUT_HOSTNAMES=%s (#87)',
    (name) => {
      expect(() => loadConfig({ ...base, LOOKOUT_HOSTNAMES: name })).toThrow('LOOKOUT_HOSTNAMES');
    },
  );

  it.each(['0', '65536', '80a', '-1', '7.5', 'http'])('refuses LOOKOUT_PORT=%s', (port) => {
    expect(() => loadConfig({ ...base, LOOKOUT_PORT: port })).toThrow(
      `LOOKOUT_PORT must be a whole number from 1 to 65535 (got "${port}")`,
    );
  });

  it.each([
    ['90', '90'],
    ['95', '90'],
    ['80', '50'],
  ])('refuses LOOKOUT_WARN_PERCENT=%s with LOOKOUT_CRITICAL_PERCENT=%s', (warn, critical) => {
    expect(() =>
      loadConfig({ ...base, LOOKOUT_WARN_PERCENT: warn, LOOKOUT_CRITICAL_PERCENT: critical }),
    ).toThrow(
      `LOOKOUT_WARN_PERCENT (${warn}) must be lower than LOOKOUT_CRITICAL_PERCENT (${critical})`,
    );
  });

  it('refuses a warn threshold that is not lower than the default critical one', () => {
    expect(() => loadConfig({ ...base, LOOKOUT_WARN_PERCENT: '95' })).toThrow(
      /LOOKOUT_WARN_PERCENT \(95\) must be lower than LOOKOUT_CRITICAL_PERCENT \(90\)/,
    );
  });

  it.each(['0', '101', 'x'])('refuses LOOKOUT_CRITICAL_PERCENT=%s', (value) => {
    expect(() => loadConfig({ ...base, LOOKOUT_CRITICAL_PERCENT: value })).toThrow(
      /LOOKOUT_CRITICAL_PERCENT must be a whole number from 1 to 100/,
    );
  });

  it('refuses a Live Window outside 1 to 60 minutes', () => {
    expect(() => loadConfig({ ...base, LOOKOUT_LIVE_WINDOW_MINUTES: '0' })).toThrow(
      /LOOKOUT_LIVE_WINDOW_MINUTES must be a whole number from 1 to 60/,
    );
  });

  it('refuses a bind address that is not an IP address', () => {
    expect(() => loadConfig({ ...base, LOOKOUT_BIND_ADDRESS: 'my-server' })).toThrow(
      /LOOKOUT_BIND_ADDRESS must be an IPv4 or IPv6 address/,
    );
  });

  it('refuses a relative Host root', () => {
    expect(() => loadConfig({ ...base, LOOKOUT_HOST_ROOT: 'host' })).toThrow(/absolute path/);
  });

  it('requires the password hash and session secret', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/LOOKOUT_PASSWORD_HASH is required/);
    expect(() => loadConfig({})).toThrow(/LOOKOUT_SESSION_SECRET is required/);
  });

  it('refuses a session secret shorter than 32 bytes', () => {
    expect(() => loadConfig({ ...base, LOOKOUT_SESSION_SECRET: 'x'.repeat(31) })).toThrow(
      /at least 32 bytes/,
    );
  });

  it('refuses a password hash that is not Argon2id, without echoing it', () => {
    const notAHash = 'plaintext-password';
    let message = '';
    try {
      loadConfig({ ...base, LOOKOUT_PASSWORD_HASH: notAHash });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not a valid Argon2id hash/);
    expect(message).not.toContain(notAHash);
  });

  it('reports every problem at once', () => {
    expect(() => loadConfig({ LOOKOUT_PORT: 'x', LOOKOUT_SAMPLE_INTERVAL_MS: '5' })).toThrow(
      /LOOKOUT_PORT[\s\S]*LOOKOUT_SAMPLE_INTERVAL_MS[\s\S]*LOOKOUT_PASSWORD_HASH[\s\S]*LOOKOUT_SESSION_SECRET/,
    );
  });
});

describe('the password hash cost (#124)', () => {
  it('refuses a hash below OWASP’s baseline, naming the variable and never echoing the hash', () => {
    let message = '';
    try {
      loadConfig({ ...base, LOOKOUT_PASSWORD_HASH: TEST_PASSWORD_HASH });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/LOOKOUT_PASSWORD_HASH is too cheap/);
    expect(message).not.toContain(TEST_PASSWORD_HASH.split('$').at(-1));
  });

  it('accepts each OWASP baseline, and a cheap hash only when a test asks for it', () => {
    for (const params of [
      'm=47104,t=1',
      'm=19456,t=2',
      'm=12288,t=3',
      'm=9216,t=4',
      'm=7168,t=5',
    ]) {
      const hash = CONFIG_TEST_PASSWORD_HASH.replace('m=19456,t=2', params);
      expect(() => loadConfig({ ...base, LOOKOUT_PASSWORD_HASH: hash }), params).not.toThrow();
    }
    expect(
      loadConfig(
        { ...base, LOOKOUT_PASSWORD_HASH: TEST_PASSWORD_HASH },
        { allowCheapPasswordHash: true },
      ).passwordHash,
    ).toBe(TEST_PASSWORD_HASH);
  });
});

describe('bindAddressWarning (#122)', () => {
  it('warns for every interface and for a public address, naming LOOKOUT_BIND_ADDRESS', () => {
    for (const address of ['0.0.0.0', '::', '203.0.113.7', '2001:db8::1', '8.8.8.8']) {
      expect(bindAddressWarning(address), address).toMatch(/LOOKOUT_BIND_ADDRESS/);
    }
  });

  it('says nothing for loopback, private, link-local and Tailscale addresses', () => {
    for (const address of [
      '127.0.0.1',
      '::1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.1.1',
      '100.101.102.103',
      'fd7a:115c:a1e0::1',
      'fe80::1',
      '::ffff:192.168.1.10',
    ]) {
      expect(bindAddressWarning(address), address).toBeNull();
    }
    expect(bindAddressWarning('172.32.0.1')).not.toBeNull();
    expect(bindAddressWarning('100.128.0.1')).not.toBeNull();
  });
});

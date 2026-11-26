import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HostRoot } from '../host-root.ts';
import { fixture, makeHostRoot } from '../../test/helpers.ts';
import { parseOsRelease, parseUptime, readOverview } from './overview.ts';

describe('parseOsRelease', () => {
  it('prefers PRETTY_NAME', () => {
    expect(parseOsRelease(readFileSync(fixture('os-release'), 'utf8'))).toBe(
      'Debian GNU/Linux 13 (trixie)',
    );
  });

  it('falls back to NAME and VERSION', () => {
    expect(parseOsRelease('NAME=Alpine\nVERSION="3.22"\n')).toBe('Alpine 3.22');
  });

  it('handles single quotes and escapes', () => {
    expect(parseOsRelease(`PRETTY_NAME='Arch Linux'`)).toBe('Arch Linux');
    expect(parseOsRelease('PRETTY_NAME="Say \\"hi\\""')).toBe('Say "hi"');
  });
});

describe('parseUptime', () => {
  it('reads whole seconds', () => {
    expect(parseUptime('354823.17 1386914.25\n')).toBe(354823);
  });
});

describe('readOverview', () => {
  it('reads the Host identity through the Host root', async () => {
    const root = await makeHostRoot({
      'etc/hostname': 'stale-name\n',
      'etc/os-release': readFileSync(fixture('os-release'), 'utf8'),
      'proc/sys/kernel/hostname': 'harbour\n',
      'proc/sys/kernel/osrelease': '6.12.48-1-amd64\n',
      'proc/uptime': '3600.50 100.00\n',
    });
    expect(await readOverview(new HostRoot(root))).toEqual({
      hostname: 'harbour',
      os: 'Debian GNU/Linux 13 (trixie)',
      kernel: '6.12.48-1-amd64',
      uptimeSeconds: 3600,
    });
  });

  it('falls back to etc/hostname and usr/lib/os-release', async () => {
    const root = await makeHostRoot({
      'usr/lib/os-release': 'NAME="Fedora Linux"\nVERSION="43"\n',
      'etc/hostname': 'fallback\n',
      'proc/uptime': '10 1\n',
    });
    const overview = await readOverview(new HostRoot(root));
    expect(overview.hostname).toBe('fallback');
    expect(overview.os).toBe('Fedora Linux 43');
    expect(overview.kernel).toBe('unknown');
  });
});

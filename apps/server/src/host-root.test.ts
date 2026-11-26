import { describe, expect, it } from 'vitest';
import { HostRoot } from './host-root.ts';

describe('HostRoot', () => {
  const host = new HostRoot('/host');

  it('resolves Host paths under the Host root', () => {
    expect(host.path('proc/meminfo')).toBe('/host/proc/meminfo');
    expect(host.path('/proc/1/mounts')).toBe('/host/proc/1/mounts');
    expect(host.path('/')).toBe('/host');
    expect(host.path('/mnt/media library')).toBe('/host/mnt/media library');
  });

  it('refuses paths that escape the Host root', () => {
    expect(() => host.path('../etc/shadow')).toThrow(/escapes/);
    expect(() => host.path('/proc/../../etc')).toThrow(/escapes/);
  });

  it('works with "/" as the Host root, as when run natively', () => {
    expect(new HostRoot('/').path('proc/meminfo')).toBe('/proc/meminfo');
  });
});

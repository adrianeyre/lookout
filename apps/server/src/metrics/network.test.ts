import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HostRoot } from '../host-root.ts';
import { fixture, makeHostRoot } from '../../test/helpers.ts';
import { NetworkReader, isVirtualInterface, parseNetDev } from './network.ts';

const netDev = readFileSync(fixture('net-dev'), 'utf8');

describe('parseNetDev', () => {
  it('reads receive and transmit bytes for every interface', () => {
    expect(parseNetDev(netDev)).toEqual([
      { name: 'lo', rxBytes: 81_234_567n, txBytes: 81_234_567n },
      { name: 'eth0', rxBytes: 9_876_543_210n, txBytes: 1_234_567_890n },
      { name: 'docker0', rxBytes: 123_456n, txBytes: 654_321n },
      { name: 'vethab12cd', rxBytes: 55_555n, txBytes: 66_666n },
      { name: 'wlan0', rxBytes: 0n, txBytes: 0n },
    ]);
  });
});

describe('isVirtualInterface', () => {
  it('marks loopback and veth interfaces only', () => {
    expect(['lo', 'eth0', 'docker0', 'vethab12cd', 'br-1234'].filter(isVirtualInterface)).toEqual([
      'lo',
      'vethab12cd',
    ]);
  });
});

describe('NetworkReader', () => {
  it('reads the Host PID 1 net/dev and reports bytes/s, real interfaces first', async () => {
    const root = new HostRoot(await makeHostRoot({ 'proc/1/net/dev': netDev }));
    const clock = { now: 0 };
    const reader = new NetworkReader(root, () => clock.now);
    const first = await reader.read();
    expect(first.map((nic) => [nic.name, nic.virtual, nic.rxBytesPerSecond])).toEqual([
      ['docker0', false, null],
      ['eth0', false, null],
      ['wlan0', false, null],
      ['lo', true, null],
      ['vethab12cd', true, null],
    ]);

    await writeFile(
      root.path('proc/1/net/dev'),
      netDev.replace('9876543210', '9876743210').replace('1234567890', '1234667890'),
    );
    clock.now = 2000;
    const eth0 = (await reader.read()).find((nic) => nic.name === 'eth0');
    expect(eth0).toEqual({
      name: 'eth0',
      virtual: false,
      rxBytesPerSecond: 100_000,
      txBytesPerSecond: 50_000,
    });
  });
});

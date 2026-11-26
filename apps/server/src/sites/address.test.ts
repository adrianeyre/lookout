import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { INTERNAL_ADDRESS, isInternalAddress, isLocalName, publicLookup } from './address.ts';

describe('isInternalAddress (#103)', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.10',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:a9fe:a9fe::1',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    '100::1',
    '2001:db8::1',
    'not an address',
    'metadata.google.internal',
  ])('%s is internal', (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '169.253.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('%s is public', (address) => {
    expect(isInternalAddress(address)).toBe(false);
  });

  it('knows localhost names whatever DNS says', () => {
    expect(isLocalName('localhost')).toBe(true);
    expect(isLocalName('LOCALHOST.')).toBe(true);
    expect(isLocalName('admin.localhost')).toBe(true);
    expect(isLocalName('localhost.example')).toBe(false);
  });
});

describe('publicLookup (#103)', () => {
  /** A resolver answering every name with these addresses. */
  const answering = (addresses: LookupAddress[]) =>
    ((_name: string, _options: unknown, callback: (e: null, a: LookupAddress[]) => void) =>
      callback(null, addresses)) as unknown as typeof import('node:dns').lookup;

  const lookup = (addresses: LookupAddress[], all: boolean) =>
    new Promise<{
      error: NodeJS.ErrnoException | null;
      result: unknown;
      family?: number | undefined;
    }>((resolve) =>
      publicLookup(
        'rebound.example',
        { all },
        (error, result, family) => resolve({ error, result, family }),
        answering(addresses),
      ),
    );

  it('refuses a name that resolves only to internal addresses (DNS rebinding)', async () => {
    const { error } = await lookup(
      [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
      true,
    );
    expect(error?.code).toBe(INTERNAL_ADDRESS);
  });

  it('drops the internal addresses and keeps the public ones', async () => {
    const answer = [
      { address: '169.254.169.254', family: 4 },
      { address: '93.184.215.14', family: 4 },
    ];
    expect((await lookup(answer, true)).result).toEqual([{ address: '93.184.215.14', family: 4 }]);
    expect(await lookup(answer, false)).toMatchObject({
      error: null,
      result: '93.184.215.14',
      family: 4,
    });
  });
});

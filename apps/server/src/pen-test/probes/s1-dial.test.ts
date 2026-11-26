/**
 * Pen-test scope issue S1 (#67), H4: the address a real Hosted Site check dials, with
 * node:http's `request` stubbed so nothing is ever dialled. This shows, without touching
 * link-local or metadata addresses, where the check engine would connect. The rest of S1 is
 * s1-sites.test.ts; findings are in docs/pen-test/findings/S1.md.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

interface Dialled {
  host: string;
  port: number;
  path: string;
  hostHeader: string;
  lookup: unknown;
}

const dialled: Dialled[] = [];

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const request = (options: {
    host: string;
    port: number;
    path: string;
    headers: Record<string, string>;
    lookup?: unknown;
  }) => {
    dialled.push({
      host: options.host,
      port: options.port,
      path: options.path,
      hostHeader: options.headers.host!,
      lookup: options.lookup,
    });
    // A request that never connects: it fails as a refused connection would.
    const fake = Object.assign(new EventEmitter(), {
      end: () => {
        queueMicrotask(() =>
          fake.emit('error', Object.assign(new Error('stubbed'), { code: 'ECONNREFUSED' })),
        );
      },
      destroy: () => undefined,
    });
    return fake;
  };
  return { ...actual, request, default: { ...actual, request } };
});

const { checkSite } = await import('../../sites/check.ts');
const { publicLookup } = await import('../../sites/address.ts');

async function dial(url: string, checkPublic: boolean): Promise<Dialled> {
  dialled.length = 0;
  const check = await checkSite(url, { timeoutMs: 1000, slowMs: 500, checkPublic });
  expect(check).toMatchObject({ status: 'down', error: 'Connection refused' });
  expect(dialled).toHaveLength(1);
  return dialled[0]!;
}

const METADATA = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
const INTERNAL = /^(127\.|169\.254\.|10\.|192\.168\.|::1$|f[cd]|fe80)/;

describe('S1 H4: where a check connects', () => {
  it('at the Host (the default), every label URL dials 127.0.0.1 on its port, with its path and Host header', async () => {
    expect(await dial(METADATA, false)).toMatchObject({
      host: '127.0.0.1',
      port: 80,
      path: '/latest/meta-data/iam/security-credentials/',
      hostHeader: '169.254.169.254',
    });
    expect(await dial('http://consul.internal:8500/v1/agent/self', false)).toMatchObject({
      host: '127.0.0.1',
      port: 8500,
      path: '/v1/agent/self',
    });
  });

  it('in public mode, never dials a link-local, metadata, loopback or private address', async () => {
    for (const url of [
      METADATA,
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://10.0.0.1:8500/v1/agent/self',
      'http://127.0.0.1:2375/containers/json',
    ]) {
      dialled.length = 0;
      await checkSite(url, { timeoutMs: 1000, slowMs: 500, checkPublic: true });
      expect(
        dialled.filter((d) => INTERNAL.test(d.host)),
        url,
      ).toEqual([]);
    }
  });

  it('public mode refuses the cloud metadata address and private addresses unasked, and resolves names only through the filtering lookup (regression)', async () => {
    for (const url of [METADATA, 'http://[fd00:ec2::254]/latest/meta-data/']) {
      dialled.length = 0;
      const check = await checkSite(url, { timeoutMs: 1000, slowMs: 500, checkPublic: true });
      expect(check, url).toMatchObject({
        status: 'down',
        error: 'Not checked: public mode never connects to an internal address',
      });
      expect(dialled, url).toEqual([]);
    }
    // A hostname is resolved by publicLookup, which drops internal answers at connect time,
    // so a name that resolves (or is rebound) to an internal address is never dialled (#103).
    const named = await dial('http://rebind.attacker.example/', true);
    expect(named).toMatchObject({ host: 'rebind.attacker.example', lookup: publicLookup });
  });
});

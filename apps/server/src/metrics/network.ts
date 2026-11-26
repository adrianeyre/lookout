import type { NetworkInterface } from '@lookout/shared';
import type { HostRoot } from '../host-root.ts';
import { RateTracker, parseCounter } from './counters.ts';

export interface InterfaceCounters {
  name: string;
  rxBytes: bigint;
  txBytes: bigint;
}

/** Parses /proc/net/dev: "  eth0: rx-bytes packets errs drop fifo frame compressed multicast tx-bytes …". */
export function parseNetDev(text: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    const rxBytes = parseCounter(fields[0]);
    const txBytes = parseCounter(fields[8]);
    if (!name || rxBytes === null || txBytes === null) continue;
    out.push({ name, rxBytes, txBytes });
  }
  return out;
}

/** Loopback and Docker's per-Container virtual interfaces, hidden by default (FR-11). */
export function isVirtualInterface(name: string): boolean {
  return name === 'lo' || name.startsWith('veth');
}

/**
 * Receive and transmit throughput per interface (FR-11). Lookout runs with the Host's
 * network namespace (ADR-0003), and net/dev is read through the Host's PID 1, so these are
 * the Host's interfaces either way.
 */
export class NetworkReader {
  readonly #hostRoot: HostRoot;
  readonly #now: () => number;
  readonly #rates = new RateTracker<'rx' | 'tx'>();

  constructor(hostRoot: HostRoot, now: () => number = () => performance.now()) {
    this.#hostRoot = hostRoot;
    this.#now = now;
  }

  async read(): Promise<NetworkInterface[]> {
    const interfaces = parseNetDev(await this.#hostRoot.readText('proc/1/net/dev'));
    const rates = this.#rates.rates(
      this.#now(),
      new Map(interfaces.map((i) => [i.name, { rx: i.rxBytes, tx: i.txBytes }])),
    );
    return interfaces
      .map((nic) => {
        const rate = rates.get(nic.name)!;
        return {
          name: nic.name,
          virtual: isVirtualInterface(nic.name),
          rxBytesPerSecond: rate.rx,
          txBytesPerSecond: rate.tx,
        };
      })
      .sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.name.localeCompare(b.name));
  }
}

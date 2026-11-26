import type { HostOverview } from '@lookout/shared';
import type { HostRoot } from '../host-root.ts';

/** Reads PRETTY_NAME (or NAME VERSION) from an os-release file. */
export function parseOsRelease(text: string): string | null {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["$`\\])/g, '$1');
    }
    values.set(match[1]!, value);
  }
  const pretty = values.get('PRETTY_NAME');
  if (pretty) return pretty;
  const name = values.get('NAME');
  if (!name) return null;
  const version = values.get('VERSION');
  return version ? `${name} ${version}` : name;
}

export function parseUptime(text: string): number {
  const seconds = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isFinite(seconds)) throw new Error('proc/uptime is malformed');
  return Math.floor(seconds);
}

export async function readOverview(hostRoot: HostRoot): Promise<HostOverview> {
  const [kernelHostname, etcHostname, osRelease, usrOsRelease, kernel, uptime] = await Promise.all([
    // proc/sys/kernel/hostname is the reader's UTS name. With network_mode: host (ADR-0003)
    // Docker gives the Container the Host's hostname, while etc/hostname can be stale (a
    // transient or cloud-init hostname does not update it), so the kernel's is preferred.
    hostRoot.readTextOrNull('proc/sys/kernel/hostname'),
    hostRoot.readTextOrNull('etc/hostname'),
    hostRoot.readTextOrNull('etc/os-release'),
    hostRoot.readTextOrNull('usr/lib/os-release'),
    hostRoot.readTextOrNull('proc/sys/kernel/osrelease'),
    hostRoot.readText('proc/uptime'),
  ]);
  const hostname = (kernelHostname?.trim() || etcHostname?.trim() || 'unknown').split('\n')[0]!;
  return {
    hostname,
    os:
      (osRelease && parseOsRelease(osRelease)) ??
      (usrOsRelease && parseOsRelease(usrOsRelease)) ??
      'Linux',
    kernel: kernel?.trim() || 'unknown',
    uptimeSeconds: parseUptime(uptime),
  };
}

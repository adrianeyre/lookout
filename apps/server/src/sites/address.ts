/**
 * Which addresses a Hosted Site check in public mode (`lookout.check: public`) may connect
 * to (#103). A label is written by whoever built the Container's Image, so public mode must
 * never reach the Host's loopback, the cloud metadata service or the private network. The
 * address is checked when the connection is made, on what DNS actually returned, so a name
 * that is (or is rebound to) an internal address is refused as well.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

/** IPv4 blocks that are not the public internet: [first octets, prefix length]. */
const INTERNAL_V4: readonly [number[], number][] = [
  [[0], 8], // "this network", including 0.0.0.0
  [[10], 8], // RFC 1918
  [[100, 64], 10], // carrier-grade NAT (RFC 6598), where Tailscale lives
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, the cloud metadata service included
  [[172, 16], 12], // RFC 1918
  [[192, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2], 24], // documentation
  [[192, 168], 16], // RFC 1918
  [[198, 18], 15], // benchmarking
  [[198, 51, 100], 24], // documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4], // multicast
  [[240], 4], // reserved, and the broadcast address
];

function v4Bytes(address: string): number[] {
  return address.split('.').map(Number);
}

function inPrefix(bytes: number[], start: number[], prefix: number): boolean {
  let bits = prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((start[i] ?? 0) & mask)) return false;
  }
  return true;
}

function internalV4(bytes: number[]): boolean {
  return INTERNAL_V4.some(([start, prefix]) => inPrefix(bytes, start, prefix));
}

/** The 16 bytes of an IPv6 address (which may end in dotted IPv4). */
function v6Bytes(address: string): number[] {
  let text = address.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = v4Bytes(tail[1]!) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].flatMap((group) => {
    const value = Number.parseInt(group || '0', 16);
    return [value >> 8, value & 0xff];
  });
}

function internalV6(bytes: number[]): boolean {
  const zeroes = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  if (zeroes(0, 16)) return true; // ::
  if (zeroes(0, 15) && bytes[15] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 address.
  if (zeroes(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return internalV4(bytes.slice(12));
  if (zeroes(0, 12)) return internalV4(bytes.slice(12));
  // NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48): judge the embedded address.
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return zeroes(4, 12) ? internalV4(bytes.slice(12)) : true;
  }
  // 6to4 (2002::/16) carries an IPv4 address in its next 32 bits.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return internalV4(bytes.slice(2, 6));
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true; // site-local fec0::/10
  if (bytes[0] === 0xff) return true; // multicast
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && zeroes(2, 8)) return true; // discard 100::/64
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true; // documentation 2001:db8::/32
  }
  return false;
}

/**
 * True for an address public mode must not connect to: loopback, link-local (the cloud
 * metadata service), private, carrier-grade NAT, unique local, unspecified, multicast,
 * reserved and documentation blocks, and IPv4-mapped, NAT64 and 6to4 forms of them. Anything
 * that is not an IP address at all counts as internal, so a mistake fails closed.
 */
export function isInternalAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  if (isIPv4(bare)) return internalV4(v4Bytes(bare));
  if (isIPv6(bare)) return internalV6(v6Bytes(bare));
  return true;
}

/** Names that always mean this machine, whatever DNS says. */
export function isLocalName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/** The error a refused address fails the check with. */
export const INTERNAL_ADDRESS = 'LOOKOUT_INTERNAL_ADDRESS';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for public-mode connections: resolves the name as Node would, drops every
 * internal address, and fails with INTERNAL_ADDRESS when none is left. Node calls it for
 * every connection, so the address checked is the address dialled.
 */
export function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
  resolve: typeof dnsLookup = dnsLookup,
): void {
  resolve(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, options.all ? [] : '', 0);
      return;
    }
    const allowed = addresses.filter((entry) => !isInternalAddress(entry.address));
    if (allowed.length === 0) {
      const refused = Object.assign(new Error('Resolves only to internal addresses'), {
        code: INTERNAL_ADDRESS,
      });
      callback(refused, options.all ? [] : '', 0);
      return;
    }
    if (options.all) callback(null, allowed);
    else callback(null, allowed[0]!.address, allowed[0]!.family);
  });
}

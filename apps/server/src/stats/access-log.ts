import { isIP } from 'node:net';
import { limiterKey } from '../auth/rate-limit.ts';

/**
 * One request from a reverse proxy's access log, in a form that does not depend on the proxy
 * (ADR-0014). Formats other than Caddy's JSON can be added as more AccessLogFormats.
 */
export interface AccessEntry {
  /** When the request was handled, ms since the epoch. */
  ts: number;
  /** The Host header, lower-case, with its port if it had one. */
  host: string;
  /** The address the proxy's connection came from. */
  remoteIp: string | null;
  method: string;
  /** The request target as sent: path and query. */
  uri: string;
  status: number;
  durationMs: number | null;
  /** The response's Content-Type, or null. */
  contentType: string | null;
  userAgent: string | null;
  referer: string | null;
  /** Cloudflare's client address header, which only a local tunnel may set (see clientIp). */
  cfConnectingIp: string | null;
}

/** What a format makes of one line: an entry, a line that is not a request, or nonsense. */
export type ParsedLine = { entry: AccessEntry } | { skip: true } | { malformed: true };

export interface AccessLogFormat {
  readonly name: string;
  parse(line: string): ParsedLine;
}

/** The longest log line read; a longer one is skipped as malformed. */
export const MAX_LINE_BYTES = 64 * 1024;

type Headers = Record<string, unknown>;

/** A header from Caddy's JSON (Go canonical names, each value a list), case-insensitively. */
function header(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
    return typeof first === 'string' ? first : null;
  }
  return null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Caddy's JSON access log (the `log` directive with `format json`, its default): one object per
 * line, with `request`, `status`, `duration` (seconds) and `resp_headers`. Other lines Caddy
 * writes to the same file (its own messages) are skipped, not malformed.
 */
export const caddyJson: AccessLogFormat = {
  name: 'caddy-json',
  parse(line) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { malformed: true };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { malformed: true };
    const record = raw as Record<string, unknown>;
    const request = record.request as Record<string, unknown> | undefined;
    if (!request || typeof request !== 'object' || record.status === undefined) {
      return { skip: true };
    }
    const status = Number(record.status);
    const host = str(request.host);
    const method = str(request.method);
    const uri = str(request.uri);
    const ts =
      typeof record.ts === 'number'
        ? Math.round(record.ts * 1000)
        : typeof record.ts === 'string'
          ? Date.parse(record.ts)
          : Number.NaN;
    if (!Number.isInteger(status) || host === null || method === null || uri === null) {
      return { malformed: true };
    }
    if (!Number.isFinite(ts)) return { malformed: true };
    const duration =
      typeof record.duration === 'number' ? Math.round(record.duration * 1_000_000) / 1000 : null;
    return {
      entry: {
        ts,
        host: host.toLowerCase(),
        remoteIp: str(request.remote_ip) ?? str(request.client_ip),
        method,
        uri,
        status,
        durationMs:
          duration !== null && Number.isFinite(duration) && duration >= 0 ? duration : null,
        contentType: header(record.resp_headers, 'content-type'),
        userAgent: header(request.headers, 'user-agent'),
        referer: header(request.headers, 'referer'),
        cfConnectingIp: header(request.headers, 'cf-connecting-ip'),
      },
    };
  },
};

/** The User-Agent of Lookout's own Hosted Site checks (sites/check.ts), never counted. */
export const LOOKOUT_USER_AGENT = 'Lookout (Hosted Site check)';

/**
 * A user agent that looks like a program rather than a person: crawlers, monitors, link
 * previews and HTTP libraries. No user agent at all counts as a bot too.
 */
const BOT =
  /bot\b|bot\/|crawl|spider|slurp|scrap|fetch|monitor|uptime|pingdom|preview|headless|lighthouse|facebookexternalhit|embedly|whatsapp|curl\/|wget\/|python-|httpx|aiohttp|go-http-client|okhttp|java\/|libwww|node-fetch|axios\/|undici|http\.rb|scanner|nmap|masscan|zgrab/i;

export function isBot(userAgent: string | null): boolean {
  if (userAgent === null || userAgent.trim() === '') return true;
  return BOT.test(userAgent);
}

function isLoopback(address: string): boolean {
  const bare = address.replace(/^::ffff:/i, '');
  return bare === '::1' || (isIP(bare) === 4 && bare.startsWith('127.'));
}

/**
 * The visitor's address. CF-Connecting-IP is believed only when the request reached the proxy
 * from loopback, which is where a local tunnel (cloudflared) connects from: from anywhere else
 * anyone could send the header and make up visitors.
 */
export function clientIp(entry: Pick<AccessEntry, 'remoteIp' | 'cfConnectingIp'>): string | null {
  const remote = entry.remoteIp;
  if (remote === null || isIP(remote) === 0) return null;
  const forwarded = entry.cfConnectingIp?.trim() ?? '';
  if (isLoopback(remote) && isIP(forwarded) !== 0) return forwarded;
  return remote;
}

/** A visitor: one address, an IPv6 /64 counting as one (as the login limit counts them). */
export function visitorKey(address: string): string {
  return limiterKey(address);
}

/**
 * The key a request's totals are kept under: its Host header's name, lower-case, with a port
 * only when it is not 80 or 443. A Hosted Site reads the totals of siteHostKey(its URL), so
 * https://cdn.example.com/ finds requests a local tunnel sent with `Host: cdn.example.com`.
 */
export function hostKey(hostHeader: string): string | null {
  if (hostHeader === '' || /[@/\\?#\s]/.test(hostHeader)) return null;
  let url: URL;
  try {
    url = new URL(`http://${hostHeader}`);
  } catch {
    return null;
  }
  return keyOf(url);
}

export function siteHostKey(siteUrl: string): string | null {
  try {
    return keyOf(new URL(siteUrl));
  } catch {
    return null;
  }
}

function keyOf(url: URL): string | null {
  const name = url.hostname.toLowerCase().replace(/\.$/, '');
  if (name === '') return null;
  return url.port && url.port !== '80' && url.port !== '443' ? `${name}:${url.port}` : name;
}

/** The path of a request target, without its query string or fragment, which can hold tokens. */
export function pathOf(uri: string): string {
  const cut = uri.search(/[?#]/);
  const path = cut === -1 ? uri : uri.slice(0, cut);
  if (!path.startsWith('/')) return '/';
  return path.length > 200 ? `${path.slice(0, 199)}…` : path;
}

/** The domain a Referer names, or null (none, unparseable, or not http). */
export function refererDomain(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** A page view: a successful GET answered with HTML. */
export function isPageView(entry: Pick<AccessEntry, 'method' | 'status' | 'contentType'>): boolean {
  return (
    entry.method === 'GET' &&
    entry.status >= 200 &&
    entry.status < 300 &&
    (entry.contentType?.toLowerCase().startsWith('text/html') ?? false)
  );
}

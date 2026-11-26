import { isIP } from 'node:net';
import path from 'node:path';
import {
  PRIVATE_FOLDERS,
  STATS_RETENTION_DEFAULT_DAYS,
  STATS_RETENTION_MAX_DAYS,
  STATS_RETENTION_MIN_DAYS,
} from '@lookout/shared';
import { parsePasswordHash } from './auth/password.ts';

export interface Config {
  bindAddress: string;
  port: number;
  hostRoot: string;
  sampleIntervalMs: number;
  /** Length of the in-memory Live Window for sparklines (FR-13). */
  liveWindowMinutes: number;
  /** Amber and red thresholds for percentage metrics (FR-12). */
  warnPercent: number;
  criticalPercent: number;
  passwordHash: string;
  sessionSecret: string;
  sessionIdleMs: number;
  /** The longest a session lasts from sign-in, however often it is used (#84). */
  sessionMaxMs: number;
  /**
   * Host names Lookout answers to, besides IP addresses and localhost (#87). A request for
   * any other name is refused before any route, so a DNS-rebound name gets nothing.
   */
  hostnames: string[];
  /**
   * Always mark the session cookie Secure (#86), for an HTTPS proxy that does not send
   * X-Forwarded-Proto. Signing in over plain HTTP then fails, as the browser drops the cookie.
   */
  secureCookie: boolean;
  /** Hosted Site URLs from LOOKOUT_SITES (PRD §14). */
  sites: string[];
  /**
   * The folder on the Host a LOOKOUT_SITES entry serves (`URL=/folder`), by URL: a site with
   * no Container is sized by it (Site Stats). Only ever read, through the Host root.
   */
  siteFolders: Record<string, string>;
  /**
   * LOOKOUT_ACCESS_LOGS: the reverse proxy's access logs (Caddy JSON), a path or a `*` pattern
   * in its file name, under LOOKOUT_HOST_ROOT. Null hides the visitor figures (ADR-0014).
   */
  accessLogs: string | null;
  /** Days of daily Site Stats kept (LOOKOUT_STATS_RETENTION_DAYS, ADR-0013). */
  statsRetentionDays: number;
  siteCheckIntervalMs: number;
  siteTimeoutMs: number;
  siteSlowMs: number;
  /** TLS certificate thresholds for Hosted Sites, in days. */
  tlsWarnDays: number;
  tlsCriticalDays: number;
  /** Hours between scans of the Host's largest folders; 0 scans only when asked. */
  folderScanHours: number;
  /**
   * LOOKOUT_DATA_DIR: where a password changed in Settings is kept. Without it the password
   * can only be changed in .env.
   */
  dataDir: string | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The weakest Argon2id cost accepted (#124): OWASP's baselines trade memory for passes,
 * from 46 MiB once to 7 MiB five times, so a hash needs at least 7 MiB and 35 MiB × passes.
 */
const MIN_HASH_MEMORY_KIB = 7_168;
const MIN_HASH_WORK_KIB = 35_840;

export interface LoadOptions {
  /**
   * Accept an Argon2id hash below the minimum cost. Only tests and the e2e server pass it,
   * so their sign-ins stay quick; nothing in the environment can set it.
   */
  allowCheapPasswordHash?: boolean;
}

/**
 * Why a bind address deserves a warning at start (#122), or null: every interface, or an
 * address that is not loopback, private (RFC 1918, IPv6 ULA), link-local or Tailscale's
 * CGNAT range. ADR-0008: Lookout is reached over a LAN or VPN, never the public internet.
 */
export function bindAddressWarning(address: string): string | null {
  const every = address === '0.0.0.0' || address === '::' || /^(0+:){7}0+$/.test(address);
  if (every) {
    return `LOOKOUT_BIND_ADDRESS is ${address}, so Lookout answers on every interface, public ones included. Set it to your LAN or VPN address (ADR-0008).`;
  }
  if (isPrivateAddress(address)) return null;
  return `LOOKOUT_BIND_ADDRESS ${address} is not a loopback, private, link-local or Tailscale address, so Lookout may be reachable from the internet. Set it to your LAN or VPN address (ADR-0008).`;
}

function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const v4 = isIP(address) === 4 ? address : mapped;
  if (v4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  const first = Number.parseInt(lower.split(':')[0] || '0', 16);
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * Reads and validates configuration from environment variables. Throws a ConfigError naming
 * every invalid variable, so a bad install fails at startup and not on first use.
 */
export function loadConfig(env: Env = process.env, options: LoadOptions = {}): Config {
  const problems: string[] = [];

  const read = (name: string, fallback?: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? fallback : value;
  };

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  };

  const bindAddress = read('LOOKOUT_BIND_ADDRESS', '127.0.0.1')!;
  if (isIP(bindAddress) === 0) {
    problems.push(`LOOKOUT_BIND_ADDRESS must be an IPv4 or IPv6 address (got "${bindAddress}")`);
  }

  const port = integer('LOOKOUT_PORT', 7777, 1, 65535);

  const hostRoot = read('LOOKOUT_HOST_ROOT', '/host')!;
  if (!hostRoot.startsWith('/')) {
    problems.push(`LOOKOUT_HOST_ROOT must be an absolute path (got "${hostRoot}")`);
  }

  const sampleIntervalMs = integer('LOOKOUT_SAMPLE_INTERVAL_MS', 2000, 250, 60_000);
  const sessionIdleDays = integer('LOOKOUT_SESSION_IDLE_DAYS', 7, 1, 365);
  const sessionMaxDays = integer('LOOKOUT_SESSION_MAX_DAYS', 30, 1, 365);
  if (sessionIdleDays > sessionMaxDays) {
    problems.push(
      `LOOKOUT_SESSION_IDLE_DAYS (${sessionIdleDays}) must not be longer than LOOKOUT_SESSION_MAX_DAYS (${sessionMaxDays})`,
    );
  }
  const hostnames = hostnameList(read('LOOKOUT_HOSTNAMES') ?? '', problems);
  const secureCookieRaw = (read('LOOKOUT_SECURE_COOKIE') ?? 'false').toLowerCase();
  if (secureCookieRaw !== 'true' && secureCookieRaw !== 'false') {
    problems.push(`LOOKOUT_SECURE_COOKIE must be true or false (got "${secureCookieRaw}")`);
  }
  const liveWindowMinutes = integer('LOOKOUT_LIVE_WINDOW_MINUTES', 15, 1, 60);

  const warnPercent = integer('LOOKOUT_WARN_PERCENT', 80, 1, 100);
  const criticalPercent = integer('LOOKOUT_CRITICAL_PERCENT', 90, 1, 100);
  if (warnPercent >= criticalPercent) {
    problems.push(
      `LOOKOUT_WARN_PERCENT (${warnPercent}) must be lower than LOOKOUT_CRITICAL_PERCENT (${criticalPercent})`,
    );
  }

  const { urls: sites, folders: siteFolders } = siteUrls(read('LOOKOUT_SITES') ?? '', problems);
  const statsRetentionDays = integer(
    'LOOKOUT_STATS_RETENTION_DAYS',
    STATS_RETENTION_DEFAULT_DAYS,
    STATS_RETENTION_MIN_DAYS,
    STATS_RETENTION_MAX_DAYS,
  );
  const siteCheckIntervalSeconds = integer('LOOKOUT_SITE_CHECK_INTERVAL_SECONDS', 60, 1, 3600);
  const siteTimeoutMs = integer('LOOKOUT_SITE_TIMEOUT_MS', 10_000, 100, 60_000);
  const siteSlowMs = integer('LOOKOUT_SITE_SLOW_MS', 2000, 1, 60_000);
  const folderScanHours = integer('LOOKOUT_FOLDER_SCAN_HOURS', 6, 0, 168);
  if (siteTimeoutMs > siteCheckIntervalSeconds * 1000) {
    problems.push(
      `LOOKOUT_SITE_TIMEOUT_MS (${siteTimeoutMs}) must not be longer than LOOKOUT_SITE_CHECK_INTERVAL_SECONDS (${siteCheckIntervalSeconds} s)`,
    );
  }
  const tlsWarnDays = integer('LOOKOUT_TLS_WARN_DAYS', 14, 1, 365);
  const tlsCriticalDays = integer('LOOKOUT_TLS_CRITICAL_DAYS', 7, 0, 365);
  if (tlsCriticalDays >= tlsWarnDays) {
    problems.push(
      `LOOKOUT_TLS_CRITICAL_DAYS (${tlsCriticalDays}) must be lower than LOOKOUT_TLS_WARN_DAYS (${tlsWarnDays})`,
    );
  }

  const accessLogs = read('LOOKOUT_ACCESS_LOGS') ?? null;
  if (accessLogs !== null) {
    const problem = accessLogProblem(accessLogs, hostRoot);
    if (problem) problems.push(`LOOKOUT_ACCESS_LOGS ${problem} (got "${accessLogs}")`);
  }

  const dataDir = read('LOOKOUT_DATA_DIR') ?? null;
  if (dataDir !== null && !dataDir.startsWith('/')) {
    problems.push(`LOOKOUT_DATA_DIR must be an absolute path (got "${dataDir}")`);
  }

  // Never echo secret values in error messages.
  const passwordHash = read('LOOKOUT_PASSWORD_HASH');
  if (passwordHash === undefined) {
    problems.push('LOOKOUT_PASSWORD_HASH is required (create one with `pnpm hash-password`)');
  } else {
    const parsed = parsePasswordHash(passwordHash);
    if (parsed === null) {
      problems.push('LOOKOUT_PASSWORD_HASH is not a valid Argon2id hash');
    } else if (
      !options.allowCheapPasswordHash &&
      (parsed.memory < MIN_HASH_MEMORY_KIB || parsed.memory * parsed.passes < MIN_HASH_WORK_KIB)
    ) {
      // Only the parameters are named, never the hash (#124).
      problems.push(
        `LOOKOUT_PASSWORD_HASH is too cheap to guess slowly (m=${parsed.memory}, t=${parsed.passes}); make a new one with \`hash-password\` (m=19456, t=2)`,
      );
    }
  }

  const sessionSecret = read('LOOKOUT_SESSION_SECRET');
  if (sessionSecret === undefined) {
    problems.push('LOOKOUT_SESSION_SECRET is required (at least 32 random bytes)');
  } else if (Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    problems.push('LOOKOUT_SESSION_SECRET must be at least 32 bytes long');
  } else {
    const weakness = secretWeakness(sessionSecret);
    if (weakness) {
      problems.push(
        `LOOKOUT_SESSION_SECRET ${weakness}; make a random one with \`openssl rand -base64 32\``,
      );
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    bindAddress,
    port,
    hostRoot,
    sampleIntervalMs,
    liveWindowMinutes,
    warnPercent,
    criticalPercent,
    passwordHash: passwordHash!,
    sessionSecret: sessionSecret!,
    sessionIdleMs: sessionIdleDays * DAY_MS,
    sessionMaxMs: sessionMaxDays * DAY_MS,
    hostnames,
    secureCookie: secureCookieRaw === 'true',
    sites,
    siteFolders,
    accessLogs,
    statsRetentionDays,
    siteCheckIntervalMs: siteCheckIntervalSeconds * 1000,
    siteTimeoutMs,
    siteSlowMs,
    tlsWarnDays,
    tlsCriticalDays,
    folderScanHours,
    dataDir,
  };
}

/**
 * Parses a Hosted Site URL from operator config: http or https only, with a hostname and
 * no user name or password. Returns the normalised URL, or a reason it was refused.
 */
export function parseSiteUrl(raw: string): { url: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: 'is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: `uses ${url.protocol.replace(/:$/, '')}; only http and https are checked` };
  }
  if (url.hostname === '') return { problem: 'has no hostname' };
  if (url.username !== '' || url.password !== '') {
    return { problem: 'must not contain a user name or password' };
  }
  url.hash = '';
  return { url: url.href };
}

/**
 * LOOKOUT_SITES: comma-separated URLs, each optionally followed by `=/folder`, the folder on
 * the Host it serves (a site with no Container, such as a static file server). The folder
 * starts at the last `=/` in an entry, so a URL whose query has `=/` must encode it. Any
 * invalid entry stops startup.
 */
function siteUrls(
  value: string,
  problems: string[],
): { urls: string[]; folders: Record<string, string> } {
  const urls: string[] = [];
  const folders: Record<string, string> = {};
  for (const entry of value.split(',').map((part) => part.trim())) {
    if (entry === '') continue;
    const split = entry.lastIndexOf('=/');
    const raw = split === -1 ? entry : entry.slice(0, split);
    const folder = split === -1 ? null : entry.slice(split + 1);
    const parsed = parseSiteUrl(raw);
    if ('problem' in parsed) {
      // A URL with credentials is not echoed back.
      const shown = /@/.test(raw) ? 'a URL' : `"${raw}"`;
      problems.push(`LOOKOUT_SITES: ${shown} ${parsed.problem}`);
      continue;
    }
    if (folder !== null) {
      const problem = siteFolderProblem(folder);
      if (problem) {
        problems.push(`LOOKOUT_SITES: the folder "${folder}" ${problem}`);
        continue;
      }
      folders[parsed.url] = path.posix.normalize(folder).replace(/(.)\/$/, '$1');
    }
    if (!urls.includes(parsed.url)) urls.push(parsed.url);
  }
  return { urls, folders };
}

/**
 * Why a site's folder (`URL=/folder`) is refused, or null. It is a path on the Host, read
 * under the Host root only: absolute, with no `..`, and never a home folder (PRIVATE_FOLDERS),
 * which the folder walk never enters either.
 */
export function siteFolderProblem(folder: string): string | null {
  if (!folder.startsWith('/')) return 'must be an absolute path on the Host';
  if (folder.split('/').includes('..')) return 'must not contain ..';
  if (/[\0\n\r]/.test(folder)) return 'contains a control character';
  const normal = path.posix.normalize(folder);
  if (normal === '/') return 'must not be the whole Host';
  if (PRIVATE_FOLDERS.some((p) => normal === p || normal.startsWith(`${p}/`))) {
    return `is in ${PRIVATE_FOLDERS.join(' or ')}, which Lookout never reads`;
  }
  return null;
}

/**
 * Why LOOKOUT_ACCESS_LOGS is refused, or null: an absolute path under the Host root, whose
 * folder is literal and whose file name may hold `*` and `?`.
 */
export function accessLogProblem(value: string, hostRoot: string): string | null {
  if (!value.startsWith('/')) return 'must be an absolute path';
  if (value.split('/').includes('..')) return 'must not contain ..';
  const root = hostRoot.replace(/\/+$/, '');
  if (!value.startsWith(`${root}/`)) return `must be under LOOKOUT_HOST_ROOT (${root})`;
  const dir = path.posix.dirname(value);
  if (/[*?[\]]/.test(dir)) return 'may only use * and ? in the file name';
  if (/[[\]]/.test(path.posix.basename(value))) return 'may only use * and ? as wildcards';
  return null;
}

/** Words that mark a secret as a placeholder copied from an example, not a random value. */
const PLACEHOLDERS = ['changeme', 'replaceme', 'yoursecret', 'placeholder', 'example', 'xxxxxxxx'];

/**
 * Why a session secret of the right length is still guessable (#85), or null if it looks
 * random enough: too few different characters, one short pattern repeated, or a placeholder.
 * Never includes the secret itself.
 */
export function secretWeakness(secret: string): string | null {
  if (new Set(secret).size < 10) return 'has too few different characters';
  for (let unit = 1; unit <= secret.length / 2; unit += 1) {
    if (secret.length % unit === 0 && secret.slice(unit) === secret.slice(0, -unit)) {
      return 'is one short pattern repeated';
    }
  }
  const letters = secret.toLowerCase().replace(/[^a-z]/g, '');
  if (PLACEHOLDERS.some((word) => letters.includes(word))) return 'looks like a placeholder';
  return null;
}

/** LOOKOUT_HOSTNAMES: comma-separated host names, without a scheme or port. */
function hostnameList(value: string, problems: string[]): string[] {
  const names: string[] = [];
  for (const raw of value.split(',').map((part) => part.trim().toLowerCase())) {
    if (raw === '') continue;
    // A DNS name: labels of letters, digits and hyphens, optionally ending in a dot.
    if (
      !/^(?=.{1,253}\.?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/.test(
        raw,
      )
    ) {
      problems.push(
        `LOOKOUT_HOSTNAMES: "${raw}" is not a host name (give names only, without http:// or a port)`,
      );
    } else if (!names.includes(raw.replace(/\.$/, ''))) {
      names.push(raw.replace(/\.$/, ''));
    }
  }
  return names;
}

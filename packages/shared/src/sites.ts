/**
 * Hosted Sites (PRD §14, ADR-0010): websites served from the Host that Lookout checks.
 * Shared by the server's check engine and the Websites page.
 */

/** Where a Hosted Site came from. One URL can come from several places; they are merged. */
export type SiteSource = 'traefik' | 'label' | 'env';

/** The result of one check. "pending" until the first check finishes. */
export type SiteStatus = 'pending' | 'up' | 'slow' | 'down';

export const SITE_STATUSES: readonly Exclude<SiteStatus, 'pending'>[] = ['up', 'slow', 'down'];

/**
 * The TLS certificate's level: amber within the warn days, red within the critical days. A
 * short-lived certificate (one whose whole lifetime is under about six weeks, such as a
 * 12-hour certificate from Caddy's local CA or a 6-day one from Let's Encrypt) is judged by
 * its lifetime instead: amber once a third of it is left, when its issuer should already
 * have renewed it, and red once a sixth is left.
 */
export type TlsLevel = 'ok' | 'warn' | 'critical';

export interface TlsThresholds {
  /** Amber when the certificate expires within this many days. */
  warnDays: number;
  /** Red when it expires within this many days. */
  criticalDays: number;
}

export const DEFAULT_TLS_THRESHOLDS: TlsThresholds = { warnDays: 14, criticalDays: 7 };

/** The peer certificate from a check's TLS handshake. */
export interface TlsCertificate {
  /** The certificate's subject common name, or null if it has none. */
  subject: string | null;
  /** The issuer's organisation or common name. */
  issuer: string;
  /** When the certificate became valid, ms since the epoch. Absent from older results. */
  validFrom?: number;
  /** When the certificate expires, ms since the epoch. */
  validTo: number;
  /** Whether it covers the Hosted Site's hostname. */
  hostnameMatches: boolean;
  /** Whether it chains to a trusted certificate authority. */
  trusted: boolean;
  /** Why verification failed, such as "CERT_HAS_EXPIRED", or null if it passed. */
  error: string | null;
}

/** One check of a Hosted Site. The response body is never read (ADR-0010). */
export interface SiteCheck {
  /** When the check started, ms since the epoch. */
  timestamp: number;
  status: Exclude<SiteStatus, 'pending'>;
  /** The HTTP status code, or null if there was no response. */
  statusCode: number | null;
  /** Why there was no usable response: "Connection refused", "Timed out after 10 s"… */
  error: string | null;
  /** Time to the response headers, or null if there was no response. */
  responseMs: number | null;
  /** The Location header of a 3xx response. */
  redirect: string | null;
  /** The certificate for an https Hosted Site, or null for http or when none was received. */
  tls: TlsCertificate | null;
}

/** One point of a Hosted Site's response-time sparkline (the Live Window, ADR-0004). */
export interface SitePoint {
  timestamp: number;
  /** Null when the check got no response. */
  responseMs: number | null;
}

export interface HostedSite {
  /** A stable ID derived from the URL. "Check now" takes this, never a URL. */
  id: string;
  url: string;
  sources: SiteSource[];
  /** The Container that serves it, for a Traefik or label Hosted Site. */
  containerId: string | null;
  containerName: string | null;
  /** Checked through public DNS (`lookout.check: public`) rather than at the Host. */
  checkPublic: boolean;
  status: SiteStatus;
  last: SiteCheck | null;
  /** When it last came up (up or slow after down or pending). */
  upSince: number | null;
  /** When it last went down. */
  downSince: number | null;
  /** Response times over the Live Window, oldest first. Starts empty after a restart. */
  history: SitePoint[];
}

export interface SitesSettings {
  checkIntervalMs: number;
  timeoutMs: number;
  slowMs: number;
  tls: TlsThresholds;
  /** How many points a Hosted Site's history holds. */
  historyCapacity: number;
}

export interface SitesSnapshot {
  settings: SitesSettings;
  sites: HostedSite[];
  /**
   * Hosted Sites found in Container labels but not checked, because the most Lookout
   * checks were already taken (LOOKOUT_SITES first, #104). Absent or 0 when none.
   */
  notChecked?: number;
}

/** The most Hosted Sites Lookout checks, LOOKOUT_SITES first (#104). */
export const MAX_SITES = 500;
/** The most Hosted Sites one Container's labels may name (#104). */
export const MAX_SITES_PER_CONTAINER = 20;
/** The longest Hosted Site URL a label may name; longer ones are skipped (#121). */
export const MAX_SITE_URL_LENGTH = 2048;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long before expiry a certificate turns amber and red, in ms: the configured days, or a
 * third and a sixth of the certificate's lifetime when that is sooner. Automatic renewal
 * (ACME clients, Caddy) happens with a third of the lifetime left, so a short-lived
 * certificate that is being renewed is never Flagged just for being short-lived.
 */
export function tlsWindows(
  certificate: Pick<TlsCertificate, 'validFrom' | 'validTo'>,
  thresholds: TlsThresholds,
): { warnMs: number; criticalMs: number } {
  const warnMs = thresholds.warnDays * DAY_MS;
  const criticalMs = thresholds.criticalDays * DAY_MS;
  const lifetime =
    certificate.validFrom === undefined ? Number.NaN : certificate.validTo - certificate.validFrom;
  if (!(lifetime > 0)) return { warnMs, criticalMs };
  return { warnMs: Math.min(warnMs, lifetime / 3), criticalMs: Math.min(criticalMs, lifetime / 6) };
}

/**
 * The single TLS rule (PRD §14): red when the certificate is expired, within the critical
 * window, doesn't match the hostname or isn't trusted; amber within the warn window (see
 * tlsWindows).
 */
export function tlsLevel(
  certificate: TlsCertificate | null,
  now: number,
  thresholds: TlsThresholds,
): TlsLevel {
  if (certificate === null) return 'ok';
  if (!certificate.trusted || !certificate.hostnameMatches || certificate.error !== null) {
    return 'critical';
  }
  if (certificate.validTo <= now) return 'critical';
  const left = certificate.validTo - now;
  const { warnMs, criticalMs } = tlsWindows(certificate, thresholds);
  if (left <= criticalMs) return 'critical';
  if (left <= warnMs) return 'warn';
  return 'ok';
}

/** Days until the certificate expires, rounded up (4.2 days is "5 days"); ≤ 0 once it has. */
export function tlsDaysLeft(certificate: TlsCertificate, now: number): number {
  return Math.ceil((certificate.validTo - now) / DAY_MS) || 0;
}

/**
 * The single rule for a Flagged Hosted Site: down, or its TLS certificate at red. Used by
 * the Websites page, the header summary and the Container detail view.
 */
export function isSiteFlagged(
  site: Pick<HostedSite, 'status' | 'last'>,
  now: number,
  tls: TlsThresholds,
) {
  if (site.status === 'down') return true;
  return tlsLevel(site.last?.tls ?? null, now, tls) === 'critical';
}

/** Why a Hosted Site is Flagged, for its label, or null if it is not. */
export function siteFlagReason(
  site: Pick<HostedSite, 'status' | 'last'>,
  now: number,
  tls: TlsThresholds,
): string | null {
  if (site.status === 'down') return 'Down';
  const certificate = site.last?.tls ?? null;
  if (certificate === null || tlsLevel(certificate, now, tls) !== 'critical') return null;
  if (certificate.validTo <= now) return 'Certificate expired';
  if (!certificate.trusted) return 'Certificate not trusted';
  if (!certificate.hostnameMatches) return "Certificate doesn't match";
  return 'Certificate expiring';
}

/** The up/slow/down rule (PRD §14). A response below 500 is up; slow past `slowMs`. */
export function siteStatusFor(
  statusCode: number | null,
  responseMs: number | null,
  slowMs: number,
): Exclude<SiteStatus, 'pending'> {
  if (statusCode === null || statusCode >= 500) return 'down';
  return responseMs !== null && responseMs > slowMs ? 'slow' : 'up';
}

/** The "Check now" path for a Hosted Site. */
export function siteCheckPath(id: string): string {
  return `/api/sites/${encodeURIComponent(id)}/check`;
}

/** Hosted Site IDs: 16 lowercase hex characters. Anything else is unknown. */
export const SITE_ID = /^[0-9a-f]{16}$/;

/** At most this many "Check now" requests per Hosted Site. */
export const CHECK_NOW_MIN_INTERVAL_MS = 5000;

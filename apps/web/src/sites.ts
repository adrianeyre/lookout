import {
  isSiteFlagged,
  tlsDaysLeft,
  tlsLevel,
  type ContainerSummary,
  type HostedSite,
  type SiteStatus,
  type TlsLevel,
  type TlsThresholds,
} from '@lookout/shared';
import { formatAgo } from './format.ts';

export interface SiteFilters {
  /** Matches the URL or the Container name, case-insensitively. */
  text: string;
  status: Exclude<SiteStatus, 'pending'> | 'all';
  flaggedOnly: boolean;
}

export const NO_SITE_FILTERS: SiteFilters = { text: '', status: 'all', flaggedOnly: false };

export function filterSites(
  sites: HostedSite[],
  filters: SiteFilters,
  now: number,
  tls: TlsThresholds,
): HostedSite[] {
  const text = filters.text.trim().toLowerCase();
  return sites.filter(
    (site) =>
      (text === '' ||
        site.url.toLowerCase().includes(text) ||
        (site.containerName?.toLowerCase().includes(text) ?? false)) &&
      (filters.status === 'all' || site.status === filters.status) &&
      (!filters.flaggedOnly || isSiteFlagged(site, now, tls)),
  );
}

/** Flagged Hosted Sites first, then by URL. */
export function sortSites(sites: HostedSite[], now: number, tls: TlsThresholds): HostedSite[] {
  return [...sites].sort((a, b) => {
    const flagged = Number(isSiteFlagged(b, now, tls)) - Number(isSiteFlagged(a, now, tls));
    return flagged !== 0 ? flagged : a.url.localeCompare(b.url);
  });
}

export interface SiteCounts {
  total: number;
  /** Up or slow. */
  up: number;
  down: number;
  flagged: number;
}

export function countSites(sites: HostedSite[], now: number, tls: TlsThresholds): SiteCounts {
  return {
    total: sites.length,
    up: sites.filter((s) => s.status === 'up' || s.status === 'slow').length,
    down: sites.filter((s) => s.status === 'down').length,
    flagged: sites.filter((s) => isSiteFlagged(s, now, tls)).length,
  };
}

/** "Down for 5m", "Up for 3h 2m", or "Checking…" before the first check. */
export function siteSinceText(site: HostedSite, now: number): string {
  if (site.status === 'pending') return 'Checking…';
  if (site.status === 'down') {
    return site.downSince === null ? 'Down' : `Down for ${formatAgo(site.downSince, now)}`;
  }
  return site.upSince === null ? 'Up' : `Up for ${formatAgo(site.upSince, now)}`;
}

/** The status code or why there was none: "200", "301 → https://…", "Connection refused". */
export function siteResultText(site: HostedSite): string {
  const last = site.last;
  if (last === null) return '—';
  if (last.statusCode === null) return last.error ?? 'No response';
  return last.redirect ? `${last.statusCode} → ${last.redirect}` : String(last.statusCode);
}

export interface TlsSummary {
  level: TlsLevel;
  text: string;
}

/** The TLS column: "No TLS", "Expires in 45 days", "Expired 2 days ago", "Not trusted"… */
export function tlsSummary(site: HostedSite, now: number, tls: TlsThresholds): TlsSummary | null {
  if (!site.url.startsWith('https:')) return { level: 'ok', text: 'No TLS' };
  const certificate = site.last?.tls ?? null;
  if (certificate === null)
    return site.last === null ? null : { level: 'ok', text: 'No certificate' };
  const level = tlsLevel(certificate, now, tls);
  const days = tlsDaysLeft(certificate, now);
  const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const expiry =
    certificate.validTo <= now
      ? `Expired ${plural(Math.max(1, -days))} ago`
      : `Expires in ${plural(days)}`;
  if (!certificate.trusted && certificate.validTo > now) {
    return { level, text: `Not trusted · ${expiry}` };
  }
  if (!certificate.hostnameMatches) return { level, text: `Wrong hostname · ${expiry}` };
  return { level, text: expiry };
}

/** The Hosted Sites a Container serves. */
export function sitesForContainer(sites: HostedSite[], container: ContainerSummary): HostedSite[] {
  return sites.filter((site) => site.containerId === container.id);
}

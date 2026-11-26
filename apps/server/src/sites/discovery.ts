import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  MAX_SITE_URL_LENGTH,
  MAX_SITES_PER_CONTAINER,
  type ContainerSummary,
  type SiteSource,
} from '@lookout/shared';
import { parseSiteUrl } from '../config.ts';
import { isInternalAddress, isLocalName } from './address.ts';

/** A Container label naming a Hosted Site URL (several may be comma-separated). */
export const URL_LABEL = 'lookout.url';
/** `lookout.check: public` checks the Container's Hosted Sites through public DNS. */
export const CHECK_LABEL = 'lookout.check';

/** A Hosted Site to check: only ever built from operator config and Container labels. */
export interface SiteTarget {
  id: string;
  url: string;
  sources: SiteSource[];
  containerId: string | null;
  containerName: string | null;
  checkPublic: boolean;
  /**
   * Why Lookout will not check it, shown on the Websites page as its error, or null. Only
   * ever set on a Hosted Site from labels; LOOKOUT_SITES is the operator's and never refused.
   */
  refusal: string | null;
}

/** Something discovery skipped, for the server log at debug level. */
export interface SkippedSite {
  container: string;
  reason: string;
}

/** A Hosted Site's ID: the first 16 hex characters of the URL's SHA-256. */
export function siteId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** A hostname Lookout will check: letters, digits, dots and hyphens, with no wildcard. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * The hostnames in a Traefik router rule: every `Host(...)` matcher, including several
 * arguments (Traefik v2) and several matchers joined with `||`. `HostRegexp`, `HostSNI`
 * and negated `!Host(...)` matchers are ignored. Null when the rule has no usable host.
 */
export function traefikRuleHosts(rule: string): string[] | null {
  const hosts: string[] = [];
  for (const match of rule.matchAll(/(!\s*)?\bHost\(([^)]*)\)/g)) {
    if (match[1]) continue;
    for (const arg of match[2]!.split(',')) {
      const host = arg
        .trim()
        .replace(/^[`"']|[`"']$/g, '')
        .toLowerCase();
      if (HOSTNAME.test(host) && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts.length > 0 ? hosts : null;
}

const ROUTER_RULE = /^traefik\.http\.routers\.([^.]+)\.rule$/;
const SECURE_ENTRYPOINT = /^(websecure|https|web-secure|secure|tls|ssl|443)$/i;

/**
 * Whether a Traefik router serves https: it has `tls=true` or any `tls.*` option, or one
 * of its entrypoints is conventionally the https one (websecure, https, 443).
 */
export function traefikRouterIsHttps(labels: Record<string, string>, router: string): boolean {
  const prefix = `traefik.http.routers.${router}.`;
  if (labels[`${prefix}tls`]?.trim().toLowerCase() === 'true') return true;
  if (Object.keys(labels).some((key) => key.startsWith(`${prefix}tls.`))) return true;
  const entrypoints = labels[`${prefix}entrypoints`] ?? '';
  return entrypoints.split(',').some((name) => SECURE_ENTRYPOINT.test(name.trim()));
}

/** Hosted Site URLs from a Container's Traefik routers. */
export function traefikSites(container: ContainerSummary, skipped: SkippedSite[]): string[] {
  const labels = container.labels;
  if (labels['traefik.enable']?.trim().toLowerCase() === 'false') return [];
  const urls: string[] = [];
  for (const [key, rule] of Object.entries(labels)) {
    const router = ROUTER_RULE.exec(key)?.[1];
    if (router === undefined) continue;
    const hosts = traefikRuleHosts(rule);
    if (hosts === null) {
      skipped.push({ container: container.name, reason: `router ${router} has no Host() rule` });
      continue;
    }
    const scheme = traefikRouterIsHttps(labels, router) ? 'https' : 'http';
    for (const host of hosts) {
      const url = `${scheme}://${host}/`;
      if (!urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** Hosted Site URLs from a Container's `lookout.url` label. */
export function labelSites(container: ContainerSummary, skipped: SkippedSite[]): string[] {
  const value = container.labels[URL_LABEL];
  if (value === undefined) return [];
  const urls: string[] = [];
  for (const raw of value.split(',').map((part) => part.trim())) {
    if (raw === '') continue;
    if (raw.length > MAX_SITE_URL_LENGTH) {
      skipped.push({
        container: container.name,
        reason: `${URL_LABEL} names a URL over ${MAX_SITE_URL_LENGTH} characters`,
      });
      continue;
    }
    const parsed = parseSiteUrl(raw);
    if ('problem' in parsed) {
      skipped.push({ container: container.name, reason: `${URL_LABEL} ${parsed.problem}` });
    } else if (!urls.includes(parsed.url)) {
      urls.push(parsed.url);
    }
  }
  return urls;
}

/** Ports a check at the Host may always use: the web's own. */
const WEB_PORTS: ReadonlySet<number> = new Set([80, 443]);

/**
 * Why a Hosted Site a Container's labels name must not be checked, or null (#103). The
 * labels may be an Image publisher's, so they must not choose what Lookout reaches:
 *
 * - at the Host (the default), only ports 80 and 443 and the ports the Container itself
 *   publishes on the Host, never another service's loopback port;
 * - in public mode, never an internal address (checkSite also refuses any a name resolves to).
 */
export function labelRefusal(
  url: string,
  container: ContainerSummary,
  checkPublic: boolean,
): string | null {
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (checkPublic) {
    if (isLocalName(hostname) || (isIP(hostname) !== 0 && isInternalAddress(hostname))) {
      return 'Not checked: public mode never connects to an internal address';
    }
    return null;
  }
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (WEB_PORTS.has(port)) return null;
  if (container.ports.some((published) => published.publicPort === port)) return null;
  return `Not checked: port ${port} is not one this Container publishes; list the URL in LOOKOUT_SITES to check it`;
}

/**
 * Every Hosted Site: discovered from Traefik router labels, named by `lookout.url` labels,
 * and listed in LOOKOUT_SITES. The same URL from several places is one Hosted Site.
 * Containers are visited by name so the result does not depend on Docker's order.
 */
export function discoverSites(
  containers: ContainerSummary[],
  envUrls: string[],
): { sites: SiteTarget[]; skipped: SkippedSite[] } {
  const byUrl = new Map<string, SiteTarget>();
  const skipped: SkippedSite[] = [];

  const add = (url: string, source: SiteSource, container: ContainerSummary | null) => {
    const existing = byUrl.get(url);
    const checkPublic = container?.labels[CHECK_LABEL]?.trim().toLowerCase() === 'public';
    const refusal = container ? labelRefusal(url, container, checkPublic) : null;
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (existing.containerId === null && container) {
        existing.containerId = container.id;
        existing.containerName = container.name;
      }
      if (existing.sources.includes('env')) return;
      // Checked if any Container that names it may have it checked.
      if (existing.refusal !== null && refusal === null) {
        existing.refusal = null;
        existing.checkPublic = checkPublic;
      } else if (refusal === null) {
        existing.checkPublic ||= checkPublic;
      }
      return;
    }
    byUrl.set(url, {
      id: siteId(url),
      url,
      sources: [source],
      containerId: container?.id ?? null,
      containerName: container?.name ?? null,
      checkPublic,
      refusal,
    });
  };

  const sorted = [...containers].sort((a, b) => a.name.localeCompare(b.name));
  for (const container of sorted) {
    const urls: [string, SiteSource][] = traefikSites(container, skipped).map((url) => [
      url,
      'traefik',
    ]);
    for (const url of labelSites(container, skipped)) urls.push([url, 'label']);
    // One Container's labels name at most MAX_SITES_PER_CONTAINER Hosted Sites (#104).
    if (urls.length > MAX_SITES_PER_CONTAINER) {
      skipped.push({
        container: container.name,
        reason: `names ${urls.length} Hosted Sites; only the first ${MAX_SITES_PER_CONTAINER} are checked`,
      });
    }
    for (const [url, source] of urls.slice(0, MAX_SITES_PER_CONTAINER)) add(url, source, container);
  }
  for (const url of envUrls) {
    add(url, 'env', null);
    // LOOKOUT_SITES is the operator's: checked as configured, at the Host, never refused.
    const site = byUrl.get(url)!;
    site.checkPublic = false;
    site.refusal = null;
  }

  const order: Record<SiteSource, number> = { traefik: 0, label: 1, env: 2 };
  const sites = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  for (const site of sites) site.sources.sort((a, b) => order[a] - order[b]);
  return { sites, skipped };
}

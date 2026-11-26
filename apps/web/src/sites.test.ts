import { describe, expect, it } from 'vitest';
import { DAY_MS, DEFAULT_TLS_THRESHOLDS, type TlsCertificate } from '@lookout/shared';
import {
  NO_SITE_FILTERS,
  countSites,
  filterSites,
  siteResultText,
  siteSinceText,
  sortSites,
  tlsSummary,
} from './sites.ts';
import { hostedSite } from './test-support.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const tls = DEFAULT_TLS_THRESHOLDS;
const cert = (overrides: Partial<TlsCertificate> = {}): TlsCertificate => ({
  subject: 'shop.example',
  issuer: "Let's Encrypt",
  validTo: NOW + 45 * DAY_MS,
  hostnameMatches: true,
  trusted: true,
  error: null,
  ...overrides,
});
const withTls = (url: string, certificate: TlsCertificate, status: 'up' | 'down' = 'up') => {
  const site = hostedSite({ url, status });
  return { ...site, last: { ...site.last!, tls: certificate } };
};

const sites = [
  hostedSite({ url: 'https://shop.example/', containerName: 'shop-web-1', containerId: 'c1' }),
  hostedSite({ url: 'https://blog.example/', status: 'down' }),
  hostedSite({ url: 'http://wiki.example/', status: 'slow' }),
  withTls('https://cert.example/', cert({ validTo: NOW + 5 * DAY_MS })),
  hostedSite({ url: 'https://new.example/', status: 'pending' }),
];

describe('Hosted Site helpers', () => {
  it('filters by URL or Container name, status and Flagged only', () => {
    const urls = (filters: Partial<typeof NO_SITE_FILTERS>) =>
      filterSites(sites, { ...NO_SITE_FILTERS, ...filters }, NOW, tls).map((s) => s.url);
    expect(urls({ text: 'SHOP-WEB' })).toEqual(['https://shop.example/']);
    expect(urls({ text: 'wiki' })).toEqual(['http://wiki.example/']);
    expect(urls({ status: 'down' })).toEqual(['https://blog.example/']);
    expect(urls({ flaggedOnly: true })).toEqual(['https://blog.example/', 'https://cert.example/']);
  });

  it('sorts Flagged Hosted Sites first, then by URL', () => {
    expect(sortSites(sites, NOW, tls).map((s) => s.url)).toEqual([
      'https://blog.example/',
      'https://cert.example/',
      'http://wiki.example/',
      'https://new.example/',
      'https://shop.example/',
    ]);
  });

  it('counts up (including slow), down and Flagged', () => {
    expect(countSites(sites, NOW, tls)).toEqual({ total: 5, up: 3, down: 1, flagged: 2 });
  });

  it('describes the result, a redirect and an error', () => {
    expect(siteResultText(sites[0]!)).toBe('200');
    const redirect = hostedSite({ url: 'http://a.example/' });
    redirect.last = { ...redirect.last!, statusCode: 301, redirect: 'https://a.example/' };
    expect(siteResultText(redirect)).toBe('301 → https://a.example/');
    const refused = hostedSite({ url: 'http://b.example/', status: 'down' });
    refused.last = { ...refused.last!, statusCode: null, error: 'Connection refused' };
    expect(siteResultText(refused)).toBe('Connection refused');
    expect(siteResultText(sites[4]!)).toBe('—');
  });

  it('says how long a Hosted Site has been up or down', () => {
    const down = hostedSite({ url: 'http://a.example/', status: 'down', downSince: NOW - 300_000 });
    expect(siteSinceText(down, NOW)).toBe('Down for 5m');
    const up = hostedSite({ url: 'http://a.example/', upSince: NOW - 2 * 3_600_000 });
    expect(siteSinceText(up, NOW)).toBe('Up for 2h 0m');
    expect(siteSinceText(sites[4]!, NOW)).toBe('Checking…');
  });

  it('summarises TLS', () => {
    expect(tlsSummary(sites[2]!, NOW, tls)).toEqual({ level: 'ok', text: 'No TLS' });
    expect(tlsSummary(withTls('https://a.example/', cert()), NOW, tls)).toEqual({
      level: 'ok',
      text: 'Expires in 45 days',
    });
    expect(tlsSummary(sites[3]!, NOW, tls)).toEqual({
      level: 'critical',
      text: 'Expires in 5 days',
    });
    expect(
      tlsSummary(withTls('https://a.example/', cert({ validTo: NOW + 10 * DAY_MS })), NOW, tls),
    ).toEqual({ level: 'warn', text: 'Expires in 10 days' });
    expect(
      tlsSummary(
        withTls('https://a.example/', cert({ trusted: false, error: 'SELF_SIGNED' }), 'down'),
        NOW,
        tls,
      ),
    ).toEqual({ level: 'critical', text: 'Not trusted · Expires in 45 days' });
    expect(
      tlsSummary(withTls('https://a.example/', cert({ validTo: NOW - 2 * DAY_MS })), NOW, tls),
    ).toEqual({ level: 'critical', text: 'Expired 2 days ago' });
    expect(tlsSummary(sites[4]!, NOW, tls)).toBeNull();
  });

  it('counts a short-lived certificate in hours and does not flag it while it renews', () => {
    const hour = DAY_MS / 24;
    const caddy = cert({ validFrom: NOW - 7 * hour, validTo: NOW + 5 * hour });
    expect(tlsSummary(withTls('https://a.example/', caddy), NOW, tls)).toEqual({
      level: 'ok',
      text: 'Expires in 5 hours',
    });
  });
});

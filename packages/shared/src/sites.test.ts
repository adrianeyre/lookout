import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  isSiteFlagged,
  siteFlagReason,
  siteStatusFor,
  tlsDaysLeft,
  tlsLevel,
  type TlsCertificate,
} from './sites.ts';

const thresholds = { warnDays: 14, criticalDays: 7 };
/** A fixed clock: noon on 25 November 2026. */
const NOW = Date.parse('2026-11-25T12:00:00Z');

const certificate = (overrides: Partial<TlsCertificate> = {}): TlsCertificate => ({
  subject: 'shop.example',
  issuer: "Let's Encrypt",
  validTo: NOW + 60 * DAY_MS,
  hostnameMatches: true,
  trusted: true,
  error: null,
  ...overrides,
});

describe('tlsLevel', () => {
  it.each([
    [60, 'ok'],
    [14.5, 'ok'],
    [14, 'warn'],
    [8, 'warn'],
    [7.01, 'warn'],
    [7, 'critical'],
    [5, 'critical'],
    [0.5, 'critical'],
    [-1, 'critical'],
  ] as const)('a certificate expiring in %s days is %s', (days, level) => {
    expect(tlsLevel(certificate({ validTo: NOW + days * DAY_MS }), NOW, thresholds)).toBe(level);
  });

  it('is red when the certificate is untrusted or does not match, whatever its expiry', () => {
    expect(tlsLevel(certificate({ trusted: false, error: 'SELF_SIGNED' }), NOW, thresholds)).toBe(
      'critical',
    );
    expect(tlsLevel(certificate({ hostnameMatches: false }), NOW, thresholds)).toBe('critical');
  });

  it('follows the configured thresholds', () => {
    const cert = certificate({ validTo: NOW + 20 * DAY_MS });
    expect(tlsLevel(cert, NOW, { warnDays: 30, criticalDays: 21 })).toBe('critical');
    expect(tlsLevel(cert, NOW, { warnDays: 30, criticalDays: 10 })).toBe('warn');
  });

  it('is ok for an http Hosted Site, which has no certificate', () => {
    expect(tlsLevel(null, NOW, thresholds)).toBe('ok');
  });

  it('counts days left, rounding up', () => {
    expect(tlsDaysLeft(certificate({ validTo: NOW + 4.2 * DAY_MS }), NOW)).toBe(5);
    expect(tlsDaysLeft(certificate({ validTo: NOW + 5 * DAY_MS }), NOW)).toBe(5);
    expect(tlsDaysLeft(certificate({ validTo: NOW - 0.5 * DAY_MS }), NOW)).toBe(0);
    expect(tlsDaysLeft(certificate({ validTo: NOW - 2 * DAY_MS }), NOW)).toBe(-2);
  });
});

describe('siteStatusFor', () => {
  it.each([
    [200, 100, 'up'],
    [301, 100, 'up'],
    [401, 100, 'up'],
    [404, 100, 'up'],
    [499, 100, 'up'],
    [200, 2001, 'slow'],
    [200, 2000, 'up'],
    [500, 100, 'down'],
    [503, 5000, 'down'],
    [null, null, 'down'],
  ] as const)('%s in %s ms is %s', (code, ms, status) => {
    expect(siteStatusFor(code, ms, 2000)).toBe(status);
  });
});

describe('Flagged Hosted Sites', () => {
  const site = (status: 'up' | 'slow' | 'down', tls: TlsCertificate | null = null) => ({
    status,
    last: {
      timestamp: NOW,
      status,
      statusCode: 200,
      error: null,
      responseMs: 10,
      redirect: null,
      tls,
    },
  });

  it('flags a down Hosted Site or a certificate at red, and nothing else', () => {
    expect(isSiteFlagged(site('down'), NOW, thresholds)).toBe(true);
    expect(isSiteFlagged(site('up'), NOW, thresholds)).toBe(false);
    expect(isSiteFlagged(site('slow'), NOW, thresholds)).toBe(false);
    const amber = certificate({ validTo: NOW + 10 * DAY_MS });
    expect(isSiteFlagged(site('up', amber), NOW, thresholds)).toBe(false);
    const red = certificate({ validTo: NOW + 5 * DAY_MS });
    expect(isSiteFlagged(site('up', red), NOW, thresholds)).toBe(true);
    expect(isSiteFlagged({ status: 'pending', last: null }, NOW, thresholds)).toBe(false);
  });

  it('says why', () => {
    expect(siteFlagReason(site('down'), NOW, thresholds)).toBe('Down');
    expect(siteFlagReason(site('up'), NOW, thresholds)).toBeNull();
    const expired = certificate({ validTo: NOW - DAY_MS, error: 'CERT_HAS_EXPIRED' });
    expect(siteFlagReason(site('up', expired), NOW, thresholds)).toBe('Certificate expired');
    const untrusted = certificate({ trusted: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' });
    expect(siteFlagReason(site('up', untrusted), NOW, thresholds)).toBe('Certificate not trusted');
    const mismatch = certificate({ hostnameMatches: false });
    expect(siteFlagReason(site('up', mismatch), NOW, thresholds)).toBe("Certificate doesn't match");
    const soon = certificate({ validTo: NOW + 3 * DAY_MS });
    expect(siteFlagReason(site('up', soon), NOW, thresholds)).toBe('Certificate expiring');
  });
});

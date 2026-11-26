import { describe, expect, it } from 'vitest';
import { makeContainer } from '../../test-support/fake-docker.ts';
import { summaryOf } from '../docker/parse.ts';
import {
  discoverSites,
  siteId,
  traefikRouterIsHttps,
  traefikRuleHosts,
  type SkippedSite,
} from './discovery.ts';

const container = (name: string, labels: Record<string, string>) =>
  summaryOf(makeContainer({ id: `id-${name}`, name, labels }));

describe('traefikRuleHosts', () => {
  it.each([
    ['Host(`shop.example`)', ['shop.example']],
    ['Host(`shop.example`) || Host(`www.shop.example`)', ['shop.example', 'www.shop.example']],
    ['Host(`Shop.Example`) && PathPrefix(`/api`)', ['shop.example']],
    ['(Host(`a.example`) || Host(`b.example`)) && Method(`GET`)', ['a.example', 'b.example']],
    // Traefik v2 allowed several hosts in one matcher.
    ['Host(`a.example`, `b.example`)', ['a.example', 'b.example']],
    ['Host("quoted.example")', ['quoted.example']],
    ['Host(`a.example`) || Host(`a.example`)', ['a.example']],
  ])('%s → %j', (rule, hosts) => {
    expect(traefikRuleHosts(rule)).toEqual(hosts);
  });

  it.each([
    ['PathPrefix(`/api`)'],
    ['HostRegexp(`^.+\\.example\\.com$`)'],
    ['HostSNI(`*`)'],
    ['!Host(`internal.example`) && PathPrefix(`/`)'],
    ['Host(`*.example.com`)'],
    ['Host(``)'],
    [''],
  ])('skips %s', (rule) => {
    expect(traefikRuleHosts(rule)).toBeNull();
  });
});

describe('traefikRouterIsHttps', () => {
  it.each([
    [{ 'traefik.http.routers.web.tls': 'true' }, true],
    [{ 'traefik.http.routers.web.tls.certresolver': 'letsencrypt' }, true],
    [{ 'traefik.http.routers.web.entrypoints': 'websecure' }, true],
    [{ 'traefik.http.routers.web.entrypoints': 'web, https' }, true],
    [{ 'traefik.http.routers.web.entrypoints': 'web' }, false],
    [{ 'traefik.http.routers.web.tls': 'false' }, false],
    [{ 'traefik.http.routers.other.tls': 'true' }, false],
    [{}, false],
  ])('%j → %s', (labels, https) => {
    expect(traefikRouterIsHttps(labels, 'web')).toBe(https);
  });
});

describe('discoverSites', () => {
  // A real Traefik v3 Compose label set: one https router with two hosts, an http router
  // that only redirects, and a path-only API router.
  const shop = container('shop-web-1', {
    'com.docker.compose.project': 'shop',
    'traefik.enable': 'true',
    'traefik.http.routers.shop.rule': 'Host(`shop.example`) || Host(`www.shop.example`)',
    'traefik.http.routers.shop.entrypoints': 'websecure',
    'traefik.http.routers.shop.tls.certresolver': 'letsencrypt',
    'traefik.http.routers.shop-http.rule': 'Host(`legacy.shop.example`)',
    'traefik.http.routers.shop-http.entrypoints': 'web',
    'traefik.http.routers.shop-http.middlewares': 'redirect-to-https@file',
    'traefik.http.routers.shop-api.rule': 'PathPrefix(`/api`)',
    'traefik.http.services.shop.loadbalancer.server.port': '8080',
  });

  it('discovers each Traefik host as a Hosted Site linked to its Container', () => {
    const { sites, skipped } = discoverSites([shop], []);
    expect(sites.map((site) => site.url)).toEqual([
      'http://legacy.shop.example/',
      'https://shop.example/',
      'https://www.shop.example/',
    ]);
    expect(sites[0]).toEqual({
      id: siteId('http://legacy.shop.example/'),
      url: 'http://legacy.shop.example/',
      sources: ['traefik'],
      containerId: 'id-shop-web-1',
      containerName: 'shop-web-1',
      checkPublic: false,
      refusal: null,
    });
    expect(skipped).toEqual<SkippedSite[]>([
      { container: 'shop-web-1', reason: 'router shop-api has no Host() rule' },
    ]);
  });

  it('skips Containers with traefik.enable=false', () => {
    const disabled = container('hidden', {
      'traefik.enable': 'false',
      'traefik.http.routers.hidden.rule': 'Host(`hidden.example`)',
    });
    expect(discoverSites([disabled], []).sites).toEqual([]);
  });

  it('skips HostRegexp routers', () => {
    const wildcard = container('wild', {
      'traefik.http.routers.wild.rule': 'HostRegexp(`^[a-z]+\\.example\\.com$`)',
    });
    const { sites, skipped } = discoverSites([wildcard], []);
    expect(sites).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it('merges a lookout.url label and a LOOKOUT_SITES entry with the discovered Hosted Site', () => {
    const labelled = container('shop-web-1', {
      ...shop.labels,
      'lookout.url': 'https://shop.example/, https://status.shop.example/health',
    });
    const { sites } = discoverSites(
      [labelled],
      ['https://shop.example/', 'https://elsewhere.example/'],
    );
    expect(sites.map((site) => [site.url, site.sources, site.containerName])).toEqual([
      ['http://legacy.shop.example/', ['traefik'], 'shop-web-1'],
      ['https://elsewhere.example/', ['env'], null],
      ['https://shop.example/', ['traefik', 'label', 'env'], 'shop-web-1'],
      ['https://status.shop.example/health', ['label'], 'shop-web-1'],
      ['https://www.shop.example/', ['traefik'], 'shop-web-1'],
    ]);
  });

  it('links an env Hosted Site to the Container that also names it', () => {
    const blog = container('blog', { 'lookout.url': 'http://blog.example:8080/' });
    const { sites } = discoverSites([blog], ['http://blog.example:8080/']);
    expect(sites).toEqual([
      expect.objectContaining({ sources: ['label', 'env'], containerId: 'id-blog' }),
    ]);
  });

  it('checks a Container’s Hosted Sites through public DNS with lookout.check: public', () => {
    const external = container('external', {
      'lookout.url': 'https://external.example/',
      'lookout.check': 'public',
    });
    expect(discoverSites([external], []).sites[0]!.checkPublic).toBe(true);
  });

  it('skips an invalid or non-http lookout.url label, with a reason', () => {
    const bad = container('bad', { 'lookout.url': 'ftp://files.example/, not a url' });
    const { sites, skipped } = discoverSites([bad], []);
    expect(sites).toEqual([]);
    expect(skipped.map((skip) => skip.reason)).toEqual([
      'lookout.url uses ftp; only http and https are checked',
      'lookout.url is not a valid URL',
    ]);
  });

  it('gives each URL a stable 16-character hex ID', () => {
    expect(siteId('https://shop.example/')).toMatch(/^[0-9a-f]{16}$/);
    expect(siteId('https://shop.example/')).toBe(siteId('https://shop.example/'));
    expect(siteId('https://shop.example/')).not.toBe(siteId('http://shop.example/'));
  });
});

describe('discoverSites: what labels may make Lookout check (#103, #104, #121)', () => {
  const published = (name: string, labels: Record<string, string>, ports: number[]) =>
    summaryOf(
      makeContainer({
        id: `id-${name}`,
        name,
        labels,
        ports: ports.map((port) => ({
          privatePort: port,
          publicPort: port,
          protocol: 'tcp' as const,
          ip: '0.0.0.0',
        })),
      }),
    );

  it('at the Host, refuses a port the Container does not publish, but not 80, 443 or its own', () => {
    const { sites } = discoverSites(
      [
        published(
          'app',
          {
            'lookout.url': [
              'http://app.example/',
              'https://app.example/',
              'http://app.example:8080/',
              'http://admin.internal:2375/containers/json',
            ].join(','),
          },
          [8080],
        ),
      ],
      [],
    );
    const refusals = Object.fromEntries(sites.map((site) => [site.url, site.refusal]));
    expect(refusals['http://app.example/']).toBeNull();
    expect(refusals['https://app.example/']).toBeNull();
    expect(refusals['http://app.example:8080/']).toBeNull();
    expect(refusals['http://admin.internal:2375/containers/json']).toMatch(
      /^Not checked: port 2375 is not one this Container publishes/,
    );
  });

  it('in public mode, refuses internal addresses and localhost names, and keeps public names', () => {
    const { sites } = discoverSites(
      [
        container('img', {
          'lookout.check': 'public',
          'lookout.url': [
            'http://169.254.169.254/latest/meta-data/',
            'http://[fd00:ec2::254]/',
            'http://localhost:9000/',
            'http://[::ffff:127.0.0.1]/',
            'https://shop.example/',
          ].join(','),
        }),
      ],
      [],
    );
    const refused = sites.filter((site) => site.refusal !== null).map((site) => site.url);
    expect(refused).toHaveLength(4);
    expect(sites.find((site) => site.url === 'https://shop.example/')?.refusal).toBeNull();
  });

  it('never refuses LOOKOUT_SITES, and a label cannot change how one is checked', () => {
    const { sites } = discoverSites(
      [
        container('img', {
          'lookout.check': 'public',
          'lookout.url': 'http://192.168.1.10:8080/',
        }),
      ],
      ['http://192.168.1.10:8080/'],
    );
    expect(sites).toEqual([
      expect.objectContaining({
        url: 'http://192.168.1.10:8080/',
        sources: ['label', 'env'],
        checkPublic: false,
        refusal: null,
      }),
    ]);
  });

  it('takes at most 20 Hosted Sites from one Container, saying so', () => {
    const urls = Array.from({ length: 30 }, (_, i) => `http://h${i}.example/`);
    const { sites, skipped } = discoverSites(
      [container('crowd', { 'lookout.url': urls.join(',') })],
      [],
    );
    expect(sites).toHaveLength(20);
    expect(skipped).toContainEqual({
      container: 'crowd',
      reason: 'names 30 Hosted Sites; only the first 20 are checked',
    });
  });

  it('skips a label URL over 2,048 characters', () => {
    const long = `http://long.example/${'a'.repeat(2048)}`;
    const { sites, skipped } = discoverSites(
      [container('long', { 'lookout.url': `${long},http://ok.example/` })],
      [],
    );
    expect(sites.map((site) => site.url)).toEqual(['http://ok.example/']);
    expect(skipped).toContainEqual({
      container: 'long',
      reason: 'lookout.url names a URL over 2048 characters',
    });
  });
});

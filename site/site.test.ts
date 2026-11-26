import { describe, expect, it } from 'vitest';
import { fillPlaceholders, siteConfig } from './build.ts';
import { inline, renderChangelog } from './changelog.ts';
import { expandPictures } from './pictures.ts';
import { DESCRIPTION, FAQS, TITLE, faqHtml, seoFiles, seoHead, structuredData } from './seo.ts';

const config = siteConfig('https://github.com/adrianeyre/lookout', 'lookout.example.com');

describe('the SiteConfig', () => {
  it('derives every URL from the repo and the domain', () => {
    expect(config).toMatchObject({
      siteUrl: 'https://lookout.example.com',
      repoPath: 'adrianeyre/lookout',
      image: 'ghcr.io/adrianeyre/lookout',
      rawUrl: 'https://raw.githubusercontent.com/adrianeyre/lookout/main',
    });
  });

  it('fails the build on an unknown placeholder', () => {
    expect(() => fillPlaceholders('%NOPE%', {})).toThrow(/NOPE/);
  });
});

describe('SEO', () => {
  it('keeps the title and description short enough for search results', () => {
    expect(TITLE.length).toBeLessThanOrEqual(60);
    expect(DESCRIPTION.length).toBeLessThanOrEqual(160);
  });

  it('gives link previews an absolute title, description and image', () => {
    const head = seoHead(config);
    expect(head).toContain('<link rel="canonical" href="https://lookout.example.com/" />');
    expect(head).toContain(
      '<meta property="og:image" content="https://lookout.example.com/og-image.png" />',
    );
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(head).toContain('rel="apple-touch-icon"');
    expect(head).toContain('rel="manifest"');
  });

  it('never lets the JSON-LD close its script element', () => {
    const head = seoHead(config);
    const json = /<script type="application\/ld\+json">(.*)<\/script>/.exec(head)?.[1] ?? '';
    expect(json).not.toContain('<');
    expect((JSON.parse(json) as { '@graph': unknown[] })['@graph']).toHaveLength(6);
  });

  it('shows the same FAQ on the page and in the structured data', () => {
    const graph = structuredData(config)['@graph'] as { '@type': string; mainEntity?: unknown[] }[];
    const faq = graph.find((node) => node['@type'] === 'FAQPage');
    expect(faq?.mainEntity).toHaveLength(FAQS.length);
    for (const item of FAQS) expect(faqHtml()).toContain(item.question);
  });

  it('writes a sitemap with images, a manifest with maskable icons, and robots.txt', () => {
    const files = seoFiles(config, '2026-11-25');
    expect(files['sitemap.xml']).toContain('<lastmod>2026-11-25</lastmod>');
    expect(files['sitemap.xml']).toContain(
      '<image:loc>https://lookout.example.com/og-image.png</image:loc>',
    );
    expect(files['robots.txt']).toContain('Sitemap: https://lookout.example.com/sitemap.xml');
    const manifest = JSON.parse(files['site.webmanifest']!) as { icons: { purpose: string }[] };
    expect(manifest.icons.map((icon) => icon.purpose)).toEqual(
      expect.arrayContaining(['any', 'maskable', 'monochrome']),
    );
    expect(files['browserconfig.xml']).toContain('<TileColor>');
  });
});

describe('the changelog', () => {
  const markdown = `# Changelog

## [1.1.0](https://github.com/adrianeyre/lookout/compare/v1.0.0...v1.1.0) (2026-12-01)

### Features

* **site:** a telescope ([abc1234](https://github.com/adrianeyre/lookout/commit/abc1234))

## 1.0.0 (2026-11-30)

* first release
`;

  it('reads the newest version and renders each release', () => {
    const { version, html } = renderChangelog(markdown, 'https://example.com/releases');
    expect(version).toBe('1.1.0');
    expect(html).toContain('<h4>Features</h4>');
    expect(html).toContain('<strong>site:</strong> a telescope');
    expect(html).toContain('<h3>1.0.0 (2026-11-30)</h3>');
  });

  it('says so before the first release', () => {
    expect(renderChangelog('', 'https://example.com/releases')).toMatchObject({ version: null });
  });

  it('escapes HTML and keeps only http(s) links', () => {
    expect(inline('<script> [x](javascript:alert(1)) `<b>`')).toBe(
      '&lt;script&gt; [x](javascript:alert(1)) <code>&lt;b&gt;</code>',
    );
  });

  it('shows at most the given number of releases', () => {
    expect(renderChangelog(markdown, 'https://example.com/r', 1).html).not.toContain('<h3>1.0.0');
  });
});

describe('screenshots', () => {
  it('serve AVIF and WebP in both themes, with the PNG as the fallback', () => {
    const html = expandPictures('<img data-shot="host-desktop" sizes="50vw" alt="Host" />');
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
    expect(html).toContain('/images/host-dark-desktop-640.avif 640w');
    expect(html).toContain('/images/host-light-desktop.webp 1280w');
    expect(html).toContain('src="/images/host-light-desktop.png" width="1280" height="860"');
    expect(html).toContain('alt="Host"');
    expect(html).not.toContain('data-shot');
  });

  it('can always show one theme', () => {
    const html = expandPictures('<img data-shot="host-phone" data-theme="dark" alt="" />');
    expect(html).not.toContain('light');
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toContain('src="/images/host-dark-phone.png" width="390" height="844"');
  });
});

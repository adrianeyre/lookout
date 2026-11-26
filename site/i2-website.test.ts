/**
 * Pen-test scope issue I2 (#71), the Project Website's half: the changelog inserted as HTML
 * (H13's website half), the site's Content Security Policy, the images it publishes and the
 * vendored Stageshow kit. The workflows' half is
 * apps/server/src/pen-test/probes/i2-supply-chain.test.ts. Findings are in
 * docs/pen-test/findings/I2.md. While a gap is open, an `it.fails` states the property that
 * should hold beside a `today_…` test pinning what happens now.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as build from './build.ts';
import { fillPlaceholders, verbatimFiles } from './build.ts';
import { renderChangelog } from './changelog.ts';
import { expandPictures } from './pictures.ts';

const SITE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.join(SITE, '..');

/** Pull-request titles as semantic-release writes them, each trying to become markup. */
const HOSTILE_TITLES = [
  `"><img src=x onerror=alert(1)>`,
  `' onmouseover='alert(1)`,
  '<script>alert(1)</script>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](data:text/html,<script>alert(1)</script>)',
  '[click](//evil.example/x)',
  '[a [nested](https://evil.example/) b](https://evil.example/)',
  '[x](https://evil.example/" onclick="alert(1))',
  '[**<b>bold</b>**](https://evil.example/)',
  '`<svg onload=alert(1)>`',
  '``nested `back` ticks``',
  '%TITLE% and %CHANGELOG% and $& and $1',
  '<img data-shot="host" src=x>',
  '&lt;script&gt; already escaped',
];

function changelogWith(titles: string[]): string {
  return [
    '# Changelog',
    '',
    '## [1.2.0](https://github.com/adrianeyre/lookout/compare/v1.1.0...v1.2.0) (2026-11-25)',
    '',
    '### Features',
    '',
    ...titles.map(
      (t, i) =>
        `* ${t} ([#${i + 1}](https://github.com/adrianeyre/lookout/issues/${i + 1})) ([abc${i}](https://github.com/adrianeyre/lookout/commit/abc${i}))`,
    ),
    '',
  ].join('\n');
}

const ALLOWED_TAGS = new Set(['h3', 'h4', 'ul', 'li', 'p', 'a', 'strong', 'code']);

describe('I2 H13 (website half): the changelog the site inserts as HTML', () => {
  it('renders hostile pull-request titles as text, with only http(s) links, through the site build', async () => {
    const changelog = renderChangelog(
      changelogWith(HOSTILE_TITLES),
      'https://github.com/adrianeyre/lookout/releases',
    );
    // As site/build.ts does: fill the placeholders, then expand the pictures.
    const page = expandPictures(
      fillPlaceholders('<div id="c">%CHANGELOG%</div><p>%TITLE%</p>', {
        CHANGELOG: changelog.html,
        TITLE: 'Lookout',
      }),
    );
    const inserted = page.slice('<div id="c">'.length, page.lastIndexOf('</div>'));
    expect(inserted).toBe(changelog.html);
    expect(inserted.match(/<li>/g)).toHaveLength(HOSTILE_TITLES.length);
    expect(page).not.toMatch(/<picture|<script|<img|<svg|<b>/i);
    for (const [, close, tag, attrs] of inserted.matchAll(/<(\/?)(\w+)([^>]*)>/g)) {
      expect(ALLOWED_TAGS, tag).toContain(tag!.toLowerCase());
      if (close) continue;
      const names = [...attrs!.matchAll(/\s([^\s=]+)=/g)].map((m) => m[1]!.toLowerCase());
      if (tag === 'a') {
        expect(names.sort()).toEqual(['href', 'rel', 'target']);
        const href = /href="([^"]*)"/.exec(attrs!)![1]!;
        expect(href).toMatch(/^https?:\/\//);
      } else {
        expect(names, `${tag}${attrs}`).toEqual([]);
      }
    }
  });

  it('inserts nothing else as HTML at run time: the one innerHTML in site/ is a constant', async () => {
    const sources = (await readdir(SITE)).filter(
      (f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'),
    );
    const uses: string[] = [];
    for (const file of sources) {
      const text = await readFile(path.join(SITE, file), 'utf8');
      for (const match of text.matchAll(
        /(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*[=(][^;]*;/g,
      )) {
        uses.push(`${file}: ${match[0].replace(/\s+/g, ' ')}`);
      }
    }
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/^main\.ts: innerHTML = '<svg [^']*'\s*;$/);
  });
});

describe('I2 H13 (website half): the Project Website has a Content Security Policy', () => {
  const pages = ['index.html', '404.html'];
  const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i;

  it('sets a CSP on every page (GitHub Pages sends no headers, so a meta tag), with no inline script', async () => {
    for (const page of pages) {
      const html = await readFile(path.join(SITE, page), 'utf8');
      const policy = csp.exec(html)?.[1] ?? '';
      expect(policy, page).toMatch(/default-src 'self'/);
      expect(policy, page).toMatch(/script-src 'self'/);
      expect(policy, page).toMatch(/object-src 'none'/);
      expect(policy, page).toMatch(/base-uri 'none'/);
      expect(policy, page).not.toMatch(/unsafe-inline|unsafe-eval/);
    }
  });

  it('both pages carry the CSP, so the changelog has a defence behind its escaping (regression)', async () => {
    for (const page of pages) {
      const html = await readFile(path.join(SITE, page), 'utf8');
      expect(csp.test(html), page).toBe(true);
      expect(html.match(new RegExp(build.CSP_META.source, 'g')), page).toHaveLength(1);
    }
  });
});

describe('I2: the images the site publishes', () => {
  async function publishedImages(): Promise<string[]> {
    return (await verbatimFiles())
      .filter((f) => /\.(png|svg|ico)$/.test(f.target))
      .map((f) => path.relative(ROOT, f.source))
      .sort();
  }

  it('publishes a pinned list of images, so a new one fails a test until someone has read it', async () => {
    const published = await publishedImages();
    const listed = [
      ...build.PUBLISHED_IMAGES.docsImages.map((f) => path.join('docs/images', f)),
      ...build.PUBLISHED_IMAGES.sitePublic
        .filter((f) => /\.(png|svg|ico)$/.test(f))
        .map((f) => path.join('site/public', f)),
    ];
    expect([...published].filter((f) => !f.startsWith('apps/')).sort()).toEqual(listed.sort());
  });

  it('refuses to publish an image nobody has listed (regression)', () => {
    expect(() => build.checkPublishedImages(['real-host.png'], [])).toThrow(/real-host\.png/);
    expect(() => build.checkPublishedImages([], ['leak.png'])).toThrow(/leak\.png/);
    expect(() =>
      build.checkPublishedImages(
        [...build.PUBLISHED_IMAGES.docsImages],
        [...build.PUBLISHED_IMAGES.sitePublic],
      ),
    ).not.toThrow();
  });
});

describe('I2: the vendored Stageshow kit', () => {
  const kitReadme = path.join(SITE, 'stageshow/README.md');

  it('records where the kit came from: its upstream, version, commit and licence', async () => {
    const readme = await readFile(kitReadme, 'utf8');
    expect(readme).toMatch(/github\.com\/benjitaylor\/skills\/tree\/main\/stageshow/);
    expect(readme).toMatch(/version 1\.1\.1 \(commit `[0-9a-f]{40}`\)/);
    expect(existsSync(path.join(SITE, 'stageshow/LICENSE'))).toBe(true);
  });

  it('can show the copy is unmodified: a hash of every kit file, checked by a test', async () => {
    const manifest = await readFile(path.join(SITE, 'stageshow/SHA256SUMS'), 'utf8');
    expect(manifest).toMatch(/^[0-9a-f]{64} {2}kit\//m);
    expect(existsSync(path.join(SITE, 'stageshow.test.ts'))).toBe(true);
  });

  it('"unmodified" rests on recorded hashes, checked against upstream, not on the README\'s word (regression)', async () => {
    const files = (await readdir(path.join(SITE, 'stageshow'), { recursive: true })).filter((f) =>
      /SHA256SUMS/.test(f),
    );
    expect(files).toEqual(['SHA256SUMS']);
    expect(await readFile(kitReadme, 'utf8')).toMatch(/SHA256SUMS/);
  });
});

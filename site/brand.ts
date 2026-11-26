/**
 * `pnpm site:brand`: renders the Project Website's telescope icons and its social card into
 * site/public from the SVG sources in site/brand. Run it after changing a source, and commit
 * the output: the Pages workflow only copies these files, so it needs no browser.
 *
 * Every major platform gets the icon it asks for: favicon.ico and SVG for browsers, PNG sizes
 * for Google Search and Android, an opaque apple-touch-icon for iOS, maskable and monochrome
 * icons for Android launchers, a pinned-tab mask for Safari, and tiles for Windows.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { BRAND, ogCardHtml } from './brand/og-card.ts';
import { DOMAIN } from './build.ts';

const siteDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(siteDir, '..');
const source = (name: string) => path.join(siteDir, 'brand', name);
const out = (name: string) => path.join(siteDir, 'public', name);

const iconSvg = await readFile(source('icon.svg'), 'utf8');
// Favicon sizes use a bolder mark that stays legible at 16px.
const smallIconSvg = await readFile(source('icon-small.svg'), 'utf8');

/** The icon's shapes, without its <svg> wrapper or its rounded background. */
function mark(svg: string): string {
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<rect width="64" height="64"[^>]*\/>/, '')
    .trim();
}

/**
 * A full-bleed square: iOS and Android cut their own shape, so the background reaches every
 * edge and the mark is scaled into the safe zone (a centred circle 80% of the width).
 */
function fullBleedSvg(svg: string, scale: number): string {
  const offset = (64 * (1 - scale)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${BRAND.night}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${mark(svg)}</g>
</svg>
`;
}

/** One colour on transparent, for Android themed icons and Safari pinned tabs. */
function monochromeSvg(svg: string, colour: string, scale = 1): string {
  const shapes = mark(svg)
    .replace(/fill="#[0-9a-f]{6}"/gi, `fill="${colour}"`)
    .replace(/stroke="#[0-9a-f]{6}"/gi, `stroke="${colour}"`)
    // The ring that separates the pivot from the legs would vanish in one colour.
    .replace(/ stroke="[^"]*" stroke-width="1.6"/, '');
  const offset = (64 * (1 - scale)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <g transform="translate(${offset} ${offset}) scale(${scale})">${shapes}</g>
</svg>
`;
}

/** A Windows tile: the mark alone on transparent; the tile colour comes from browserconfig. */
function tileSvg(svg: string, width: number, height: number): string {
  const size = Math.min(width, height) * 0.62;
  const x = (width - size) / 2;
  const y = (height - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <g transform="translate(${x} ${y}) scale(${size / 64})">${mark(svg)}</g>
</svg>
`;
}

const png = (svg: string, width: number, height = width) =>
  sharp(Buffer.from(svg), { density: Math.ceil((72 * Math.max(width, height) * 2) / 64) })
    .resize(width, height)
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();

/** Packs PNG images into an .ico container (PNG-in-ICO, supported by every current browser). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

/** Renders the 1200×630 social card in a headless browser, so it uses the site's own fonts. */
async function socialCard(): Promise<Buffer> {
  // Inlined: a page opened with setContent may not load file: URLs.
  const file = async (relative: string, type: string) =>
    `data:${type};base64,${(await readFile(path.join(repoRoot, relative))).toString('base64')}`;
  const html = ogCardHtml({
    icon: iconSvg,
    inter: await file(
      'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
      'font/woff2',
    ),
    screenshot: await file('docs/images/host-dark-desktop.png', 'image/png'),
    domain: DOMAIN,
  });
  const browser = await chromium.launch({ args: ['--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const shot = await page.screenshot({ type: 'png' });
    // Social networks fetch this on every share; WhatsApp ignores images over 300 kB.
    return await sharp(shot).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
  } finally {
    await browser.close();
  }
}

const write = async (name: string, data: Buffer | string | Promise<Buffer>) =>
  writeFile(out(name), await data);

await mkdir(out(''), { recursive: true });

const appleSvg = fullBleedSvg(iconSvg, 0.86);
const maskableSvg = fullBleedSvg(iconSvg, 0.78);
const favicons = await Promise.all(
  [16, 32, 48].map(async (size) => ({ size, data: await png(smallIconSvg, size) })),
);

await Promise.all([
  // Browsers
  write('favicon.ico', ico(favicons)),
  write('favicon.svg', smallIconSvg),
  write('icon.svg', iconSvg),
  write('favicon-16x16.png', favicons[0]!.data),
  write('favicon-32x32.png', favicons[1]!.data),
  // Google Search shows a favicon that is a multiple of 48px.
  write('favicon-48x48.png', favicons[2]!.data),
  write('favicon-96x96.png', png(iconSvg, 96)),
  // iOS and iPadOS: opaque and full-bleed. Some clients still ask for the precomposed name.
  write('apple-touch-icon.png', png(appleSvg, 180)),
  write('apple-touch-icon-precomposed.png', png(appleSvg, 180)),
  // Android and the web app manifest
  write('icon-192.png', png(iconSvg, 192)),
  write('icon-512.png', png(iconSvg, 512)),
  write('icon-maskable-192.png', png(maskableSvg, 192)),
  write('icon-maskable-512.png', png(maskableSvg, 512)),
  write('icon-monochrome-512.png', png(monochromeSvg(iconSvg, '#ffffff', 0.78), 512)),
  // Safari pinned tabs and the macOS Touch Bar
  write('safari-pinned-tab.svg', monochromeSvg(iconSvg, '#000000')),
  // Windows Start tiles
  write('mstile-70x70.png', png(tileSvg(iconSvg, 70, 70), 70)),
  write('mstile-150x150.png', png(tileSvg(iconSvg, 150, 150), 150)),
  write('mstile-310x150.png', png(tileSvg(iconSvg, 310, 150), 310, 150)),
  write('mstile-310x310.png', png(tileSvg(iconSvg, 310, 310), 310)),
  // Open Graph and Twitter/X cards
  write('og-image.png', socialCard()),
]);

console.log('Telescope icons and the social card were written to site/public');

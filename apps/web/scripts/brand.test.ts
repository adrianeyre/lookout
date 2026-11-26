// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../src/brand/maskable.ts';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)));
const svgText = (relative: string) => read(relative).toString('utf8');

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const fillOf = (svg: string, element: string) =>
  new RegExp(`<${element}[^>]*fill="(#[0-9a-f]{6})"`, 'i').exec(svg)?.[1];

describe('logo contrast (WCAG AA)', () => {
  // The backgrounds each variant is drawn on: the app's light and dark header surfaces.
  const cases = [
    { file: 'src/brand/logo.svg', background: '#ffffff' },
    { file: 'src/brand/logo-dark.svg', background: '#161b22' },
  ];

  for (const { file, background } of cases) {
    it(`${file} wordmark has at least 4.5:1 against ${background}`, () => {
      expect(contrast(fillOf(svgText(file), 'text')!, background)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${file} mark has at least 3:1 (non-text) between the tile and its white strokes`, () => {
      expect(contrast(fillOf(svgText(file), 'rect')!, '#ffffff')).toBeGreaterThanOrEqual(3);
    });
  }

  it('the icon tile has at least 4.5:1 against its starlight telescope', () => {
    expect(contrast(BRAND.tile, '#f8fafc')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('raster assets', () => {
  it('the maskable icon keeps everything but its background inside the safe zone', async () => {
    const { data, info } = await sharp(read('public/icon-maskable-512.png'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const size = info.width;
    const safeRadius = size * 0.4;
    const [br, bg, bb] = [1, 3, 5].map((i) => parseInt(BRAND.tile.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
    let outside = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= safeRadius) continue;
        const i = (y * size + x) * info.channels;
        const off =
          Math.abs(data[i]! - br) + Math.abs(data[i + 1]! - bg) + Math.abs(data[i + 2]! - bb);
        const opaque = info.channels < 4 || data[i + 3] === 255;
        if (off > 6 || !opaque) outside += 1;
      }
    }
    expect(info.width).toBe(512);
    expect(outside).toBe(0);
  });

  it.each([
    ['public/icon-192.png', 192, 192],
    ['public/icon-512.png', 512, 512],
    ['public/icon-maskable-512.png', 512, 512],
    ['public/apple-touch-icon.png', 180, 180],
    ['public/og-image.png', 1200, 630],
  ])('%s is %ix%i', async (file, width, height) => {
    const meta = await sharp(read(file)).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
  });

  it('favicon.ico holds 16, 32 and 48px images', () => {
    const ico = read('public/favicon.ico');
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16));
    expect(sizes).toEqual([16, 32, 48]);
  });

  it('the web manifest only names files that exist', () => {
    const manifest = JSON.parse(svgText('public/site.webmanifest')) as { icons: { src: string }[] };
    for (const icon of manifest.icons) expect(() => read(`public${icon.src}`)).not.toThrow();
  });
});

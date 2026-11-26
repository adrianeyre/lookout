/**
 * Renders the raster brand assets in apps/web/public from the SVG sources in src/brand.
 * Run with `pnpm brand:build` after changing a source SVG, and commit the output.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { maskableIconSvg } from '../src/brand/maskable.ts';

const brand = (name: string) => fileURLToPath(new URL(`../src/brand/${name}`, import.meta.url));
const pub = (name: string) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

const iconSvg = await readFile(brand('icon.svg'));
// Favicon sizes use a simplified mark that stays legible at 16px.
const smallIconSvg = await readFile(brand('icon-small.svg'));
const maskableSvg = Buffer.from(maskableIconSvg(iconSvg.toString('utf8')));

const png = (svg: Buffer, size: number) =>
  sharp(svg, { density: Math.max(72, (72 * size) / 64) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/** Packs PNG images into an .ico container (PNG-in-ICO, supported by every current browser). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // no palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const faviconSizes = [16, 32, 48];
const favicons = await Promise.all(
  faviconSizes.map(async (size) => ({ size, data: await png(smallIconSvg, size) })),
);

await Promise.all([
  writeFile(pub('favicon.ico'), ico(favicons)),
  copyFile(brand('icon.svg'), pub('icon.svg')),
  copyFile(brand('icon-small.svg'), pub('favicon.svg')),
  png(iconSvg, 192).then((data) => writeFile(pub('icon-192.png'), data)),
  png(iconSvg, 512).then((data) => writeFile(pub('icon-512.png'), data)),
  // iOS draws its own rounded corners and needs an opaque, full-bleed square.
  png(maskableSvg, 180).then((data) => writeFile(pub('apple-touch-icon.png'), data)),
  png(maskableSvg, 512).then((data) => writeFile(pub('icon-maskable-512.png'), data)),
  sharp(await readFile(brand('og-image.svg')))
    .resize(1200, 630)
    .png({ compressionLevel: 9 })
    .toBuffer()
    .then((data) => writeFile(pub('og-image.png'), data)),
]);

console.log('Brand assets written to apps/web/public');

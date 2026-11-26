/**
 * Builds the Project Website (PRD §12, ADR-0009) into site/dist with Vite.
 *
 *   pnpm site:build     build site/dist
 *   pnpm site:dev       serve the page while editing
 *   pnpm site:preview   serve the built site/dist
 *
 * The repository URL and the domain are named once, here (WEB-1). Screenshots come from
 * docs/images/ at build time (WEB-2), and are served as AVIF and WebP as well as PNG, so
 * nothing is stored twice in Git. The site's telescope icons and social card are in
 * site/public, rendered by `pnpm site:brand`. Fonts come from their npm packages, with their
 * OFL licences. The footer's Changelog is read from CHANGELOG.md.
 *
 * The hero demo (WEB-5) is React, in site/demos/, on the Stageshow kit vendored unmodified in
 * site/stageshow/. It reuses the dashboard's Sparkline and number formats from apps/web.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import sharp from 'sharp';
import { build, createServer, preview, type InlineConfig, type Plugin } from 'vite';
import { renderChangelog, type Changelog } from './changelog.ts';
import { FORMS, expandPictures, variant, type Form } from './pictures.ts';
import { DESCRIPTION, THEME, TITLE, faqHtml, iconHead, seoFiles, seoHead } from './seo.ts';

export const REPO_URL = 'https://github.com/adrianeyre/lookout';
export const DOMAIN = 'lookout.adrianeyre.co.uk';

export interface SiteConfig {
  repoUrl: string;
  domain: string;
  /** https://DOMAIN, with no trailing slash. */
  siteUrl: string;
  /** owner/name, for example "adrianeyre/lookout". */
  repoPath: string;
  /** The Image on GHCR, without a tag. */
  image: string;
  /** Where a file on main can be downloaded from, with no trailing slash. */
  rawUrl: string;
  /** Browsable files on main, with no trailing slash. */
  blobUrl: string;
}

export function siteConfig(repoUrl = REPO_URL, domain = DOMAIN): SiteConfig {
  const repoPath = new URL(repoUrl).pathname.replace(/^\/|\/$/g, '');
  return {
    repoUrl,
    domain,
    siteUrl: `https://${domain}`,
    repoPath,
    image: `ghcr.io/${repoPath.toLowerCase()}`,
    rawUrl: `https://raw.githubusercontent.com/${repoPath}/main`,
    blobUrl: `${repoUrl}/blob/main`,
  };
}

const siteDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(siteDir, '..');
export const OUT_DIR = path.join(siteDir, 'dist');

/** Fills every %NAME% placeholder in index.html; an unknown one fails the build. */
export function fillPlaceholders(html: string, values: Record<string, string>): string {
  return html.replace(/%([A-Z_]+)%/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`index.html uses unknown placeholder ${match}`);
    return value;
  });
}

/** The footer's Changelog, from CHANGELOG.md once semantic-release has written it. */
async function readChangelog(config: SiteConfig): Promise<Changelog> {
  const file = path.join(repoRoot, 'CHANGELOG.md');
  const markdown = existsSync(file) ? await readFile(file, 'utf8') : '';
  return renderChangelog(markdown, `${config.repoUrl}/releases`);
}

/** The version the footer shows: the root package.json's, which semantic-release bumps. */
async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? '0.0.0';
}

function placeholders(
  config: SiteConfig,
  changelog: Changelog,
  version: string,
): Record<string, string> {
  return {
    TITLE,
    DESCRIPTION,
    SEO_HEAD: seoHead(config),
    ICON_HEAD: iconHead(),
    THEME_LIGHT: THEME.light,
    THEME_DARK: THEME.dark,
    FAQ: faqHtml(),
    VERSION_LABEL: `Version: ${version}`,
    VERSION: `Version ${version}`,
    CHANGELOG: changelog.html,
    YEAR: String(new Date().getUTCFullYear()),
    REPO_URL: config.repoUrl,
    REPO_PATH: config.repoPath,
    SITE_URL: config.siteUrl,
    DOMAIN: config.domain,
    IMAGE: config.image,
    RAW_URL: config.rawUrl,
    BLOB_URL: config.blobUrl,
    ISSUES_URL: `${config.repoUrl}/issues`,
    RELEASES_URL: `${config.repoUrl}/releases`,
    ADR_URL: `${config.repoUrl}/tree/main/docs/architectural-decision-record`,
  };
}

/** The Content-Security-Policy meta tag in site/index.html and site/404.html. */
export const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>\n?/;

const htmlPlaceholders = (config: SiteConfig, changelog: Changelog, version: string): Plugin => ({
  name: 'lookout-site-placeholders',
  transformIndexHtml: {
    order: 'pre',
    handler: (html, context) => {
      const page = expandPictures(fillPlaceholders(html, placeholders(config, changelog, version)));
      // Vite's dev server injects inline scripts (React's refresh preamble); the built and
      // previewed site keeps the policy (#128).
      return context.server ? page.replace(CSP_META, '') : page;
    },
  },
});

const FONTS = [
  {
    from: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
    to: 'inter-latin-wght.woff2',
    licence: '@fontsource-variable/inter/LICENSE',
    licenceTo: 'Inter-OFL.txt',
  },
  {
    from: '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
    to: 'jetbrains-mono-latin-wght.woff2',
    licence: '@fontsource-variable/jetbrains-mono/LICENSE',
    licenceTo: 'JetBrainsMono-OFL.txt',
  },
];

/** Writes AVIF and WebP copies of a screenshot, at every width the page asks for. */
async function optimise(source: string, dir: string): Promise<void> {
  const base = path.basename(source, '.png');
  const form = (base.endsWith('-phone') ? 'phone' : 'desktop') satisfies Form;
  for (const width of FORMS[form].widths) {
    const name = variant(base, width, form);
    const resized = sharp(source).resize({ width });
    await Promise.all([
      resized
        .clone()
        .avif({ quality: 55, effort: 4 })
        .toFile(path.join(dir, `${name}.avif`)),
      resized
        .clone()
        .webp({ quality: 82, effort: 5 })
        .toFile(path.join(dir, `${name}.webp`)),
    ]);
  }
}

/** A file copied verbatim from the repository into the site. */
export interface VerbatimFile {
  /** Absolute path of the file in the repository (or node_modules). */
  source: string;
  /** Its path in the built site. */
  target: string;
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Every file the site copies from the repository as it is: the screenshots in docs/images,
 * site/public, the dashboard's logo and the fonts. The one list stagePublicDir copies from,
 * and the one the privacy test reads (site/privacy.test.ts): nothing from the pen-test PRD
 * or docs/pen-test/ may ever be in it.
 */
/**
 * Every image the Project Website publishes, each read at full size for real Host data
 * before it was added here (#129). A new file in docs/images or site/public fails the build
 * until someone has looked at it and listed it.
 */
export const PUBLISHED_IMAGES = {
  docsImages: [
    'container-detail-dark-desktop.png',
    'container-detail-dark-phone.png',
    'container-detail-light-desktop.png',
    'container-detail-light-phone.png',
    'container-logs-dark-desktop.png',
    'container-logs-dark-phone.png',
    'container-logs-light-desktop.png',
    'container-logs-light-phone.png',
    'containers-dark-desktop.png',
    'containers-dark-phone.png',
    'containers-light-desktop.png',
    'containers-light-phone.png',
    'host-dark-desktop.png',
    'host-dark-phone.png',
    'host-light-desktop.png',
    'host-light-phone.png',
    'largest-folders-dark-desktop.png',
    'largest-folders-dark-phone.png',
    'largest-folders-light-desktop.png',
    'largest-folders-light-phone.png',
    'settings-dark-desktop.png',
    'settings-dark-phone.png',
    'settings-light-desktop.png',
    'settings-light-phone.png',
    'websites-dark-desktop.png',
    'websites-dark-phone.png',
    'websites-light-desktop.png',
    'websites-light-phone.png',
  ],
  sitePublic: [
    'apple-touch-icon-precomposed.png',
    'apple-touch-icon.png',
    'favicon-16x16.png',
    'favicon-32x32.png',
    'favicon-48x48.png',
    'favicon-96x96.png',
    'favicon.ico',
    'favicon.svg',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-192.png',
    'icon-maskable-512.png',
    'icon-monochrome-512.png',
    'icon.svg',
    'mstile-150x150.png',
    'mstile-310x150.png',
    'mstile-310x310.png',
    'mstile-70x70.png',
    'og-image.png',
    'safari-pinned-tab.svg',
  ],
} as const;

/** Throws naming any file that is about to be published without being on the list. */
export function checkPublishedImages(docsImages: string[], sitePublic: string[]): void {
  const unlisted = [
    ...docsImages.filter((f) => !(PUBLISHED_IMAGES.docsImages as readonly string[]).includes(f)),
    ...sitePublic.filter((f) => !(PUBLISHED_IMAGES.sitePublic as readonly string[]).includes(f)),
  ];
  if (unlisted.length > 0) {
    throw new Error(
      `Not on PUBLISHED_IMAGES in site/build.ts: ${unlisted.join(', ')}. Read each at full size for real Host data first.`,
    );
  }
}

export async function verbatimFiles(): Promise<VerbatimFile[]> {
  const modules = path.join(repoRoot, 'node_modules');
  const images = (await readdir(path.join(repoRoot, 'docs/images'))).filter((f) =>
    f.endsWith('.png'),
  );
  if (images.length === 0) throw new Error('docs/images has no screenshots; run pnpm screenshots');
  const publicDir = path.join(siteDir, 'public');
  const publicFiles = await filesUnder(publicDir);
  checkPublishedImages(
    images,
    publicFiles.map((source) => path.relative(publicDir, source)),
  );
  return [
    ...images.map((image) => ({
      source: path.join(repoRoot, 'docs/images', image),
      target: path.join('images', image),
    })),
    // The telescope icons and social card (pnpm site:brand).
    ...publicFiles.map((source) => ({
      source,
      target: path.relative(publicDir, source),
    })),
    // The dashboard's own logo, which the hero demo shows in its header (WEB-5).
    ...['logo.svg', 'logo-dark.svg'].map((file) => ({
      source: path.join(repoRoot, 'apps/web/src/brand', file),
      target: path.join('brand', file),
    })),
    ...FONTS.flatMap((font) => [
      { source: path.join(modules, font.from), target: path.join('fonts', font.to) },
      { source: path.join(modules, font.licence), target: path.join('fonts', font.licenceTo) },
    ]),
  ];
}

/** Gathers everything copied verbatim into the site: images, brand, fonts, SEO files. */
async function stagePublicDir(config: SiteConfig): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lookout-site-'));
  await Promise.all(
    (await verbatimFiles()).map(async ({ source, target }) => {
      await mkdir(path.dirname(path.join(dir, target)), { recursive: true });
      await copyFile(source, path.join(dir, target));
      // Screenshots are also served as AVIF and WebP.
      if (target.startsWith(`images${path.sep}`)) await optimise(source, path.join(dir, 'images'));
    }),
  );

  const today = new Date().toISOString().slice(0, 10);
  for (const [name, text] of Object.entries(seoFiles(config, today))) {
    await writeFile(path.join(dir, name), text);
  }
  // GitHub Pages serves the custom domain named here.
  await writeFile(path.join(dir, 'CNAME'), `${config.domain}\n`);
  return dir;
}

function viteConfig(
  config: SiteConfig,
  changelog: Changelog,
  version: string,
  publicDir: string | false,
): InlineConfig {
  return {
    configFile: false,
    root: siteDir,
    publicDir,
    logLevel: 'warn',
    plugins: [react(), htmlPlaceholders(config, changelog, version)],
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      target: 'es2022',
      // Small assets inline; nothing is fetched from anywhere but this site.
      assetsInlineLimit: 0,
      rolldownOptions: {
        input: {
          index: path.join(siteDir, 'index.html'),
          notFound: path.join(siteDir, '404.html'),
        },
      },
    },
    // The demo imports the dashboard's Sparkline from apps/web, outside site/.
    server: { host: '127.0.0.1', port: 5180, strictPort: false, fs: { allow: [repoRoot] } },
    preview: { host: '127.0.0.1', port: 5181, strictPort: false },
  };
}

async function main(mode: string): Promise<void> {
  const config = siteConfig();
  const changelog = await readChangelog(config);
  const version = await readVersion();
  if (mode === 'preview') {
    const server = await preview(viteConfig(config, changelog, version, false));
    server.printUrls();
    return;
  }
  const publicDir = await stagePublicDir(config);
  if (mode === 'dev') {
    const server = await createServer(viteConfig(config, changelog, version, publicDir));
    await server.listen();
    server.printUrls();
    return;
  }
  try {
    await build(viteConfig(config, changelog, version, publicDir));
    console.log(`Built the Project Website into ${path.relative(process.cwd(), OUT_DIR)}`);
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main(process.argv[2] ?? 'build');
}

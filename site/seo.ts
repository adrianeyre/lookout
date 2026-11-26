/**
 * Discoverability for the Project Website (PRD WEB-8): the <head> tags that search engines and
 * link previews read (title, description, canonical, Open Graph, Twitter/X card, icons for every
 * platform), JSON-LD structured data, and the files beside index.html: sitemap.xml with its
 * images, robots.txt, site.webmanifest, browserconfig.xml, llms.txt and humans.txt.
 *
 * All of it comes from the SiteConfig, so nothing here names the repo or the domain itself.
 */
import type { SiteConfig } from './build.ts';
import { BRAND, OG_IMAGE_ALT } from './brand/og-card.ts';

export const NAME = 'Lookout';
/** At most 60 characters, so search results show all of it. */
export const TITLE = 'Lookout: self-hosted Docker and Linux server dashboard';
/** At most 160 characters, so search results and link previews show all of it. */
export const DESCRIPTION =
  'Free, open-source, self-hosted dashboard for one Linux server and its Docker containers: live metrics, Compose projects, logs, site uptime and TLS checks.';
const KEYWORDS = [
  'self-hosted dashboard',
  'Docker dashboard',
  'Docker monitoring',
  'Linux server monitoring',
  'Docker Compose',
  'container logs',
  'uptime monitoring',
  'TLS certificate expiry',
  'Traefik',
  'home server',
  'homelab',
  'Raspberry Pi',
  'Portainer alternative',
  'open source',
];
const AUTHOR = { name: 'Adrian Eyre', url: 'https://github.com/adrianeyre' };
export const LOCALE = 'en_GB';
export const LANGUAGE = 'en-GB';
/** The page and browser chrome colours, light then dark. */
export const THEME = { light: '#f8fafc', dark: '#020617' } as const;

export interface Faq {
  question: string;
  /** Plain text: it appears on the page and in the FAQPage structured data. */
  answer: string;
}

/** Shown in the FAQ section and as FAQPage structured data, so the two always match. */
export const FAQS: readonly Faq[] = [
  {
    question: 'Is Lookout free?',
    answer:
      'Yes. Lookout is free and open source under the MIT licence. There is no paid tier, no account and no telemetry.',
  },
  {
    question: 'Does Lookout run on a Raspberry Pi?',
    answer:
      'Yes. The Image is built for amd64 and arm64, so it runs on a Raspberry Pi 4 or 5 with a 64-bit OS, as well as on any x86 server or VPS with Docker Engine 24 or later.',
  },
  {
    question: 'Can I put Lookout on the public internet?',
    answer:
      'No. Lookout has root-equivalent access to the server through the Docker socket, so it must only be reached over your LAN or a VPN such as Tailscale or WireGuard. It listens on 127.0.0.1 until you choose a private address.',
  },
  {
    question: 'Can Lookout check the websites my server hosts?',
    answer:
      'Yes. The Websites page lists every site the server serves, found from Traefik router labels, a lookout.url label or LOOKOUT_SITES. Each is checked every minute for up, slow or down, its response time and its TLS certificate expiry, next to the container behind it.',
  },
  {
    question: 'Does Lookout send alerts?',
    answer:
      'No. Lookout is a dashboard: open it and see at a glance what needs attention. Flagged containers and sites are counted in the header on every page, but nothing is sent by email or chat.',
  },
  {
    question: 'Can Lookout monitor more than one server?',
    answer:
      'No. Lookout watches the one Linux server it runs on. To watch several servers, run one Lookout on each.',
  },
  {
    question: 'Does Lookout keep a history of metrics?',
    answer:
      'Only a live window, 15 minutes by default and up to 60, held in memory for the sparklines. It has no database, so nothing is written to disk.',
  },
  {
    question: 'How is Lookout different from Portainer, Netdata or Dozzle?',
    answer:
      'Lookout is one small dashboard for the server, its containers and its websites. Portainer manages stacks, registries and users; Netdata collects hundreds of metrics; Dozzle shows logs only. Lookout shows Host Metrics, containers grouped by Compose project, live logs and website checks, and can start, stop and restart containers, with nothing else to run or secure.',
  },
];

export const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

/** The screenshots that the sitemap lists and the structured data names, by file. */
export const SCREENSHOTS = [
  'host-light-desktop.png',
  'containers-light-desktop.png',
  'container-detail-light-desktop.png',
  'container-logs-light-desktop.png',
  'host-dark-phone.png',
  'containers-dark-phone.png',
];

/** The JSON-LD graph: the website, its author, the app, its source code, the page and FAQ. */
export function structuredData(config: SiteConfig): Record<string, unknown> {
  const url = `${config.siteUrl}/`;
  const id = (name: string) => `${url}#${name}`;
  const image = `${config.siteUrl}/og-image.png`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': id('website'),
        url,
        name: NAME,
        description: DESCRIPTION,
        inLanguage: LANGUAGE,
        publisher: { '@id': id('author') },
      },
      {
        '@type': 'Person',
        '@id': id('author'),
        name: AUTHOR.name,
        url: AUTHOR.url,
        sameAs: [AUTHOR.url],
      },
      {
        '@type': 'WebPage',
        '@id': id('webpage'),
        url,
        name: TITLE,
        description: DESCRIPTION,
        inLanguage: LANGUAGE,
        isPartOf: { '@id': id('website') },
        about: { '@id': id('software') },
        primaryImageOfPage: {
          '@type': 'ImageObject',
          url: image,
          width: 1200,
          height: 630,
          caption: OG_IMAGE_ALT,
        },
        author: { '@id': id('author') },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': id('software'),
        name: NAME,
        description: DESCRIPTION,
        url,
        image,
        screenshot: SCREENSHOTS.map((file) => `${config.siteUrl}/images/${file}`),
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'Server monitoring',
        operatingSystem: 'Linux (amd64, arm64)',
        softwareRequirements: 'Docker Engine 24 or later with Docker Compose',
        featureList: [
          'Live Host Metrics: CPU, memory, swap, disks, disk I/O and network',
          'Docker containers grouped by Compose project',
          'Flagged Containers: restarting, unhealthy or exited with an error',
          'Live container logs with search',
          'Websites: uptime, response time and TLS certificate expiry for every site the Host serves, found from Traefik labels',
          'Start, stop, restart and remove containers with guard-rails',
          'Light and dark themes; works on a phone',
          'The ten largest folders on the Host, with their share of each disk',
          'Optional filtering Docker socket proxy',
        ],
        license: 'https://opensource.org/license/mit',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' },
        downloadUrl: `https://${config.image}`,
        installUrl: `${url}#quick-start`,
        releaseNotes: `${config.repoUrl}/releases`,
        author: { '@id': id('author') },
        sameAs: [config.repoUrl],
      },
      {
        '@type': 'SoftwareSourceCode',
        '@id': id('source'),
        name: `${NAME} source code`,
        codeRepository: config.repoUrl,
        programmingLanguage: 'TypeScript',
        runtimePlatform: 'Docker',
        license: 'https://opensource.org/license/mit',
        targetProduct: { '@id': id('software') },
        author: { '@id': id('author') },
      },
      {
        '@type': 'FAQPage',
        '@id': id('faq'),
        isPartOf: { '@id': id('webpage') },
        mainEntity: FAQS.map((faq) => ({
          '@type': 'Question',
          name: faq.question,
          acceptedAnswer: { '@type': 'Answer', text: faq.answer },
        })),
      },
    ],
  };
}

/** Icons for every platform: browsers, Google Search, iOS, Android, Safari and Windows. */
export function iconHead(): string {
  const meta = (key: string, value: string) =>
    `<meta name="${key}" content="${escapeHtml(value)}" />`;
  return [
    `<link rel="icon" href="/favicon.ico" sizes="48x48" />`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="icon" href="/favicon-96x96.png" type="image/png" sizes="96x96" />`,
    `<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32" />`,
    `<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />`,
    `<link rel="mask-icon" href="/safari-pinned-tab.svg" color="${BRAND.night}" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
    meta('application-name', NAME),
    meta('apple-mobile-web-app-title', NAME),
    meta('apple-mobile-web-app-capable', 'yes'),
    meta('mobile-web-app-capable', 'yes'),
    meta('apple-mobile-web-app-status-bar-style', 'black-translucent'),
    meta('msapplication-TileColor', BRAND.night),
    meta('msapplication-TileImage', '/mstile-150x150.png'),
    meta('msapplication-config', '/browserconfig.xml'),
  ].join('\n    ');
}

/** Everything in <head> after the title: SEO, social cards, icons and the manifest. */
export function seoHead(config: SiteConfig): string {
  const url = `${config.siteUrl}/`;
  const image = `${config.siteUrl}/og-image.png`;
  const meta = (attribute: 'name' | 'property', key: string, value: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`;
  const robots = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';
  // "<" is escaped so the JSON can never close its <script> element.
  const jsonLd = JSON.stringify(structuredData(config)).replaceAll('<', '\\u003c');
  return [
    meta('name', 'description', DESCRIPTION),
    meta('name', 'keywords', KEYWORDS.join(', ')),
    meta('name', 'author', AUTHOR.name),
    meta('name', 'robots', robots),
    meta('name', 'googlebot', robots),
    meta('name', 'referrer', 'strict-origin-when-cross-origin'),
    meta('name', 'format-detection', 'telephone=no'),
    `<link rel="canonical" href="${url}" />`,
    `<link rel="alternate" hreflang="${LANGUAGE}" href="${url}" />`,
    `<link rel="alternate" hreflang="x-default" href="${url}" />`,
    `<link rel="sitemap" type="application/xml" href="/sitemap.xml" />`,
    `<link rel="author" href="/humans.txt" type="text/plain" />`,

    // Open Graph: Facebook, LinkedIn, WhatsApp, Slack, Discord, iMessage, Signal, Mastodon
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', NAME),
    meta('property', 'og:title', TITLE),
    meta('property', 'og:description', DESCRIPTION),
    meta('property', 'og:url', url),
    meta('property', 'og:locale', LOCALE),
    meta('property', 'og:image', image),
    meta('property', 'og:image:secure_url', image),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:alt', OG_IMAGE_ALT),
    // Twitter/X and Bluesky
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', TITLE),
    meta('name', 'twitter:description', DESCRIPTION),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', OG_IMAGE_ALT),

    iconHead(),

    `<script type="application/ld+json">${jsonLd}</script>`,
  ].join('\n    ');
}

/** The FAQ section's list, from FAQS. Each answer is a native disclosure, open without JS. */
export function faqHtml(): string {
  return FAQS.map(
    (faq) => `<details class="faq">
              <summary>${escapeHtml(faq.question)}</summary>
              <p>${escapeHtml(faq.answer)}</p>
            </details>`,
  ).join('\n            ');
}

const xml = (text: string) => escapeHtml(text).replaceAll("'", '&apos;');

/** The files the build writes beside index.html, by name. */
export function seoFiles(config: SiteConfig, lastModified: string): Record<string, string> {
  const url = `${config.siteUrl}/`;
  const doc = (path: string) => `${config.blobUrl}/${path}`;
  const imageUrls = [
    `${config.siteUrl}/og-image.png`,
    ...SCREENSHOTS.map((file) => `${config.siteUrl}/images/${file}`),
  ];
  const manifest = {
    id: '/',
    name: `${NAME}: self-hosted server dashboard`,
    short_name: NAME,
    description: DESCRIPTION,
    lang: LANGUAGE,
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: THEME.dark,
    theme_color: BRAND.night,
    categories: ['developer', 'utilities', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      {
        src: '/icon-monochrome-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'monochrome',
      },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    screenshots: [
      {
        src: '/images/host-dark-desktop.png',
        sizes: '1280x860',
        type: 'image/png',
        form_factor: 'wide',
        label: 'The Host page: live CPU, memory, disks and network',
      },
      {
        src: '/images/containers-dark-desktop.png',
        sizes: '1280x860',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Containers grouped by Compose project',
      },
      {
        src: '/images/host-dark-phone.png',
        sizes: '390x844',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'The Host page on a phone',
      },
      {
        src: '/images/containers-dark-phone.png',
        sizes: '390x844',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'Containers on a phone',
      },
    ],
  };
  return {
    'robots.txt': `User-agent: *\nAllow: /\nDisallow: /404.html\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`,
    'sitemap.xml': [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      '  <url>',
      `    <loc>${xml(url)}</loc>`,
      `    <lastmod>${lastModified}</lastmod>`,
      ...imageUrls.map(
        (image) => `    <image:image><image:loc>${xml(image)}</image:loc></image:image>`,
      ),
      '  </url>',
      '</urlset>',
      '',
    ].join('\n'),
    'site.webmanifest': `${JSON.stringify(manifest, null, 2)}\n`,
    'browserconfig.xml': [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<browserconfig>',
      '  <msapplication>',
      '    <tile>',
      '      <square70x70logo src="/mstile-70x70.png"/>',
      '      <square150x150logo src="/mstile-150x150.png"/>',
      '      <wide310x150logo src="/mstile-310x150.png"/>',
      '      <square310x310logo src="/mstile-310x310.png"/>',
      `      <TileColor>${BRAND.night}</TileColor>`,
      '    </tile>',
      '  </msapplication>',
      '</browserconfig>',
      '',
    ].join('\n'),
    'humans.txt': [
      '/* TEAM */',
      `Creator: ${AUTHOR.name}`,
      `GitHub: ${AUTHOR.url}`,
      '',
      '/* SITE */',
      `Last update: ${lastModified}`,
      'Language: English (British)',
      'Standards: HTML, CSS, WCAG 2.2 AA',
      'Components: Vite, TypeScript, sharp, Playwright, axe-core',
      'Fonts: Inter, JetBrains Mono (self-hosted, SIL OFL 1.1)',
      `Source: ${config.repoUrl}`,
      '',
    ].join('\n'),
    'llms.txt': [
      `# ${NAME}`,
      '',
      `> ${DESCRIPTION}`,
      '',
      'Lookout runs as one Docker Container on the Linux server it monitors (amd64 or arm64, Docker Engine 24 or later). It also checks the websites the server hosts (uptime and TLS expiry). It has root-equivalent access to Docker, so it must only be reachable over a LAN or VPN, never the public internet; an optional filtering socket proxy narrows that access. It has one password, no database and no telemetry.',
      '',
      '## Docs',
      '',
      `- [Website](${url}): what Lookout does, security, quick start, every setting and an FAQ`,
      `- [README](${doc('README.md')}): quick start, configuration, security, updating and development`,
      `- [Product requirements](${doc('docs/product-requirements-document/lookout.md')})`,
      `- [Architectural decision records](${config.repoUrl}/tree/main/docs/architectural-decision-record)`,
      `- [Glossary](${doc('GLOSSARY.md')}): Host, Host Metric, Container, Image, Compose Project, Flagged Container`,
      '',
      '## FAQ',
      '',
      ...FAQS.flatMap((faq) => [`- **${faq.question}** ${faq.answer}`]),
      '',
      '## Get it',
      '',
      `- [Source code](${config.repoUrl}) (MIT licence)`,
      `- [Releases](${config.repoUrl}/releases)`,
      `- Image: \`${config.image}\``,
      `- [Reference compose.yaml](${config.rawUrl}/compose.yaml)`,
      '',
    ].join('\n'),
  };
}

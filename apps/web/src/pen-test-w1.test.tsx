/**
 * Pen-test probes for scope issue W1 (#64), the browser boundary: what the SPA renders from a
 * Hostile Container, and the changelog HTML the footer inserts (H13). See
 * docs/pen-test/findings/W1.md. Open gaps are an `it.fails` stating the property that should
 * hold, beside a `today_…` test pinning what happens now; once fixed they became an `it` and a
 * `(regression)` test.
 */
import { act, render, screen } from '@testing-library/react';
import type { ContainerDetail } from '@lookout/shared';
import { renderChangelog } from '@lookout/shared';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContainerActions } from './components/ContainerActions.tsx';
import { LogViewer } from './components/LogViewer.tsx';
import { EventSourceContext, LiveClient, LiveContext } from './live.ts';
import { ContainerDetailView, EnvList } from './pages/ContainerDetailPage.tsx';
import { ContainerList } from './pages/ContainersPage.tsx';
import { FakeEventSource, summary } from './test-support.ts';

/** Values a Hostile Container writes into its labels, environment names, command and logs. */
const MARKUP = '<img src=x onerror="window.__pwned=1">';
const SCRIPT = '<script>window.__pwned=1</script>';
const ANSI = '\x1b[31mred\x1b[0m';
const OSC8 = '\x1b]8;;https://evil.example\x07link\x1b]8;;\x07';
/** U+202E RIGHT-TO-LEFT OVERRIDE: this is shown as "invoiceexe.txt". */
const BIDI = 'invoice\u202Etxt.exe';
const CONTROL = 'nul\x00bell\x07back\x08';
const HOSTILE = [MARKUP, SCRIPT, ANSI, OSC8, BIDI, CONTROL];

/** Elements and attributes that would mean a Container's text became markup. */
function injected(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const element of root.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (['img', 'script', 'iframe', 'object', 'embed'].includes(tag)) found.push(tag);
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) found.push(`${tag}[${attribute.name}]`);
    }
  }
  return found;
}

const hostile = summary({
  id: 'h0571le',
  name: 'hostile.container_-..x',
  image: MARKUP,
  composeProject: SCRIPT,
  labels: Object.fromEntries(HOSTILE.map((value, i) => [`lookout.probe.${i}${MARKUP}`, value])),
});

const detail: ContainerDetail = {
  ...hostile,
  imageId: `sha256:${'0'.repeat(64)}`,
  imageDigest: null,
  command: HOSTILE,
  entrypoint: [MARKUP],
  envNames: HOSTILE,
  masked: { command: [], entrypoint: [], mounts: [] },
  mounts: [{ type: 'bind', source: MARKUP, destination: BIDI, readOnly: true }],
  networks: [{ name: SCRIPT, ipAddress: MARKUP, ipv6Address: null, gateway: ANSI }],
  restartPolicy: MARKUP,
  restartCount: 0,
};

beforeEach(() => {
  FakeEventSource.instances = [];
});

function withStreams(children: ReactNode) {
  const create = (url: string) => new FakeEventSource(url) as unknown as EventSource;
  const client = new LiveClient({
    onExpired: () => undefined,
    createEventSource: create,
    checkSession: () => Promise.resolve(true),
  });
  return (
    <LiveContext.Provider value={client}>
      <EventSourceContext.Provider value={create}>{children}</EventSourceContext.Provider>
    </LiveContext.Provider>
  );
}

describe('W1: what the SPA renders from a Hostile Container', () => {
  it('renders the Container list as text, never as markup', () => {
    const { container } = render(
      <ContainerList
        snapshot={{ available: true, containers: [hostile] }}
        stats={new Map()}
        now={Date.now()}
      />,
    );
    expect(injected(container)).toEqual([]);
    expect(container.textContent).toContain(MARKUP);
    expect(container.textContent).toContain(SCRIPT);
  });

  it('renders the detail (image, command, mounts, networks, labels, env names) as text', () => {
    const { container } = render(
      withStreams(<ContainerDetailView detail={detail} live={hostile} />),
    );
    expect(injected(container)).toEqual([]);
    const text = container.textContent;
    for (const value of HOSTILE) expect(text).toContain(value);
  });

  it('renders environment names as text, values masked', () => {
    const { container } = render(<EnvList containerId="h0571le" names={HOSTILE} />);
    expect(injected(container)).toEqual([]);
    expect(screen.getAllByTestId('env-value').map((el) => el.textContent)).toEqual(
      HOSTILE.map(() => '••••••••'),
    );
  });

  it('renders log lines as text, ANSI and OSC-8 escapes as inert characters', async () => {
    const { container } = render(withStreams(<LogViewer containerId="h0571le" />));
    const source = FakeEventSource.instances.find((s) => s.url.includes('/logs'))!;
    act(() => {
      source.emit('reset', { tail: 500 });
      source.emit(
        'lines',
        HOSTILE.map((text, i) => ({ stream: i % 2 ? 'stderr' : 'stdout', timestamp: 0, text })),
      );
    });
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(injected(container)).toEqual([]);
    const lines = screen.getAllByTestId('log-line').map((el) => el.textContent);
    // ANSI and OSC-8 are not interpreted: no colour, and no link to evil.example.
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining(ANSI)]));
    expect(container.querySelector('a[href*="evil.example"]')).toBeNull();
  });

  it('puts a hostile name in the remove dialog as text', () => {
    const { container } = render(
      <ContainerActions
        container={{ ...hostile, name: MARKUP, state: 'exited' }}
        onRemoved={() => undefined}
      />,
    );
    expect(injected(container)).toEqual([]);
  });

  // A bidirectional override in a label, an environment name, a mount or a log line reorders
  // what follows it on screen, so what the owner reads is not what the Container says.
  it('isolates bidirectional text from a Container, so U+202E cannot reorder it', () => {
    const { container } = render(
      withStreams(<ContainerDetailView detail={detail} live={hostile} />),
    );
    const isolated = [...container.querySelectorAll('bdi, [dir="auto"], [dir="ltr"]')].some((el) =>
      el.textContent.includes(BIDI),
    );
    expect(isolated || !container.textContent.includes('\u202E')).toBe(true);
  });

  it('isolates every piece of Container text that carries U+202E, in the detail, list and logs (regression)', async () => {
    /** Every text node holding U+202E sits inside a <bdi>, so it reorders nothing outside. */
    const unisolated = (root: HTMLElement) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const found: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes('\u202E') && !node.parentElement?.closest('bdi')) {
          found.push(node.textContent);
        }
      }
      return found;
    };
    const { container } = render(
      withStreams(<ContainerDetailView detail={detail} live={hostile} />),
    );
    expect(container.textContent).toContain(BIDI);
    expect(unisolated(container)).toEqual([]);

    const source = FakeEventSource.instances.find((s) => s.url.includes('/logs'))!;
    act(() => {
      source.emit('reset', { tail: 500 });
      source.emit('lines', [{ stream: 'stdout', timestamp: 0, text: BIDI }]);
    });
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.getAllByTestId('log-line').map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining(BIDI)]),
    );
    expect(unisolated(container)).toEqual([]);

    const list = render(
      <ContainerList
        snapshot={{
          available: true,
          containers: [{ ...hostile, name: BIDI, image: BIDI, composeProject: BIDI }],
        }}
        stats={new Map()}
        now={Date.now()}
      />,
    );
    expect(unisolated(list.container)).toEqual([]);
  });
});

/** Every tag and attribute the changelog HTML may contain. */
const ALLOWED_TAGS = new Set(['h3', 'h4', 'ul', 'li', 'p', 'a', 'strong', 'code']);
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
};

/** Pull-request titles as semantic-release writes them into CHANGELOG.md. */
const TITLES = [
  `feat: it's "quoted" <b>bold</b> & more`,
  'fix: [click](javascript:alert(1))',
  'fix: [click](JaVaScRiPt:alert(1))',
  'fix: [x](data:text/html,<script>alert(1)</script>)',
  'fix: [x](//evil.example)',
  'fix: [a [b](https://x.example)](https://y.example)',
  'fix: [x](https://a.example" onmouseover="alert(1))',
  "fix: [x](https://a.example'onmouseover='alert(1))",
  'fix: [x](https://a.example/`onclick=alert(1)`)',
  'fix: [x](https://a.example/&quot;onmouseover=alert(1))',
  'fix: `<img src=x onerror=alert(1)>` and ``double`` ticks',
  'fix: [`x" onclick="y`](https://a.example)',
  'fix: **[x](https://a.example)** and [**y**](https://b.example)',
  'fix: [<script>](https://a.example)',
  'fix: [x](https://a.example)<svg onload=alert(1)>',
];

function changelogDom(): HTMLElement {
  const markdown = [
    '# Changelog',
    '',
    '## [1.2.0](https://github.com/o/r/compare/v1.1.0...v1.2.0) (2026-11-25)',
    '',
    '### Features',
    '',
    ...TITLES.map((title) => `* ${title} ([#1](https://github.com/o/r/issues/1))`),
  ].join('\n');
  const root = document.createElement('div');
  // As the footer inserts it (components/footer/content.tsx).
  root.innerHTML = renderChangelog(markdown, 'https://github.com/o/r/releases').html;
  return root;
}

describe('W1: the changelog the footer inserts as HTML (H13)', () => {
  it('produces only headings, lists, paragraphs, links, bold and code', () => {
    const root = changelogDom();
    for (const element of root.querySelectorAll('*')) {
      const tag = element.tagName.toLowerCase();
      expect(ALLOWED_TAGS, tag).toContain(tag);
      for (const attribute of element.attributes) {
        expect(ALLOWED_ATTRIBUTES[tag], `${tag}[${attribute.name}]`).toContain(attribute.name);
      }
    }
  });

  it('keeps only absolute http(s) links, each opening safely in a new tab', () => {
    const links = [...changelogDom().querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^https?:\/\//);
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('target')).toBe('_blank');
    }
  });

  it('keeps every title character as text: quotes and markup never break out', () => {
    const text = changelogDom().textContent;
    expect(text).toContain(`it's "quoted" <b>bold</b> & more`);
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(text).toContain('<svg onload=alert(1)>');
  });

  // Documented decision: a title may still link to any https site with any text.
  it('today_lets a pull-request title link to any https site', () => {
    const hrefs = [...changelogDom().querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://x.example');
  });
});

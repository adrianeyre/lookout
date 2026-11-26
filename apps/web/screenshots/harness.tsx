/**
 * Renders Lookout's real pages and components with the made-up data in fixtures.ts, for
 * screenshots (PRD WEB-6). There is no server behind it: the live stream, the page-scoped
 * streams and the API are all answered here, so it cannot show a real Host or Container.
 *
 * Open /screenshots/index.html?page=host|containers|detail|websites|site|settings under Vite (`pnpm screenshots`
 * does this).
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout } from '../src/components/Layout.tsx';
import { EventSourceContext, LiveClient, LiveContext } from '../src/live.ts';
import { ContainerDetailPage } from '../src/pages/ContainerDetailPage.tsx';
import { ContainersPage } from '../src/pages/ContainersPage.tsx';
import { HostPage } from '../src/pages/HostPage.tsx';
import { SettingsPage } from '../src/pages/SettingsPage.tsx';
import { SiteStatsPage } from '../src/pages/SiteStatsPage.tsx';
import { WebsitesPage } from '../src/pages/WebsitesPage.tsx';
import '../src/styles.css';
import {
  DETAIL,
  DETAIL_ID,
  FOLDERS,
  HOST,
  LOGS,
  SETTINGS,
  SITES,
  SNAPSHOT,
  STATS,
  STATS_OVERVIEW,
  STATS_SITE_ID,
  VOLUMES,
  WINDOW,
  siteStats,
} from './fixtures.ts';

/** An EventSource that replays fixture events for its URL, then stays open. */
class FixtureEventSource extends EventTarget {
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      for (const [name, data] of eventsFor(url)) {
        this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
      }
    }, 0);
  }

  close() {
    this.readyState = 2;
  }
}

function eventsFor(url: string): [string, unknown][] {
  if (url === '/api/stream') {
    return [
      ['settings', SETTINGS],
      ['window', WINDOW],
      ['host', HOST],
      ['containers', SNAPSHOT],
      ['sites', SITES],
      ['folders', FOLDERS],
    ];
  }
  if (url === '/api/containers/stats') return [['stats', STATS]];
  if (url.startsWith(`/api/containers/${DETAIL_ID}/logs`)) {
    return [
      ['reset', { tail: 500 }],
      ['lines', LOGS],
    ];
  }
  return [];
}

const createEventSource = (url: string) => new FixtureEventSource(url) as unknown as EventSource;

// The API calls the pages make, answered from fixtures; everything else is refused, so
// nothing leaves the page.
window.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url === `/api/containers/${DETAIL_ID}`) return json(DETAIL);
  if (url === '/api/stats') return json(STATS_OVERVIEW);
  if (url === '/api/volumes') return json(VOLUMES);
  const stats = /^\/api\/stats\/sites\/([^?]+)\?range=(24h|7d|30d|90d)$/.exec(url);
  if (stats && stats[1] === STATS_SITE_ID) return json(siteStats(stats[2] as '24h'));
  return new Response(JSON.stringify({ error: 'Not available in the screenshot harness' }), {
    status: 404,
  });
};

type HarnessPage = 'host' | 'containers' | 'detail' | 'websites' | 'site' | 'settings';
const PAGES: readonly HarnessPage[] = [
  'host',
  'containers',
  'detail',
  'websites',
  'site',
  'settings',
];

function Harness({ page }: { page: HarnessPage }) {
  const [client] = useState(() => {
    const live = new LiveClient({ onExpired: () => undefined, createEventSource });
    live.connect();
    return live;
  });
  return (
    <LiveContext.Provider value={client}>
      <EventSourceContext.Provider value={createEventSource}>
        <Layout page={page === 'detail' ? 'container' : page}>
          {page === 'host' && <HostPage />}
          {page === 'containers' && <ContainersPage />}
          {page === 'detail' && <ContainerDetailPage id={DETAIL_ID} />}
          {page === 'websites' && <WebsitesPage />}
          {page === 'site' && <SiteStatsPage id={STATS_SITE_ID} />}
          {page === 'settings' && <SettingsPage />}
        </Layout>
      </EventSourceContext.Provider>
    </LiveContext.Provider>
  );
}

const requested = new URLSearchParams(window.location.search).get('page');
const page: HarnessPage = PAGES.find((name) => name === requested) ?? 'host';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness page={page} />
  </StrictMode>,
);

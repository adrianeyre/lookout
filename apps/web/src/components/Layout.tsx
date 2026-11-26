import { useMemo, useState, type ReactNode } from 'react';
import { logout } from '../api.ts';
import logoDark from '../brand/logo-dark.svg';
import logo from '../brand/logo.svg';
import { useConnectionStatus } from '../live.ts';
import { useResolvedMode } from '../appearance.ts';
import { navigate, PATHS, type PageName } from '../router.ts';
import { Footer } from './footer/Footer.tsx';
import { HeaderSummary } from './HeaderSummary.tsx';
import { Menu, type MenuItem } from './Menu.tsx';
import { WidgetsMenuContext } from '../grid/widgets-menu.ts';
import { Link } from './Link.tsx';

const NAV: { section: 'host' | 'containers' | 'websites'; label: string }[] = [
  { section: 'host', label: 'Host' },
  { section: 'containers', label: 'Containers' },
  { section: 'websites', label: 'Websites' },
];

export function ConnectionBanner() {
  const status = useConnectionStatus();
  return (
    <div className="connection" role="status" aria-live="polite">
      {status === 'reconnecting' && (
        <p className="connection__lost" data-testid="connection-lost">
          Connection lost — reconnecting…
        </p>
      )}
    </div>
  );
}

export function Layout({ page, children }: { page: PageName; children: ReactNode }) {
  const resolved = useResolvedMode();
  const [widgetItems, setWidgetItems] = useState<readonly MenuItem[] | null>(null);
  const widgetsMenu = useMemo(
    () => ({ items: widgetItems, setItems: setWidgetItems }),
    [widgetItems],
  );
  // A Container's detail view belongs to the Containers section.
  const section = page === 'container' ? 'containers' : page;
  return (
    <WidgetsMenuContext.Provider value={widgetsMenu}>
      <div className="shell">
        <header className="header">
          <div className="header__inner">
            <Link className="header__brand" href={PATHS.host}>
              <img
                src={resolved === 'dark' ? logoDark : logo}
                alt="Lookout"
                width="116"
                height="32"
              />
            </Link>
            <nav className="header__nav" aria-label="Main">
              {NAV.map((item) => (
                <Link
                  key={item.section}
                  href={PATHS[item.section]}
                  current={item.section === section}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="header__summary" data-testid="header-summary">
              <HeaderSummary />
            </div>
            <Menu
              label="Menu"
              items={[
                ...(widgetItems
                  ? [
                      {
                        kind: 'submenu' as const,
                        id: 'widgets',
                        label: 'Widgets',
                        items: widgetItems,
                      },
                    ]
                  : []),
                {
                  kind: 'action',
                  id: 'settings',
                  label: 'Settings',
                  onSelect: () => navigate(PATHS.settings),
                },
                { kind: 'separator', id: 'end' },
                { kind: 'action', id: 'logout', label: 'Log out', onSelect: () => void logout() },
              ]}
            />
          </div>
        </header>
        <ConnectionBanner />
        <main className="main" id="main">
          {children}
        </main>
        <Footer />
      </div>
    </WidgetsMenuContext.Provider>
  );
}

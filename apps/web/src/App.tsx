import { useEffect, useState } from 'react';
import { Layout } from './components/Layout.tsx';
import { LiveClient, LiveContext } from './live.ts';
import { ContainerDetailPage } from './pages/ContainerDetailPage.tsx';
import { ContainersPage } from './pages/ContainersPage.tsx';
import { HostPage } from './pages/HostPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { WebsitesPage } from './pages/WebsitesPage.tsx';
import { routeFor, usePathname, type Route } from './router.ts';

type DashboardRoute = Exclude<Route, { name: 'login' }>;

function Page({ route }: { route: DashboardRoute }) {
  switch (route.name) {
    case 'host':
      return <HostPage />;
    case 'containers':
      return <ContainersPage />;
    case 'container':
      return <ContainerDetailPage key={route.id} id={route.id} />;
    case 'websites':
      return <WebsitesPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

function Dashboard({ route }: { route: DashboardRoute }) {
  const [client] = useState(
    () => new LiveClient({ onExpired: () => window.location.assign('/login') }),
  );
  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);

  return (
    <LiveContext.Provider value={client}>
      <Layout page={route.name}>
        <Page route={route} />
      </Layout>
    </LiveContext.Provider>
  );
}

export function App() {
  const route = routeFor(usePathname());
  if (route?.name === 'login') {
    return <LoginPage onSuccess={() => window.location.assign('/')} />;
  }
  if (route === null) {
    return (
      <main className="main">
        <h1 className="page-title">Page not found</h1>
        <a href="/">Go to the Host page</a>
      </main>
    );
  }
  return <Dashboard route={route} />;
}

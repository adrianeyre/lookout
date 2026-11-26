import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'host' }
  | { name: 'containers' }
  | { name: 'container'; id: string }
  | { name: 'websites' }
  | { name: 'settings' }
  | { name: 'login' };

export type PageName = Route['name'];

export const PATHS = {
  host: '/',
  containers: '/containers',
  websites: '/websites',
  settings: '/settings',
  login: '/login',
} as const;

/** The detail view of one Container (FR-20), which has its own URL. */
export function containerPath(id: string): string {
  return `/containers/${encodeURIComponent(id)}`;
}

export function routeFor(pathname: string): Route | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'host' };
  if (path === '/containers') return { name: 'containers' };
  if (path === '/websites') return { name: 'websites' };
  if (path === '/settings') return { name: 'settings' };
  if (path === '/login') return { name: 'login' };
  const container = /^\/containers\/([^/]+)$/.exec(path);
  if (container) {
    try {
      return { name: 'container', id: decodeURIComponent(container[1]!) };
    } catch {
      return null;
    }
  }
  return null;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('popstate', notify);
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** Client-side navigation between the SPA's pages, without a reload. */
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  window.scrollTo(0, 0);
  notify();
}
